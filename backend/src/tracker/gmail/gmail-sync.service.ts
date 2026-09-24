/**
 * The tracker's Gmail sync: connect a mailbox read-only, read new recruiting mail, and
 * turn what it says into suggestions the candidate accepts or dismisses.
 *
 * SUGGESTIONS, NEVER WRITES. TrackerService's promise is that every row is something the
 * candidate put there. Sync therefore writes only to `email_suggestions`; the Apply
 * button is the one path from an email to a tracked row, and it goes through
 * TrackerService like any other edit - same caps, same validation, same log line.
 *
 * WHAT IS READ, AND WHAT IS KEPT. Gmail's own search does the first cut (recruiting
 * words, not promotions or social), so most mail never leaves Google. What does is read
 * once, classified, and dropped: only a suggestion's subject, sender and a one-sentence
 * quote are stored, and a message that is not about an application leaves no trace.
 *
 * ONE PASS PER MAILBOX, FORWARD ONLY. `lastSyncedAt` is the high-water mark and each
 * pass reads mail after it. The first pass looks back FIRST_SYNC_DAYS. A pass is capped
 * at MAX_MESSAGES_PER_SYNC and works oldest first, so a backlog is worked through over a
 * few passes instead of the newest mail being read and the rest skipped for good.
 */
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailSuggestionStatus, TrackedStage } from '@prisma/client';
import { Env } from '../../config/env.schema';
import { LLM_PROVIDER, type LlmProvider } from '../../llm/llm.types';
import { readJobEmailTask } from '../../llm/tasks/read-job-email.task';
import { PrismaService } from '../../prisma/prisma.service';
import { TrackerService, type TrackerView } from '../tracker.service';
import {
  GMAIL_SCOPE,
  GoogleClient,
  GrantRevokedError,
  type GmailMessage,
} from './google.client';
import { SecretBox } from './secret-box';

const FIRST_SYNC_DAYS = 30;
const MAX_MESSAGES_PER_SYNC = 40;
/** Ids fetched from the search per pass, of which MAX_MESSAGES_PER_SYNC are read. */
const MAX_IDS_PER_SEARCH = 300;
const BODY_CAP = 4_000;
const STATE_TTL_MS = 10 * 60 * 1000;
/** Between hand-started passes. The hourly schedule does not wait on this. */
const MANUAL_SYNC_COOLDOWN_MS = 60 * 1000;

/**
 * Gmail search syntax. `{...}` is OR. Deliberately broad on the recruiting words and
 * narrow on the categories: a false positive here costs one fast-tier read, a false
 * negative is an interview invitation the tracker never hears about.
 */
const SEARCH_TERMS =
  '-from:me -category:promotions -category:social ' +
  '{application applying applied interview interviews candidacy candidature ' +
  'assessment "offer letter" unfortunately "next steps" recruiter recruiting hiring ' +
  '"moving forward" shortlisted}';

/** Forward order. REJECTED and GHOSTED are outside it - see `worthSuggesting`. */
const STAGE_RANK: Partial<Record<TrackedStage, number>> = {
  SAVED: 0,
  APPLIED: 1,
  SCREENING: 2,
  INTERVIEWING: 3,
  OFFER: 4,
};

export interface EmailSuggestionRow {
  id: string;
  receivedAt: string;
  fromAddress: string;
  subject: string;
  company: string;
  role: string | null;
  proposedStage: TrackedStage;
  /** The row it would change, or null when accepting it adds a new application. */
  application: { id: string; company: string; stage: TrackedStage } | null;
  evidence: string;
}

export interface GmailStatus {
  /** False when the server has no Google credentials - the screen explains, not offers. */
  configured: boolean;
  connected: boolean;
  email: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  suggestions: EmailSuggestionRow[];
}

