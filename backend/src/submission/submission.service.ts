/**
 * Phase 6's orchestration: turn tailored resumes into forms that are already filled in.
 *
 * WHAT THIS DOES NOT DO, and cannot: submit anything. Not because a flag is off - the
 * page object handed to the adapters has no method that activates a submit control
 * (form-page.ts), and the only method that clicks at all refuses one at runtime
 * (playwright.page.ts). The human submits. This gets the form to the point where that
 * is one click and a glance.
 *
 * THE ORDER, and what each step protects:
 *
 *   1. Plan. Which tailored variants are worth opening, capped by
 *      `limits.maxApplicationsPerDay` and filtered by the per-company cooldown. Free,
 *      deterministic, and done before a browser exists - opening fifteen windows to
 *      discover the cap was three is the mistake this ordering prevents.
 *   2. Claim. An Application row, created BEFORE the form opens. The unique index on
 *      (userId, companyId, normalizedTitle) is what makes re-applying impossible, and
 *      it can only do that if the row exists before the work rather than after it.
 *   3. Prefill. One adapter, one form, no submit.
 *   4. Record. Coverage, the per-field outcomes, the screenshot. The status becomes
 *      PREPARED - which means "waiting for a human", and is where most rows stay.
 *   5. Confirm, separately and only on evidence. See confirmation.ts.
 *
 * THE COOLDOWN IS COUNTED FROM SUBMITTED ROWS, not from prepared ones. A form that was
 * opened and never sent has cost the employer nothing and must not use up the window -
 * that was left as a note in tailoring.service.ts and this is where it gets settled.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApplicationStatus,
  AtsType,
  Prisma,
  type ApplicationAnswers,
} from '@prisma/client';
import { resolve } from 'node:path';
import { loadTargets } from '../config/targets';
import { PrismaService } from '../prisma/prisma.service';
import {
  NO_STATED_ANSWERS,
  type AnswerSet,
  type StatedAnswers,
} from './answers';
import {
  coverage,
  type PreparedApplication,
  type PrefillResult,
} from './ats.adapter';
import { AdapterRegistry } from './board.adapters';
import { BrowserService } from './browser.service';
import { detectConfirmation } from './confirmation';

export class SubmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubmissionError';
  }
}

export interface SubmitRunOptions {
  userId?: string;
  profileLabel?: string;
  /** Overrides `limits.maxApplicationsPerDay`. */
  limit?: number;
  /** Prepare this one posting, ignoring the queue order. For working on an adapter. */
  jobId?: string;
}

/** One application the run intends to open, decided before any browser starts. */
export interface PlannedApplication {
  jobId: string;
  companyId: string;
  company: string;
  title: string;
  normalizedTitle: string;
  applyUrl: string;
  atsType: AtsType;
  variantId: string;
  /** The tailored PDF, absolute. Falls back to the docx when there is no pdf. */
  resumePath: string | null;
  coverLetter: string | null;
  score: number;
}

export interface PreparedResult {
  applicationId: string;
  planned: PlannedApplication;
  prefill: PrefillResult;
  coverage: number;
  /**
   * The page's visible text, read when called rather than captured now.
   *
   * A closure rather than a Playwright `Page` on the return type, so the CLI - which
   * needs the text of whatever page the human ended up on in order to look for a
   * confirmation - does not thereby get a handle it could submit the form with.
   */
  readPageText: () => Promise<string>;
}

/** Why a candidate posting was left out of the run. */
export interface SkippedApplication {
  title: string;
  company: string;
  reason: string;
}

export interface SubmitPlan {
  userId: string;
  profileId: string;
  items: PlannedApplication[];
  skipped: SkippedApplication[];
}

@Injectable()
export class SubmissionService {
  private readonly logger = new Logger(SubmissionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly browser: BrowserService,
    private readonly registry: AdapterRegistry,
  ) {}

