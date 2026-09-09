/**
 * Builds one morning's digest, stores it, and answers the questions the UI asks of it.
 *
 * WHY THE WINDOW IS "SINCE THE LAST DIGEST" AND NOT "THE LAST 24 HOURS". The digest
 * says "new". If the window were a fixed 24 hours and the worker were down on Tuesday,
 * Tuesday's postings would appear in no digest at all - counted as new by a window that
 * had already passed over them. Anchoring to the previous digest means every posting is
 * reported exactly once, a missed morning is absorbed by the next one, and a manual
 * re-run does not re-announce what was already sent. It is also the only definition
 * under which "9 new" is a claim that can be checked.
 *
 * WHY IT IS STORED. A digest is a statement about a moment. Recomputing it at 4pm would
 * answer a different question under the same heading, and the emailed copy would then
 * disagree with the page it links to. See DailyDigest in schema.prisma.
 *
 * THE DECISION THIS EXISTS TO COLLECT. PLAN-v2 phase 7: "reject from the phone BEFORE
 * the desktop submit session, so the browser queue holds only wanted applications". The
 * numbers are the reason to open it; `decide()` is what it is for. Rejecting here costs
 * one row update and saves a deep-tier LLM call and a browser session.
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  ApplicationStatus,
  MatchDecision,
  MatchVerdict,
  Prisma,
  Role,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  missingRequiredAnswers,
  NO_STATED_ANSWERS,
  REQUIRED_ANSWER_LABEL,
} from '../submission/answers';
import {
  readPayload,
  TOP_MATCHES,
  type DigestBoard,
  type DigestMatch,
  type DigestPayload,
  type DigestSystem,
} from './digest.types';

/**
 * The verdicts a candidate is asked to decide about.
 *
 * WEAK and REJECT are excluded: putting fifty rejected postings in front of someone
 * every morning trains them to ignore the digest, which costs more than the small
 * chance that the model was wrong about one of them. They remain on the Jobs page,
 * where looking at them is a deliberate act.
 *
 * BORDERLINE is INCLUDED here even though tailoring excludes it, and the difference is
 * the point: borderline is precisely the verdict that wants a human, and this is the
 * screen where a human is looking.
 */
const DECIDABLE: MatchVerdict[] = [
  MatchVerdict.STRONG,
  MatchVerdict.GOOD,
  MatchVerdict.BORDERLINE,
];

/** A day with nothing in it still gets a digest. See `build`. */
const EMPTY_VERDICTS: Record<string, number> = {};

export interface BuiltDigest {
  id: string;
  day: string;
  payload: DigestPayload;
  /**
   * Whether an email for this morning has ALREADY left.
   *
   * Read from the row rather than inferred from "did the upsert create it", because the
   * question delivery needs answered is not "is this new" but "has this person already
   * been told". A worker that restarts twice at 09:00 rebuilds the same row three times,
   * and only the first of those should mail anybody. NotifyService uses this to skip the
   * email unless the send was asked for explicitly.
   */
  alreadyEmailed: boolean;
}

