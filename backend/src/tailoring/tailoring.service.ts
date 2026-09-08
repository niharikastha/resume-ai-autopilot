/**
 * Phase 5's orchestration: take the shortlist matching produced, tailor a resume for
 * each posting, and refuse to ship one that does not survive the guard.
 *
 * The order is fixed and each step exists to stop the next one wasting something:
 *
 *   1. Pick the shortlist from MatchScore. Deterministic, free, and capped - see
 *      `limits.maxApplicationsPerDay`. A tailoring call is the most expensive thing
 *      this system does, so the cap is applied BEFORE any of them are made.
 *   2. Tailor. One deep-tier call per posting, sharing a cached prefix.
 *   3. Guard. Fails closed.
 *   4. Render. The tailored document if the guard passed, the BASE resume if it did
 *      not - and a base resume is still rendered and still recorded, because the
 *      candidate should end the run with something to send either way.
 *
 * WHAT THIS DOES NOT DO: apply to anything. It writes files and ResumeVariant rows.
 * Submission is phase 6 and is assisted, never automatic.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AtomKind, MatchDecision, MatchVerdict, Prisma } from '@prisma/client';
import { LLM_PROVIDER, type LlmProvider } from '../llm/llm.types';
import {
  tailorResumeTask,
  type TailorInput,
  type TailorOutput,
  type TailorShared,
} from '../llm/tasks/tailor-resume.task';
import { loadTargets } from '../config/targets';
import { PrismaService } from '../prisma/prisma.service';
import { canonicalise } from '../profile/tech';
import {
  buildResume,
  resumeFilename,
  type DocumentAtom,
  type ResumeContact,
} from './resume.document';
import {
  checkProvenance,
  summarize,
  type ProvenanceReport,
} from './provenance.guard';
import { renderResume } from './resume.render';

/**
 * The verdicts worth spending a deep-tier call on.
 *
 * BORDERLINE is excluded deliberately. It is the verdict that most wants a human
 * glance, and tailoring fifteen borderline roles is how the daily cap gets consumed
 * by applications the candidate would not have chosen to send.
 */
const TAILORABLE: MatchVerdict[] = [MatchVerdict.STRONG, MatchVerdict.GOOD];

export interface TailorRunOptions {
  userId?: string;
  profileLabel?: string;
  /** Overrides `limits.maxApplicationsPerDay`. */
  limit?: number;
  /**
   * Tailor this one posting, ignoring the shortlist entirely - the score, the
   * verdict, the company cooldown and the already-has-a-variant check. It does not
   * even need to have been matched. For debugging a prompt.
   */
  jobId?: string;
  /** Run the guard against a real tailoring but write no files and no rows. */
  dryRun?: boolean;
  /** Re-tailor a posting that already has a variant. */
  force?: boolean;
  mode?: 'auto' | 'batch' | 'inline';
}

/**
 * One posting to tailor for, plus the score to show beside it.
 *
 * A named type rather than `typeof scores[number]` because the two ways into the
 * shortlist no longer produce the same shape: `--job` has no MatchScore row to infer
 * it from, and inferring it from the query is what made that path impossible to add.
 */
interface ShortlistItem {
  job: Prisma.JobPostingGetPayload<{ include: { company: true } }>;
  score: number;
}

export interface TailorOneResult {
  jobId: string;
  title: string;
  company: string;
  score: number;
  guardPassed: boolean;
  report: ProvenanceReport;
  /** The variant row, absent on a dry run. */
  variantId: string | null;
  docxPath: string | null;
  pdfPath: string | null;
}

export interface TailorRunResult {
  profileId: string;
  shortlisted: number;
  skippedExisting: number;
  tailored: number;
  guardPassed: number;
  guardFailed: number;
  callFailures: number;
  results: TailorOneResult[];
}

export class TailoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TailoringError';
  }
}

@Injectable()
export class TailoringService {
  private readonly logger = new Logger(TailoringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
  ) {}