  /**
   * What this run would open, best-scored first.
   *
   * Reads only. Nothing here creates a row or opens a window, so it is safe to call to
   * find out what a session would consist of - which the CLI does before asking the
   * human to sit down in front of it.
   */
  async plan(options: SubmitRunOptions = {}): Promise<SubmitPlan> {
    const targets = loadTargets();
    const profile = await this.resolveProfile(options);
    const limit = options.limit ?? targets.limits.maxApplicationsPerDay;

    const variants = await this.prisma.resumeVariant.findMany({
      where: {
        profileId: profile.id,
        // The guard's verdict, honoured here rather than re-derived. A variant that
        // failed provenance was rendered from the BASE resume, and the base resume is
        // a fine thing to send - but not under a filename and cover letter written for
        // this company, so those applications are left for the human to start.
        guardPassed: true,
        job: { closedAt: null },
        ...(options.jobId ? { jobId: options.jobId } : {}),
      },
      include: { job: { include: { company: true } } },
      orderBy: { createdAt: 'desc' },
    });

    if (variants.length === 0) {
      return {
        userId: profile.userId,
        profileId: profile.id,
        items: [],
        skipped: [],
      };
    }

    const jobIds = variants.map((variant) => variant.jobId);

    // Three lookups, each one query rather than one per posting.
    const [scores, existing, cooling] = await Promise.all([
      this.prisma.matchScore.findMany({
        where: { userId: profile.userId, jobId: { in: jobIds } },
        select: { jobId: true, score: true },
      }),
      this.prisma.application.findMany({
        where: {
          userId: profile.userId,
          jobId: { in: jobIds },
          // PREPARED and FAILED rows are deliberately NOT excluded: a form that was
          // opened and not sent is exactly what the next session should re-open.
          status: {
            in: [
              ApplicationStatus.SUBMITTED,
              ApplicationStatus.REJECTED,
              ApplicationStatus.SKIPPED,
            ],
          },
        },
        select: { jobId: true, status: true },
      }),
      this.coolingCompanies(
        profile.userId,
        targets.limits.perCompanyCooldownDays,
      ),
    ]);

    const scoreOf = new Map(scores.map((score) => [score.jobId, score.score]));
    const done = new Set(existing.map((row) => row.jobId));

    const items: PlannedApplication[] = [];
    const skipped: SkippedApplication[] = [];
    // One company per session, on top of the cooldown. Four roles at one employer in
    // one morning reads as spray-and-pray to the person holding that inbox.
    const seenCompanies = new Set<string>();
    // One variant per posting: `orderBy createdAt desc` means the newest is first, and
    // re-tailoring a posting should not queue it twice.
    const seenJobs = new Set<string>();

    for (const variant of variants) {
      const job = variant.job;
      const company = job.company?.name ?? 'unknown';
      const note = (reason: string) =>
        skipped.push({ title: job.title, company, reason });

      if (seenJobs.has(job.id)) continue;
      seenJobs.add(job.id);

      if (done.has(job.id)) {
        note('already submitted, or you rejected it');
        continue;
      }
      if (!job.companyId) {
        // Application.companyId is required, and it is required because the duplicate
        // index is built on it. A posting whose company was never resolved cannot be
        // tracked, so it is not applied to through this path.
        note('the posting has no company on record, so it cannot be tracked');
        continue;
      }
      if (cooling.has(job.companyId)) {
        note(
          `you applied to ${company} within the last ${targets.limits.perCompanyCooldownDays} days`,
        );
        continue;
      }
      if (seenCompanies.has(job.companyId)) {
        note(`another ${company} role is already in this session`);
        continue;
      }
      if (items.length >= limit) {
        note(`over the daily cap of ${limit}`);
        continue;
      }

      seenCompanies.add(job.companyId);
      items.push({
        jobId: job.id,
        companyId: job.companyId,
        company,
        title: job.title,
        normalizedTitle: job.normalizedTitle,
        applyUrl: job.applyUrl,
        atsType: job.atsType,
        variantId: variant.id,
        // Absolute, because the browser process resolves a file path against its own
        // working directory and not against this one.
        resumePath: absolute(variant.pdfPath ?? variant.docxPath),
        coverLetter: variant.coverLetter,
        score: scoreOf.get(job.id) ?? 0,
      });
    }

    // Best first, decided after filtering so the cap is spent on rows that survived it.
    items.sort((a, b) => b.score - a.score);

    return { userId: profile.userId, profileId: profile.id, items, skipped };
  }