@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Builds the digest for one candidate and writes it.
   *
   * `now` is a parameter rather than read from the clock inside, because a report about
   * a window is not testable if the window's end is a global. The scheduler passes the
   * real time; the tests pass a fixed one.
   */
  async build(userId: string, now = new Date()): Promise<BuiltDigest> {
    const day = istDay(now);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (!user) throw new NotFoundException(`no user with id ${userId}`);

    const since = await this.windowStart(userId, now);

    const [candidate, system] = await Promise.all([
      this.candidateSection(userId, since),
      // Admin only. Board yield and connector health are facts about the operator's
      // machine, and a candidate has no way to act on either.
      user.role === Role.ADMIN
        ? this.systemSection(since)
        : Promise.resolve(null),
    ]);

    const payload: DigestPayload = {
      version: 1,
      day,
      generatedAt: now.toISOString(),
      since: since.toISOString(),
      candidate,
      system,
    };

    // Upsert on (userId, day): a worker restart at 09:00 rewrites this morning's digest
    // rather than adding a second one. Delivery stamps are deliberately NOT cleared on
    // the rewrite - an email that went out cannot be unsent, and clearing them would
    // mean a restart loop mails the same morning repeatedly.
    const row = await this.prisma.dailyDigest.upsert({
      where: { userId_day: { userId, day: dayValue(day) } },
      create: {
        userId,
        day: dayValue(day),
        payload: payload,
      },
      update: { payload: payload },
      select: { id: true, emailedAt: true },
    });

    return {
      id: row.id,
      day,
      payload,
      alreadyEmailed: row.emailedAt !== null,
    };
  }

  /**
   * Everyone a digest should be built for.
   *
   * SELECTED, not merely confirmed - the same rule as MatchingScheduler. A candidate
   * with three confirmed resumes and none chosen has a pipeline that cannot run, and
   * mailing them a report of zeros every morning describes the symptom while hiding the
   * cause.
   */
  async recipients(): Promise<{ id: string; email: string; name: string }[]> {
    const profiles = await this.prisma.candidateProfile.findMany({
      where: {
        confirmedAt: { not: null },
        isActive: true,
        user: { active: true },
      },
      select: { user: { select: { id: true, email: true, name: true } } },
      distinct: ['userId'],
    });
    return profiles.map((profile) => profile.user);
  }

  /** The newest digest for this candidate, or null before the first one is built. */
  async latest(userId: string) {
    const row = await this.prisma.dailyDigest.findFirst({
      where: { userId },
      orderBy: { day: 'desc' },
    });
    return row === null ? null : this.present(row);
  }

  /** The last `limit` digests, newest first, for the history list. */
  async list(userId: string, limit: number) {
    const rows = await this.prisma.dailyDigest.findMany({
      where: { userId },
      orderBy: { day: 'desc' },
      take: limit,
    });
    return rows.map((row) => this.present(row));
  }

  async one(userId: string, id: string) {
    // Scoped by userId in the WHERE, not checked after the read. A digest names the
    // postings someone is applying for; fetching another candidate's by id has to be
    // unexpressible rather than merely refused.
    const row = await this.prisma.dailyDigest.findFirst({
      where: { id, userId },
    });
    if (!row) throw new NotFoundException('no such digest');
    return this.present(row);
  }

  /** Marks it read. Idempotent: the first open is the one that counts. */
  async markRead(userId: string, id: string): Promise<void> {
    await this.prisma.dailyDigest.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
  }

  async unreadCount(userId: string): Promise<number> {
    return this.prisma.dailyDigest.count({ where: { userId, readAt: null } });
  }

  /**
   * Records what the candidate said about a posting.
   *
   * `updateMany` scoped by userId rather than `update` by id, for the same reason as
   * `one` above: a decision on somebody else's score must not be expressible. It also
   * makes a missing row a no-op that reports 0 rather than a thrown Prisma error.
   */
  async decide(
    userId: string,
    jobId: string,
    decision: MatchDecision,
  ): Promise<void> {
    const result = await this.prisma.matchScore.updateMany({
      where: { userId, jobId },
      data: {
        decision,
        // Cleared when the decision goes back to UNDECIDED, so "when did you decide"
        // never outlives the decision it refers to.
        decidedAt: decision === MatchDecision.UNDECIDED ? null : new Date(),
      },
    });
    if (result.count === 0) {
      throw new NotFoundException(
        'that posting has not been scored for you, so there is nothing to decide about',
      );
    }
  }

  /** Records the outcome of one delivery attempt. */
  async recordDelivery(
    id: string,
    channel: 'email' | 'telegram',
    error: string | null,
  ): Promise<void> {
    await this.prisma.dailyDigest.update({
      where: { id },
      data:
        error === null
          ? channel === 'email'
            ? { emailedAt: new Date(), deliveryError: null }
            : { telegramAt: new Date(), deliveryError: null }
          : { deliveryError: `${channel}: ${error}`.slice(0, 500) },
    });
  }

  /** A stored row as the API returns it, with the payload validated. */
  private present(row: {
    id: string;
    day: Date;
    payload: Prisma.JsonValue;
    emailedAt: Date | null;
    telegramAt: Date | null;
    deliveryError: string | null;
    readAt: Date | null;
    createdAt: Date;
  }) {
    const payload = readPayload(row.payload);
    if (payload === null) {
      // Logged, not thrown. A row this version cannot read is one unreadable card in a
      // list, and the list is what the request was for.
      this.logger.warn(
        `digest ${row.id} has a payload this version cannot read, so it is returned empty`,
      );
    }
    return {
      id: row.id,
      day: row.day.toISOString().slice(0, 10),
      payload,
      emailedAt: row.emailedAt,
      telegramAt: row.telegramAt,
      deliveryError: row.deliveryError,
      readAt: row.readAt,
      createdAt: row.createdAt,
    };
  }

  /**
   * When the last digest was generated, or 24 hours ago.
   *
   * Reads the PREVIOUS payload's `generatedAt` rather than the row's `createdAt`,
   * because an upsert leaves `createdAt` at the first write of that day while the
   * numbers belong to the last one.
   */
  private async windowStart(userId: string, now: Date): Promise<Date> {
    const previous = await this.prisma.dailyDigest.findFirst({
      where: { userId, day: { lt: dayValue(istDay(now)) } },
      orderBy: { day: 'desc' },
      select: { payload: true, createdAt: true },
    });
    if (!previous) return new Date(now.getTime() - 86_400_000);

    const payload = readPayload(previous.payload);
    const stamp = payload ? new Date(payload.generatedAt) : previous.createdAt;
    // A payload written with a broken clock would otherwise produce a window that ends
    // before it starts, and every count inside it would be zero.
    return stamp.getTime() < now.getTime()
      ? stamp
      : new Date(now.getTime() - 86_400_000);
  }

  private async candidateSection(userId: string, since: Date) {
    const [
      newMatches,
      verdicts,
      undecided,
      top,
      tailored,
      guardFailed,
      preparedWaiting,
      submitted,
      answers,
    ] = await Promise.all([
      this.prisma.matchScore.count({
        where: { userId, scoredAt: { gte: since } },
      }),
      this.prisma.matchScore.groupBy({
        by: ['verdict'],
        where: { userId, scoredAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.matchScore.count({
        where: {
          userId,
          decision: MatchDecision.UNDECIDED,
          verdict: { in: DECIDABLE },
          job: { closedAt: null },
        },
      }),
      this.prisma.matchScore.findMany({
        where: {
          userId,
          decision: MatchDecision.UNDECIDED,
          verdict: { in: DECIDABLE },
          job: { closedAt: null },
        },
        include: { job: { include: { company: { select: { name: true } } } } },
        orderBy: { score: 'desc' },
        take: TOP_MATCHES,
      }),
      this.prisma.resumeVariant.count({
        where: { profile: { userId }, createdAt: { gte: since } },
      }),
      this.prisma.resumeVariant.count({
        where: {
          profile: { userId },
          createdAt: { gte: since },
          guardPassed: false,
        },
      }),
      this.prisma.application.count({
        where: { userId, status: ApplicationStatus.PREPARED },
      }),
      this.prisma.application.count({
        where: {
          userId,
          status: ApplicationStatus.SUBMITTED,
          submittedAt: { gte: since },
        },
      }),
      this.prisma.applicationAnswers.findUnique({ where: { userId } }),
    ]);

    const byVerdict = { ...EMPTY_VERDICTS };
    for (const row of verdicts) byVerdict[row.verdict] = row._count._all;

    return {
      newMatches,
      byVerdict,
      undecided,
      top: top.map((row): DigestMatch => ({
        jobId: row.jobId,
        title: row.job.title,
        company: row.job.company?.name ?? 'unknown',
        location: row.job.location,
        score: row.score,
        verdict: row.verdict,
        // Decimal to string, not to number. This figure is stored as an exact decimal
        // because it is a salary to negotiate against, and `Number(...)` would hand
        // the JSON column a binary float instead - the one representation that cannot
        // promise the value comes back as it went in.
        salaryLpa: row.estimatedSalaryLPA?.toString() ?? null,
        url: row.job.applyUrl,
      })),
      tailored,
      guardFailed,
      // Null and not 0 when nothing was tailored. Zero out of zero is no information,
      // and a week of quiet days would otherwise read as a perfect record.
      guardFailureRate: tailored === 0 ? null : guardFailed / tailored,
      preparedWaiting,
      submitted,
      missingAnswers: missingAnswers(answers),
    };
  }

  private async systemSection(since: Date): Promise<DigestSystem> {
    const [
      newCompanies,
      newPostings,
      runs,
      lastRun,
      scoreModels,
      variantModels,
    ] = await Promise.all([
      this.prisma.company.count({ where: { createdAt: { gte: since } } }),
      this.prisma.jobPosting.count({ where: { firstSeenAt: { gte: since } } }),
      this.prisma.sourceRun.groupBy({
        by: ['source'],
        where: { startedAt: { gte: since } },
        _sum: {
          companiesTried: true,
          postingsSeen: true,
          postingsNew: true,
          errors: true,
        },
      }),
      this.prisma.sourceRun.findFirst({
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true },
      }),
      this.prisma.matchScore.groupBy({
        by: ['model'],
        where: { scoredAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.resumeVariant.groupBy({
        by: ['model'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
    ]);

    const boards: DigestBoard[] = runs
      .map((run) => ({
        source: run.source,
        companiesTried: run._sum.companiesTried ?? 0,
        postingsSeen: run._sum.postingsSeen ?? 0,
        postingsNew: run._sum.postingsNew ?? 0,
        errors: run._sum.errors ?? 0,
      }))
      .sort((a, b) => b.postingsNew - a.postingsNew);

    // Counted from the rows the calls produced, because token counts are not stored
    // anywhere - see DigestSystem.modelUse.
    const calls = new Map<string, number>();
    for (const row of scoreModels) {
      calls.set(row.model, (calls.get(row.model) ?? 0) + row._count._all);
    }
    for (const row of variantModels) {
      const model = row.model ?? 'unrecorded';
      calls.set(model, (calls.get(model) ?? 0) + row._count._all);
    }

    return {
      newCompanies,
      newPostings,
      boards,
      deadBoards: deadBoards(boards),
      modelUse: [...calls.entries()]
        .map(([model, count]) => ({ model, calls: count }))
        .sort((a, b) => b.calls - a.calls),
      lastDiscoveryAt: lastRun?.startedAt.toISOString() ?? null,
    };
  }
}

/**
 * Boards worth looking at, with the reason.
 *
 * A JUDGEMENT AND LABELLED AS ONE. "No new postings" on a board that returned plenty of
 * postings is an ordinary quiet day for a small employer, so that alone is not reported
 * - what is reported is a board that reached nothing at all, or one that raised errors
 * and produced nothing. Both of those are broken in a way a person can act on.
 */
export function deadBoards(boards: DigestBoard[]) {
  const dead: { source: string; reason: string }[] = [];
  for (const board of boards) {
    if (board.companiesTried > 0 && board.postingsSeen === 0) {
      dead.push({
        source: board.source,
        reason: `tried ${board.companiesTried} board(s) and read no postings at all`,
      });
      continue;
    }
    if (board.errors > 0 && board.postingsNew === 0) {
      dead.push({
        source: board.source,
        reason: `${board.errors} error(s) and nothing new`,
      });
    }
  }
  return dead;
}

/**
 * The answers a form needs and does not have, in the words the form uses.
 *
 * Deliberately plain English rather than column names. The person reading this on a
 * phone is being asked to go and fill something in, and "needsSponsorship" is not what
 * the box on the form is called.
 */
export function missingAnswers(
  answers: {
    workAuthorization: string | null;
    needsSponsorship: boolean | null;
    noticePeriodDays: number | null;
    expectedCtcLpa: Prisma.Decimal | null;
  } | null,
): string[] {
  // The rule itself lives in submission/answers.ts, next to the code that types these
  // values into a form, and the answers SCREEN marks its fields from the same list.
  // This function is only the translation into the words the digest speaks.
  return missingRequiredAnswers({
    ...NO_STATED_ANSWERS,
    workAuthorization: answers?.workAuthorization ?? null,
    needsSponsorship: answers?.needsSponsorship ?? null,
    noticePeriodDays: answers?.noticePeriodDays ?? null,
    expectedCtcLpa: answers?.expectedCtcLpa?.toString() ?? null,
  }).map((key) => REQUIRED_ANSWER_LABEL[key]);
}

/**
 * The calendar day in India, as YYYY-MM-DD.
 *
 * IST AND NOT THE SERVER'S TIME ZONE. The candidate is in India and the digest is
 * named after their morning; a server in us-east-1 would otherwise date the 09:00 IST
 * digest as the previous day, and the unique-per-day index would then be enforcing
 * something nobody meant.
 *
 * `en-CA` because its short date format IS YYYY-MM-DD, which avoids assembling the
 * parts by hand.
 */
export function istDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * A YYYY-MM-DD string as the value for a `@db.Date` column.
 *
 * Midnight UTC, which is the convention Prisma uses for date-only columns: the column
 * stores no time and no zone, so the instant chosen must be one that cannot roll over
 * into a neighbouring day when it is formatted back. Local midnight would do exactly
 * that east of Greenwich.
 */
export function dayValue(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}