@Injectable()
export class GmailSyncService {
  private readonly logger = new Logger(GmailSyncService.name);
  private readonly running = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tracker: TrackerService,
    private readonly config: ConfigService<Env, true>,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
  ) {}

  // --- configuration ------------------------------------------------------------

  get configured(): boolean {
    return this.parts() !== null;
  }

  private parts(): { google: GoogleClient; box: SecretBox } | null {
    const clientId = this.config.get('GOOGLE_CLIENT_ID', { infer: true });
    const clientSecret = this.config.get('GOOGLE_CLIENT_SECRET', {
      infer: true,
    });
    const redirectUri = this.config.get('GOOGLE_REDIRECT_URI', { infer: true });
    const key = this.config.get('TOKEN_ENCRYPTION_KEY', { infer: true });
    if (!clientId || !clientSecret || !redirectUri || !key) return null;
    return {
      google: new GoogleClient({ clientId, clientSecret, redirectUri }),
      box: new SecretBox(key),
    };
  }

  private require(): { google: GoogleClient; box: SecretBox } {
    const parts = this.parts();
    if (!parts) {
      throw new BadRequestException(
        'Gmail sync is not set up on this server. An administrator needs to set ' +
          'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI and ' +
          'TOKEN_ENCRYPTION_KEY - see the README.',
      );
    }
    return parts;
  }

  // --- status -------------------------------------------------------------------

  async status(userId: string): Promise<GmailStatus> {
    const [connection, suggestions] = await Promise.all([
      this.prisma.gmailConnection.findUnique({ where: { userId } }),
      this.prisma.emailSuggestion.findMany({
        where: { userId, status: EmailSuggestionStatus.PENDING },
        orderBy: { receivedAt: 'desc' },
        include: {
          trackedApplication: {
            select: { id: true, company: true, stage: true },
          },
        },
      }),
    ]);

    return {
      configured: this.configured,
      connected: connection !== null,
      email: connection?.email ?? null,
      lastSyncedAt: connection?.lastSyncedAt?.toISOString() ?? null,
      lastError: connection?.lastError ?? null,
      suggestions: suggestions.map((s) => ({
        id: s.id,
        receivedAt: s.receivedAt.toISOString(),
        fromAddress: s.fromAddress,
        subject: s.subject,
        company: s.company,
        role: s.role,
        proposedStage: s.proposedStage,
        application: s.trackedApplication,
        evidence: s.evidence,
      })),
    };
  }

  // --- connecting -----------------------------------------------------------------

  connectUrl(userId: string): { url: string } {
    const { google, box } = this.require();
    return { url: google.authorizeUrl(box.signState(userId, STATE_TTL_MS)) };
  }

  /**
   * Google's redirect lands here. Returns where to send the browser next.
   *
   * Every failure becomes a redirect with a reason rather than an error page, because
   * the person reading it is mid-way through a consent flow on another site and the
   * only useful thing to show them is the tracker, saying what happened.
   */
  async finishConnect(query: {
    code?: string;
    state?: string;
    error?: string;
  }): Promise<string> {
    const back = (outcome: string): string =>
      `${this.config.get('APP_URL', { infer: true })}/app/tracker?gmail=${outcome}`;

    const parts = this.parts();
    if (!parts) return back('not-configured');
    if (query.error) return back('denied');

    const userId = query.state ? parts.box.verifyState(query.state) : null;
    if (!userId || !query.code) return back('expired');

    try {
      const grant = await parts.google.exchangeCode(query.code);
      // Google lets the person untick the scope on the consent screen and still
      // returns a code. Without the scope every sync would 403, so refuse now.
      if (!grant.scope.split(' ').includes(GMAIL_SCOPE)) {
        await parts.google.revoke(grant.refreshToken);
        return back('scope');
      }
      const email = await parts.google.mailboxAddress(grant.accessToken);
      const sealed = parts.box.seal(grant.refreshToken);

      await this.prisma.gmailConnection.upsert({
        where: { userId },
        create: { userId, email, refreshTokenEnc: sealed },
        update: {
          email,
          refreshTokenEnc: sealed,
          lastError: null,
          connectedAt: new Date(),
        },
      });
      this.logger.log(`${userId} connected Gmail (${email})`);

      // The first pass now, so the screen they land on already has something to show.
      // Not awaited into the redirect: a 40-message read is tens of seconds.
      void this.sync(userId).catch(() => undefined);
      return back('connected');
    } catch (err) {
      this.logger.warn(
        `gmail connect for ${userId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return back('failed');
    }
  }

  async disconnect(userId: string): Promise<GmailStatus> {
    const connection = await this.prisma.gmailConnection.findUnique({
      where: { userId },
    });
    if (connection) {
      const parts = this.parts();
      if (parts) {
        try {
          await parts.google.revoke(parts.box.open(connection.refreshTokenEnc));
        } catch {
          // An unreadable token cannot be revoked by us; deleting it is still right.
        }
      }
      await this.prisma.$transaction([
        this.prisma.gmailConnection.delete({ where: { userId } }),
        this.prisma.emailSuggestion.deleteMany({
          where: { userId, status: EmailSuggestionStatus.PENDING },
        }),
      ]);
      this.logger.log(`${userId} disconnected Gmail`);
    }
    return this.status(userId);
  }

  // --- syncing --------------------------------------------------------------------

  /** The "Sync now" button. Cooled down so it cannot be used to burn LLM calls. */
  async syncNow(userId: string): Promise<GmailStatus> {
    this.require();
    const connection = await this.prisma.gmailConnection.findUnique({
      where: { userId },
      select: { lastSyncedAt: true },
    });
    if (!connection) throw new BadRequestException('Gmail is not connected');
    const last = connection.lastSyncedAt?.getTime() ?? 0;
    if (Date.now() - last < MANUAL_SYNC_COOLDOWN_MS) {
      throw new BadRequestException(
        'synced less than a minute ago - give it a moment',
      );
    }
    await this.sync(userId);
    return this.status(userId);
  }

  /** Every connected mailbox, one at a time. For the schedule. */
  async syncAll(): Promise<void> {
    if (!this.configured) return;
    const users = await this.prisma.gmailConnection.findMany({
      select: { userId: true },
    });
    for (const { userId } of users) {
      await this.sync(userId).catch(() => undefined);
    }
  }

  /** One pass for one mailbox. Never throws on a Gmail problem - it records it. */
  async sync(userId: string): Promise<void> {
    if (this.running.has(userId)) return;
    this.running.add(userId);
    try {
      await this.syncOnce(userId);
    } finally {
      this.running.delete(userId);
    }
  }

  private async syncOnce(userId: string): Promise<void> {
    const { google, box } = this.require();
    const connection = await this.prisma.gmailConnection.findUnique({
      where: { userId },
    });
    if (!connection) return;

    const startedAt = new Date();
    const since =
      connection.lastSyncedAt ??
      new Date(Date.now() - FIRST_SYNC_DAYS * 24 * 3600 * 1000);

    try {
      const token = await google.accessToken(
        box.open(connection.refreshTokenEnc),
      );
      const query = `after:${Math.floor(since.getTime() / 1000)} ${SEARCH_TERMS}`;
      // Newest first from Gmail; reversed so a capped pass takes the OLDEST and the
      // high-water mark can advance to exactly where it stopped.
      const ids = (await google.search(token, query, MAX_IDS_PER_SEARCH))
        .reverse()
        .slice(0, MAX_MESSAGES_PER_SYNC);
      const capped = ids.length === MAX_MESSAGES_PER_SYNC;

      const known = new Set(
        (
          await this.prisma.emailSuggestion.findMany({
            where: { userId, gmailMessageId: { in: ids } },
            select: { gmailMessageId: true },
          })
        ).map((s) => s.gmailMessageId),
      );

      const applications = await this.prisma.trackedApplication.findMany({
        where: { userId },
        select: { id: true, company: true, role: true, stage: true },
      });

      let created = 0;
      let lastReceived: Date | null = null;
      for (const id of ids) {
        const message = await google.message(token, id, BODY_CAP);
        lastReceived = message.receivedAt;
        if (known.has(id)) continue;
        if (await this.consider(userId, message, applications)) created++;
      }

      await this.prisma.gmailConnection.update({
        where: { userId },
        data: {
          // When capped, resume from the last message read rather than from now, or
          // everything between the two would never be looked at.
          lastSyncedAt: capped && lastReceived ? lastReceived : startedAt,
          lastError: null,
        },
      });
      this.logger.log(
        `${userId}: gmail sync read ${ids.length} message(s), ${created} new suggestion(s)`,
      );
    } catch (err) {
      const revoked = err instanceof GrantRevokedError;
      const message = revoked
        ? 'Google access was revoked or has expired - disconnect and connect again.'
        : `The last sync failed: ${err instanceof Error ? err.message : String(err)}`;
      await this.prisma.gmailConnection
        .update({
          where: { userId },
          data: { lastError: message.slice(0, 500) },
        })
        .catch(() => undefined);
      this.logger.warn(`${userId}: gmail sync failed - ${message}`);
    }
  }

  /** Classifies one message and stores a suggestion if it earns one. */
  private async consider(
    userId: string,
    message: GmailMessage,
    applications: {
      id: string;
      company: string;
      role: string | null;
      stage: TrackedStage;
    }[],
  ): Promise<boolean> {
    const { value: data } = await this.llm.complete(
      readJobEmailTask,
      {
        applications: applications.map(({ id, company, role }) => ({
          id,
          company,
          role,
        })),
      },
      {
        from: message.from,
        subject: message.subject,
        receivedAt: message.receivedAt.toISOString(),
        body: message.body,
      },
    );
    if (!data.aboutAnApplication || !data.stage || !data.company) return false;

    // The model's id is taken only if it is one of THIS user's rows. Failing that, an
    // exact company-name match to a single row, which catches the common case of the
    // model being unsure between two roles at one employer it was not asked to pick.
    const byId = applications.find((a) => a.id === data.matchId);
    const sameCompany = applications.filter(
      (a) => normalize(a.company) === normalize(data.company!),
    );
    const match =
      byId ?? (sameCompany.length === 1 ? sameCompany[0] : undefined);

    if (match && !worthSuggesting(match.stage, data.stage)) return false;
    // A new-application suggestion only makes sense for mail that starts a process.
    // "Unfortunately..." about a company that is not on the list has nothing to update.
    if (!match && data.stage === 'REJECTED') return false;

    await this.prisma.emailSuggestion.create({
      data: {
        userId,
        gmailMessageId: message.id,
        receivedAt: message.receivedAt,
        fromAddress: message.from || '(unknown sender)',
        subject: message.subject || '(no subject)',
        company: match?.company ?? data.company,
        role: data.role ?? match?.role ?? null,
        proposedStage: data.stage,
        trackedApplicationId: match?.id ?? null,
        evidence: (data.evidence ?? message.subject).slice(0, 300),
      },
    });
    return true;
  }

  // --- the candidate's decision ----------------------------------------------------

  async apply(
    userId: string,
    id: string,
  ): Promise<{ tracker: TrackerView; gmail: GmailStatus }> {
    const suggestion = await this.pending(userId, id);
    const day = suggestion.receivedAt.toISOString().slice(0, 10);

    let applicationId = suggestion.trackedApplicationId;
    if (applicationId) {
      const current = await this.prisma.trackedApplication.findFirst({
        where: { id: applicationId, userId },
        select: { appliedOn: true, stage: true },
      });
      // The row may have moved on since this was suggested - by hand, or by an earlier
      // suggestion in the same Apply all. Accepting stale news marks it done and leaves
      // the row where it is, rather than walking an interview back to "applied".
      if (current && worthSuggesting(current.stage, suggestion.proposedStage)) {
        await this.tracker.editApplication(userId, applicationId, {
          stage: suggestion.proposedStage,
          ...(!current.appliedOn && suggestion.proposedStage === 'APPLIED'
            ? { appliedOn: day }
            : {}),
        });
      }
    } else {
      await this.tracker.addApplication(userId, {
        company: suggestion.company,
        role: suggestion.role,
        stage: suggestion.proposedStage,
        appliedOn: day,
        notes: `Added from email: "${suggestion.subject}"`.slice(0, 2000),
      });
      const added = await this.prisma.trackedApplication.findFirst({
        where: { userId, company: suggestion.company },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      applicationId = added?.id ?? null;
    }

    await this.prisma.emailSuggestion.update({
      where: { id },
      data: {
        status: EmailSuggestionStatus.APPLIED,
        trackedApplicationId: applicationId,
      },
    });

    // Three "thanks for applying" mails from one employer arrive as three new-application
    // suggestions. Once one is accepted the others are about that row, not new ones.
    if (applicationId && !suggestion.trackedApplicationId) {
      const siblings = await this.prisma.emailSuggestion.findMany({
        where: {
          userId,
          status: EmailSuggestionStatus.PENDING,
          trackedApplicationId: null,
        },
        select: { id: true, company: true },
      });
      const same = siblings
        .filter((s) => normalize(s.company) === normalize(suggestion.company))
        .map((s) => s.id);
      if (same.length > 0) {
        await this.prisma.emailSuggestion.updateMany({
          where: { id: { in: same } },
          data: { trackedApplicationId: applicationId },
        });
      }
    }

    return {
      tracker: await this.tracker.view(userId),
      gmail: await this.status(userId),
    };
  }

  /**
   * Every pending suggestion, oldest first, so a thread's "applied" lands before its
   * "interview" and the row ends at the later stage. One that fails (the 500-row cap, a
   * row deleted meanwhile) is left pending rather than stopping the rest.
   */
  async applyAll(
    userId: string,
  ): Promise<{ tracker: TrackerView; gmail: GmailStatus; failed: number }> {
    const pending = await this.prisma.emailSuggestion.findMany({
      where: { userId, status: EmailSuggestionStatus.PENDING },
      orderBy: { receivedAt: 'asc' },
      select: { id: true },
    });
    let failed = 0;
    for (const { id } of pending) {
      // Re-read each time: accepting one can re-point its siblings at a new row.
      await this.apply(userId, id).catch(() => failed++);
    }
    return {
      tracker: await this.tracker.view(userId),
      gmail: await this.status(userId),
      failed,
    };
  }

  async dismiss(userId: string, id: string): Promise<GmailStatus> {
    await this.pending(userId, id);
    await this.prisma.emailSuggestion.update({
      where: { id },
      data: { status: EmailSuggestionStatus.DISMISSED },
    });
    return this.status(userId);
  }

  private async pending(userId: string, id: string) {
    const suggestion = await this.prisma.emailSuggestion.findFirst({
      where: { id, userId, status: EmailSuggestionStatus.PENDING },
    });
    if (!suggestion) throw new NotFoundException('no such suggestion');
    return suggestion;
  }
}

/** Lower case, no punctuation, no corporate suffix - "Atlassian Pty Ltd." is "atlassian". */
function normalize(company: string): string {
  return company
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(
      /\b(inc|ltd|llc|limited|pvt|private|corp|corporation|co|gmbh|pty|plc|technologies|technology)\b/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Is moving from `current` to `proposed` news?
 *
 * Forward along SAVED -> OFFER, yes. To REJECTED from anything but REJECTED, yes. Out of
 * GHOSTED or REJECTED into anything, yes - that employer came back. Backward, no: an old
 * "thanks for applying" arriving late must not propose undoing an interview.
 */
function worthSuggesting(
  current: TrackedStage,
  proposed: TrackedStage,
): boolean {
  if (current === proposed) return false;
  if (proposed === TrackedStage.REJECTED) return true;
  if (current === TrackedStage.GHOSTED || current === TrackedStage.REJECTED)
    return true;
  return (STAGE_RANK[proposed] ?? -1) > (STAGE_RANK[current] ?? -1);
}