  /**
   * Claims one application and fills its form.
   *
   * THE ROW IS WRITTEN BEFORE THE BROWSER OPENS. If the form then fails to load, the
   * row stays behind as FAILED with the reason on it - which is the outcome that lets
   * a bad adapter be found. Creating it afterwards would mean a crash mid-form leaves
   * no trace, and the next run would open the same form again believing it was new.
   */
  async prepare(
    userId: string,
    planned: PlannedApplication,
  ): Promise<PreparedResult> {
    const applicationId = await this.claim(userId, planned);
    const answers = await this.answersFor(userId, planned);

    const app: PreparedApplication = {
      applicationId,
      jobId: planned.jobId,
      applyUrl: planned.applyUrl,
      title: planned.title,
      company: planned.company,
      answers,
      screenshotPath: this.screenshotPath(applicationId),
    };

    const adapter = this.registry.for(planned.applyUrl);
    this.logger.log(
      `${planned.title} @ ${planned.company} - ${adapter.atsType} adapter, ${planned.applyUrl}`,
    );

    let prefill: PrefillResult;
    let readPageText: () => Promise<string>;
    try {
      const { page, raw } = await this.browser.visit(planned.applyUrl);
      // Read on demand, so it reflects the page AFTER the human acted rather than the
      // form as it was filled. An empty string for a tab they closed, which is not a
      // confirmation and therefore leaves the row PREPARED.
      readPageText = () => raw.innerText('body').catch(() => '');
      prefill = await adapter.prefill(page, app);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.prisma.application.update({
        where: { id: applicationId },
        data: { status: ApplicationStatus.FAILED, failureReason: reason },
      });
      throw new SubmissionError(
        `could not prepare ${planned.title} @ ${planned.company}: ${reason}`,
      );
    }

    const filled = coverage(prefill);

    await this.prisma.application.update({
      where: { id: applicationId },
      data: {
        status: ApplicationStatus.PREPARED,
        prefillCoverage: filled,
        screenshotPath: prefill.screenshotPath,
        // The per-field record, for the audit trail the plan requires and for finding
        // out which labels an adapter is missing. Values are already omitted for the
        // legal fields - see FilledField.
        screeningAnswers: {
          preparedAt: new Date().toISOString(),
          atsType: adapter.atsType,
          url: planned.applyUrl,
          needsHuman: prefill.needsHuman,
          fields: prefill.fields,
        } as unknown as Prisma.InputJsonValue,
        failureReason: null,
      },
    });

    return { applicationId, planned, prefill, coverage: filled, readPageText };
  }

  /**
   * Records a submission, and ONLY on evidence.
   *
   * `pageText` is whatever the page said after the human clicked. No confirmation
   * means the row stays PREPARED - never SUBMITTED on the strength of the human having
   * pressed a key in the terminal, because the row that says SUBMITTED is the row that
   * stops this system ever offering the role again.
   */
  async confirm(
    applicationId: string,
    pageText: string,
  ): Promise<{ submitted: boolean; confirmationText: string | null }> {
    const confirmationText = detectConfirmation(pageText);
    if (!confirmationText) return { submitted: false, confirmationText: null };

    await this.prisma.application.update({
      where: { id: applicationId },
      data: {
        status: ApplicationStatus.SUBMITTED,
        submittedAt: new Date(),
        confirmationText,
      },
    });
    return { submitted: true, confirmationText };
  }

  /** Marks an application the human decided not to send. */
  async skip(applicationId: string, reason: string): Promise<void> {
    await this.prisma.application.update({
      where: { id: applicationId },
      data: { status: ApplicationStatus.SKIPPED, failureReason: reason },
    });
  }

  /**
   * The Application row for this posting, created or reused.
   *
   * `upsert` on the unique key rather than find-then-create: two processes doing this
   * at once is not a scenario a single-user CLI has, but the index exists precisely so
   * that duplicate protection does not depend on that remaining true.
   */
  private async claim(
    userId: string,
    planned: PlannedApplication,
  ): Promise<string> {
    const row = await this.prisma.application.upsert({
      where: {
        userId_companyId_normalizedTitle: {
          userId,
          companyId: planned.companyId,
          normalizedTitle: planned.normalizedTitle,
        },
      },
      create: {
        userId,
        jobId: planned.jobId,
        companyId: planned.companyId,
        normalizedTitle: planned.normalizedTitle,
        status: ApplicationStatus.QUEUED,
        resumeVariantId: planned.variantId,
      },
      // A row that already exists is a form opened before and not sent. Re-pointed at
      // the newest variant, because that is the resume about to be attached.
      update: { resumeVariantId: planned.variantId },
      select: { id: true },
    });
    return row.id;
  }