  async tailor(options: TailorRunOptions = {}): Promise<TailorRunResult> {
    const targets = loadTargets();
    const profile = await this.resolveProfile(options);

    const atoms = await this.prisma.profileAtom.findMany({
      where: { profileId: profile.id },
      orderBy: { ordinal: 'asc' },
    });

    if (atoms.length === 0) {
      throw new TailoringError(
        `profile ${profile.label} has no atoms. Run ` +
          '`npm run cli -- profile:ingest <resume>` first.',
      );
    }

    const limit = options.limit ?? targets.limits.maxApplicationsPerDay;
    const shortlist = await this.shortlist(profile.userId, limit, options);

    const result: TailorRunResult = {
      profileId: profile.id,
      shortlisted: shortlist.length,
      skippedExisting: 0,
      tailored: 0,
      guardPassed: 0,
      guardFailed: 0,
      callFailures: 0,
      results: [],
    };

    if (shortlist.length === 0) {
      this.logger.warn(
        'nothing to tailor. Either matching has not run, or no posting scored ' +
          `${TAILORABLE.join('/')} - run \`npm run cli -- match\` and read the funnel.`,
      );
      return result;
    }

    const shared = await this.sharedPrefix(profile, atoms);
    const contact = toContact(profile);
    const documentAtoms: DocumentAtom[] = atoms.map((atom) => ({
      id: atom.id,
      kind: atom.kind,
      text: atom.text,
      employer: atom.employer,
      dateRange: atom.dateRange,
      ordinal: atom.ordinal,
    }));

    this.logger.log(
      `tailoring ${shortlist.length} posting(s) with ${this.llm.modelFor('deep')} ` +
        `from ${atoms.length} atoms and ${shared.allowedTech.length} allowed tech tokens`,
    );

    for (const item of shortlist) {
      let output: TailorOutput;
      let provider: string;
      let model: string;
      try {
        const call = await this.llm.complete(tailorResumeTask, shared, {
          title: item.job.title,
          company: item.job.company?.name ?? 'the company',
          description: item.job.descriptionText,
        } satisfies TailorInput);
        output = call.value;
        provider = call.provider;
        model = call.model;
      } catch (err) {
        // One posting's failure must not end the run: the remaining postings are
        // independent calls and the candidate would rather have fourteen resumes
        // than none.
        result.callFailures++;
        this.logger.warn(
          `could not tailor ${item.job.title} @ ${item.job.company?.name}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
        continue;
      }

      result.tailored++;

      const report = checkProvenance({
        atoms: atoms.map((atom) => ({
          id: atom.id,
          text: atom.text,
          tech: atom.tech,
          metrics: atom.metrics,
          employer: atom.employer,
          dateRange: atom.dateRange,
        })),
        allowedTech: shared.allowedTech,
        output,
      });

      if (report.passed) {
        result.guardPassed++;
        this.logger.log(`${item.job.title}: ${summarize(report)}`);
      } else {
        result.guardFailed++;
        // Logged at warn with the violations spelled out, because this is the line
        // that tells someone the prompt has drifted.
        this.logger.warn(`${item.job.title}: ${summarize(report)}`);
        for (const violation of report.violations) {
          this.logger.warn(`    ${violation.kind}: ${violation.detail}`);
        }
      }

      // The fallback. `null` tailoring is the base resume, built by the same
      // function - see resume.document.ts.
      const document = buildResume(
        documentAtoms,
        contact,
        profile.atoms[0]?.text ?? null,
        report.passed ? output : null,
      );

      let docxPath: string | null = null;
      let pdfPath: string | null = null;
      let variantId: string | null = null;

      if (!options.dryRun) {
        const basename = resumeFilename(
          profile.fullName,
          item.job.company?.name ?? 'unknown',
          item.job.title,
        );
        const rendered = await renderResume(
          document,
          this.config.getOrThrow<string>('RESUME_OUTPUT_DIR'),
          basename,
        );
        docxPath = rendered.docxPath;
        pdfPath = rendered.pdfPath;

        variantId = await this.writeVariant(
          profile.id,
          item.job.id,
          output,
          report,
          rendered,
          { provider, model },
        );
      }

      result.results.push({
        jobId: item.job.id,
        title: item.job.title,
        company: item.job.company?.name ?? 'unknown',
        score: item.score,
        guardPassed: report.passed,
        report,
        variantId,
        docxPath,
        pdfPath,
      });
    }

    return result;
  }

  /**
   * Which profile to tailor from.
   *
   * Refuses to guess when there is more than one, exactly as MatchingService does:
   * tailoring the wrong candidate's resume and rendering it to a file named after a
   * real company is not a mistake that announces itself.
   */
  private async resolveProfile(options: TailorRunOptions) {
    const profiles = await this.prisma.candidateProfile.findMany({
      where: {
        confirmedAt: { not: null },
        ...(options.userId ? { userId: options.userId } : {}),
        ...(options.profileLabel ? { label: options.profileLabel } : {}),
      },
      // The headline: the first ROLE atom's text is the closest thing a parsed
      // resume has to one, and it is what the base resume falls back to.
      include: {
        atoms: {
          where: { kind: AtomKind.ROLE },
          orderBy: { ordinal: 'asc' },
          take: 1,
        },
      },
    });

    if (profiles.length === 0) {
      throw new TailoringError(
        'no confirmed candidate profile matches. Upload one under Resumes in the ' +
          'web app, or run `npm run cli -- profile:ingest <resume>` and confirm it.',
      );
    }

    // The selected resume, when the caller did not name one. Same rule as
    // MatchingService.resolveProfile, and it has to be the same rule: tailoring a
    // resume the candidate did not choose, then rendering it to a file named after
    // a real company, is not a mistake that announces itself.
    const chosen = options.profileLabel
      ? profiles
      : profiles.filter((p) => p.isActive);

    if (chosen.length === 0) {
      throw new TailoringError(
        `${profiles.length} confirmed resume(s) exist and none is selected. Pick ` +
          'one under Resumes in the web app, or pass --label.',
      );
    }
    if (chosen.length > 1) {
      throw new TailoringError(
        `${chosen.length} candidates have a selected resume (` +
          chosen.map((p) => p.label).join(', ') +
          '). Pass --user or --label to choose one.',
      );
    }
    return chosen[0];
  }

  /**
   * The postings worth tailoring, best first.
   *
   * Ordered by the stored score rather than re-running stage 4's ranking: the point
   * of this query is to spend the daily cap on the best of what matching found, and
   * MatchScore.score is what matching concluded.
   */
  private async shortlist(
    userId: string,
    limit: number,
    options: TailorRunOptions,
  ): Promise<ShortlistItem[]> {
    // `--job` REACHES PAST MatchScore ENTIRELY, which it has to in order to be
    // useful. It exists to iterate on the prompt against a chosen posting, and the
    // first thing that is true when someone reaches for it is that matching has not
    // produced a usable shortlist yet - so requiring a MatchScore row would make the
    // debugging flag unavailable in exactly the situation it is for. It was written
    // that way first, and returned an empty shortlist every time.
    if (options.jobId) {
      const job = await this.prisma.jobPosting.findUnique({
        where: { id: options.jobId },
        include: { company: true },
      });
      if (!job) throw new TailoringError(`no posting with id ${options.jobId}`);
      // Thrown rather than returning an empty shortlist, because "nothing to tailor"
      // would send someone to look at matching for a problem that is in the posting.
      if (!job.descriptionText) {
        throw new TailoringError(
          `posting ${options.jobId} stored an empty description, so there is ` +
            'nothing to tailor against.',
        );
      }

      // The score is display-only here, and 0 is honest for a posting that has
      // never been scored - it is not a claim that the posting is bad.
      const scored = await this.prisma.matchScore.findUnique({
        where: { userId_jobId: { userId, jobId: job.id } },
        select: { score: true },
      });
      return [{ job, score: scored?.score ?? 0 }];
    }

    const scores = await this.prisma.matchScore.findMany({
      where: {
        userId,
        verdict: { in: TAILORABLE },
        // Never tailor for a posting the employer has taken down.
        job: { closedAt: null },
        // Nor for one the candidate said no to in the morning digest. This is the
        // saving phase 7 exists for: the rejection costs one row update and lands
        // BEFORE the deep-tier call that writing a resume needs. WANTED and
        // UNDECIDED both pass - an unopened digest must not stop the pipeline.
        decision: { not: MatchDecision.NOT_WANTED },
      },
      include: { job: { include: { company: true } } },
      orderBy: { score: 'desc' },
      // Over-fetch, because the filters below remove rows and the cap has to be met
      // with rows that survive them.
      take: limit * 4,
    });

    if (scores.length === 0) return [];

    // One query rather than one per posting.
    const existing = options.force
      ? new Set<string>()
      : new Set(
          (
            await this.prisma.resumeVariant.findMany({
              where: {
                jobId: { in: scores.map((s) => s.jobId) },
                guardPassed: true,
              },
              select: { jobId: true },
            })
          ).map((v) => v.jobId),
        );

    // Company cooldown: at most one tailored resume per company per run. The full
    // `perCompanyCooldownDays` window belongs to phase 6, where Application rows
    // record what was actually sent - a variant that was rendered and never
    // submitted should not use up the cooldown.
    const seenCompanies = new Set<string>();
    const picked: ShortlistItem[] = [];

    for (const score of scores) {
      if (picked.length >= limit) break;
      if (existing.has(score.jobId)) continue;
      const company = score.job.companyId;
      if (company) {
        if (seenCompanies.has(company)) continue;
        seenCompanies.add(company);
      }
      if (!score.job.descriptionText) continue;
      picked.push({ job: score.job, score: score.score });
    }

    return picked;
  }

  /**
   * The cached prefix: the candidate, once.
   *
   * Built once per run and reused for every posting, which is the whole reason
   * LlmTask splits prefix from question. Fifteen postings share one candidate, and
   * a full atom list is the large half of the prompt.
   */
  private async sharedPrefix(
    profile: { id: string; userId: string; fullName: string },
    atoms: {
      id: string;
      kind: AtomKind;
      text: string;
      tech: string[];
      metrics: string[];
      employer: string | null;
      dateRange: string | null;
    }[],
  ): Promise<TailorShared> {
    const reserve = await this.prisma.skillsReserve.findMany({
      // ENABLED only. The table exists so that widening what tailoring may claim is
      // a deliberate act; reading disabled rows here would undo that.
      where: { userId: profile.userId, enabled: true },
      select: { skill: true },
    });

    // Canonicalised, and deduped after canonicalisation - "nodejs" from a reserve
    // row and "Node.js" from an atom tag are one permission, and the guard compares
    // canonical forms.
    const allowedTech = [
      ...new Set(
        [...atoms.flatMap((a) => a.tech), ...reserve.map((r) => r.skill)]
          .map((tech) => canonicalise(tech.trim()))
          .filter((tech) => tech.length > 0),
      ),
    ];

    const headline = atoms.find((a) => a.kind === AtomKind.ROLE)?.text ?? null;

    return {
      fullName: profile.fullName,
      headline,
      atoms: atoms.map((atom) => ({
        id: atom.id,
        kind: atom.kind,
        text: atom.text,
        tech: atom.tech,
        metrics: atom.metrics,
        employer: atom.employer,
        dateRange: atom.dateRange,
      })),
      allowedTech,
    };
  }

  /**
   * Records the variant.
   *
   * WRITTEN ON FAILURE TOO, with `guardPassed: false` and the full report. That is
   * the point of the row: the guard's failure RATE over time is the drift signal,
   * and a table containing only successes cannot express a rate. The paths on a
   * failed row point at the BASE resume, which is what was actually rendered.
   */
  private async writeVariant(
    profileId: string,
    jobId: string,
    output: TailorOutput,
    report: ProvenanceReport,
    rendered: { docxPath: string; pdfPath: string | null },
    call: { provider: string; model: string },
  ): Promise<string> {
    const variant = await this.prisma.resumeVariant.create({
      data: {
        profileId,
        jobId,
        // The model's raw decision, kept verbatim even when it was rejected - a
        // rejected selection is the evidence for why it was rejected.
        atomSelection: {
          selectedAtomIds: output.selectedAtomIds,
          rewrites: output.rewrites,
          headline: output.headline,
        },
        // Only when it passed. A cover letter that cites an invented figure must not
        // sit in the database where phase 6 would find it and attach it.
        coverLetter: report.passed ? output.coverLetter || null : null,
        docxPath: rendered.docxPath,
        pdfPath: rendered.pdfPath,
        provenanceReport: report as unknown as Prisma.InputJsonValue,
        guardPassed: report.passed,
        llmProvider: call.provider,
        model: call.model,
      },
      select: { id: true },
    });
    return variant.id;
  }
}

function toContact(profile: {
  fullName: string;
  email: string;
  phone: string | null;
  location: string | null;
  linkedIn: string | null;
  github: string | null;
  portfolio: string | null;
}): ResumeContact {
  return {
    fullName: profile.fullName,
    email: profile.email,
    phone: profile.phone,
    location: profile.location,
    linkedIn: profile.linkedIn,
    github: profile.github,
    portfolio: profile.portfolio,
  };
}