  /**
   * Everything that may be typed into this application's form.
   *
   * The two halves come from different places on purpose - see answers.ts. Absent
   * statements stay absent; there is no default for "do you require sponsorship".
   */
  private async answersFor(
    userId: string,
    planned: PlannedApplication,
  ): Promise<AnswerSet> {
    const [profile, stated] = await Promise.all([
      this.prisma.candidateProfile.findFirst({
        where: { userId, isActive: true },
        select: {
          fullName: true,
          email: true,
          phone: true,
          location: true,
          linkedIn: true,
          github: true,
          portfolio: true,
        },
      }),
      this.prisma.applicationAnswers.findUnique({ where: { userId } }),
    ]);

    if (!profile) {
      throw new SubmissionError(
        'no selected resume for this candidate, so there are no contact details to ' +
          'fill in. Pick one under Resumes in the web app.',
      );
    }

    return {
      profile,
      stated: toStated(stated),
      resumePath: planned.resumePath,
      coverLetter: planned.coverLetter,
    };
  }

  /** Companies applied to inside the cooldown window. */
  private async coolingCompanies(
    userId: string,
    days: number,
  ): Promise<Set<string>> {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.prisma.application.findMany({
      where: {
        userId,
        status: ApplicationStatus.SUBMITTED,
        submittedAt: { gte: since },
      },
      select: { companyId: true },
    });
    return new Set(rows.map((row) => row.companyId));
  }

  private screenshotPath(applicationId: string): string {
    const dir =
      this.config.get<string>('SUBMISSION_SHOT_DIR') ??
      '.artifacts/submissions';
    // The timestamp keeps every attempt rather than overwriting the last one. A form
    // that was filled badly yesterday and correctly today is two pieces of evidence.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return resolve(dir, `${applicationId}-${stamp}.png`);
  }

  /**
   * Which resume to fill forms from.
   *
   * The same rule as MatchingService and TailoringService, and it has to be the same
   * rule for the same reason: typing one candidate's phone number into a form headed
   * with another's name is not a mistake that announces itself.
   */
  private async resolveProfile(options: SubmitRunOptions) {
    const profiles = await this.prisma.candidateProfile.findMany({
      where: {
        confirmedAt: { not: null },
        ...(options.userId ? { userId: options.userId } : {}),
        ...(options.profileLabel ? { label: options.profileLabel } : {}),
      },
      select: { id: true, userId: true, label: true, isActive: true },
    });

    if (profiles.length === 0) {
      throw new SubmissionError(
        'no confirmed candidate profile matches. Upload one under Resumes in the web app.',
      );
    }

    const chosen = options.profileLabel
      ? profiles
      : profiles.filter((profile) => profile.isActive);

    if (chosen.length === 0) {
      throw new SubmissionError(
        `${profiles.length} confirmed resume(s) exist and none is selected. Pick one ` +
          'under Resumes in the web app, or pass --label.',
      );
    }
    if (chosen.length > 1) {
      throw new SubmissionError(
        `${chosen.length} candidates have a selected resume (` +
          chosen.map((profile) => profile.label).join(', ') +
          '). Pass --user or --label to choose one.',
      );
    }
    return chosen[0];
  }
}

/**
 * The stored statements, or the absence of them.
 *
 * Decimal to string rather than to number, deliberately. These are money: 12.10 LPA
 * typed into an employer's form has to read as 12.10, and a float round-trip is how
 * that becomes 12.1 - or, for less friendly values, 12.099999999999999.
 */
function toStated(row: ApplicationAnswers | null): StatedAnswers {
  if (!row) return NO_STATED_ANSWERS;
  return {
    workAuthorization: row.workAuthorization,
    needsSponsorship: row.needsSponsorship,
    noticePeriodDays: row.noticePeriodDays,
    currentCtcLpa: row.currentCtcLpa?.toString() ?? null,
    expectedCtcLpa: row.expectedCtcLpa?.toString() ?? null,
    willingToRelocate: row.willingToRelocate,
    earliestStartDate: row.earliestStartDate,
    customAnswers: toCustomAnswers(row.customAnswers),
  };
}

/**
 * `customAnswers` is a Json column, so it is whatever was written into it.
 *
 * Narrowed rather than cast: a nested object in there would otherwise become the
 * string "[object Object]" typed into a real employer's form.
 */
function toCustomAnswers(
  value: Prisma.JsonValue | null,
): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return {};
  const out: Record<string, string> = {};
  for (const [question, answer] of Object.entries(value)) {
    if (typeof answer === 'string' && answer.trim().length > 0) {
      out[question] = answer;
    }
  }
  return out;
}

function absolute(path: string | null): string | null {
  return path === null ? null : resolve(path);
}
