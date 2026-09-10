/**
 * The matching funnel as the web app sees it: one button to run it, one list to read.
 *
 * MatchingService is the funnel itself and knows nothing about users pressing things.
 * This sits in front of it and answers the two questions a screen has to ask - "is a
 * run happening" and "what came out of the last one" - without either of them being a
 * request that hangs for four minutes.
 *
 * NOTHING HERE SCORES ANYTHING. `run` puts a job on the queue and returns; the work
 * happens in MatchingProcessor, in the worker process. That is not indirection for its
 * own sake: stage 3 talks to an LLM over minutes, and a browser tab that navigates
 * away mid-request must not be able to abandon a paid run half finished.
 */
import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { MatchDecision } from '@prisma/client';
import { Job, Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { QUEUE } from '../queue/queue.module';
import { DECIDABLE } from './decidable';
import { ScoreJobData } from './matching.processor';

/** What a run is doing, in the words the screen uses. */
export type RunState = 'idle' | 'queued' | 'running' | 'done' | 'failed';

export interface MatchRunStatus {
  state: RunState;
  runId: string | null;
  /** Null until the worker picks the job up. */
  startedAt: string | null;
  finishedAt: string | null;
  /**
   * The four numbers of the funnel, once it has finished. Only the scalars are read
   * back: BullMQ stores a job's return value as JSON, and MatchRunResult carries two
   * Maps that survive that trip as `{}`. Reading them here would produce a screen
   * quietly reporting zero rejections.
   */
  counts: {
    considered: number;
    screened: number;
    ranked: number;
    scored: number;
    failures: number;
  } | null;
  /** Present only when `state` is 'failed'. Already a sentence, not a stack. */
  error: string | null;
}

/** One suggestion, with everything the row needs to offer its buttons. */
export interface MatchRow {
  jobId: string;
  title: string;
  company: string;
  companyTier: string;
  location: string | null;
  applyUrl: string;
  remoteType: string;
  postedAt: string | null;
  score: number;
  verdict: string;
  reasons: string[];
  missingSkills: string[];
  /** A string, like every other money figure that crosses this boundary. */
  estimatedSalaryLPA: string | null;
  decision: MatchDecision;
  scoredAt: string;
  /**
   * The tailored resume for this posting, if one has been made.
   *
   * Null is the ordinary state and means the Tailor button should be offered.
   * `guardPassed: false` means a resume was written and thrown away for claiming
   * something the candidate's own resume does not - see TailoringService. The row has
   * to be able to say that, because "nothing happened" and "it was refused" look
   * identical otherwise.
   */
  variant: {
    id: string;
    guardPassed: boolean;
    hasPdf: boolean;
    createdAt: string;
  } | null;
  /** An application already started for this posting. */
  application: { id: string; status: string } | null;
}

/**
 * How many postings are waiting on the candidate, as of right now.
 *
 * Exists so a screen can say "3 waiting" without downloading the list to count it, and
 * more importantly so it can say it TRUTHFULLY. The digest stores its own count at 09:00
 * and a page reading that number tells someone at 4pm to go and decide things they
 * decided at lunch. Counted over DECIDABLE verdicts only, from the same list the digest
 * uses, so the live number and the morning's number mean the same thing.
 */
export interface MatchSummary {
  /** Every scored, still-open posting worth a decision. */
  decidable: number;
  undecided: number;
  wanted: number;
  notWanted: number;
}

@Injectable()
export class MatchesService {
  private readonly logger = new Logger(MatchesService.name);

  constructor(
    @InjectQueue(QUEUE.SCORE) private readonly queue: Queue<ScoreJobData>,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Start a run, or hand back the one already going.
   *
   * Deliberately NOT idempotent by a fixed job id. A stable id would make the button
   * work exactly once - BullMQ keeps a completed job under its id and silently drops a
   * second add - so each press gets its own id and the double-press is caught by
   * looking for live work instead. The processor's concurrency of 1 is the real
   * backstop.
   */
  async run(userId: string): Promise<MatchRunStatus & { started: boolean }> {
    const profile = await this.prisma.candidateProfile.findFirst({
      where: { userId, confirmedAt: { not: null }, isActive: true },
      select: { id: true },
    });

    // Checked here rather than left to the worker. Without a chosen resume the run
    // cannot succeed, and a failure discovered in the worker log is a failure the
    // person who pressed the button never sees.
    if (!profile) {
      throw new BadRequestException(
        'no resume is selected, so there is nothing to match against - add one under Resumes and press "use this one"',
      );
    }

    const live = await this.liveJob(userId);
    if (live) {
      return { ...(await this.describe(live)), started: false };
    }

    const job = await this.queue.add(
      'manual',
      { userId, requestedBy: userId },
      { jobId: `score-manual-${userId}-${Date.now()}` },
    );

    this.logger.log(`${userId} asked for a matching run (job ${job.id})`);
    return { ...(await this.describe(job)), started: true };
  }

  /** The current run, or the last one to finish, or idle before the first ever. */
  async status(userId: string): Promise<MatchRunStatus> {
    const live = await this.liveJob(userId);
    if (live) return this.describe(live);

    const finished = await this.newestJob(userId, ['completed', 'failed']);
    if (finished) return this.describe(finished);

    return {
      state: 'idle',
      runId: null,
      startedAt: null,
      finishedAt: null,
      counts: null,
      error: null,
    };
  }

  /**
   * The decision counts, live.
   *
   * One grouped query rather than four counts. Rows with a verdict outside DECIDABLE are
   * excluded rather than counted and hidden, because a "waiting for you" figure that
   * includes two hundred rejections is a figure nobody can act on.
   */
  async summary(userId: string): Promise<MatchSummary> {
    const groups = await this.prisma.matchScore.groupBy({
      by: ['decision'],
      where: {
        userId,
        verdict: { in: DECIDABLE },
        job: { closedAt: null },
      },
      _count: { _all: true },
    });

    const by = (decision: MatchDecision) =>
      groups.find((group) => group.decision === decision)?._count._all ?? 0;

    const undecided = by(MatchDecision.UNDECIDED);
    const wanted = by(MatchDecision.WANTED);
    const notWanted = by(MatchDecision.NOT_WANTED);

    return {
      decidable: undecided + wanted + notWanted,
      undecided,
      wanted,
      notWanted,
    };
  }

  /**
   * The suggestions, best first.
   *
   * Rejected postings are included unless asked otherwise, because a shortlist that
   * hides its own rejections cannot be checked. The screen filters, not this.
   */
  async list(
    userId: string,
    options: {
      minScore?: number;
      limit?: number;
      decision?: MatchDecision;
    } = {},
  ): Promise<MatchRow[]> {
    const scores = await this.prisma.matchScore.findMany({
      where: {
        userId,
        ...(options.minScore === undefined
          ? {}
          : { score: { gte: options.minScore } }),
        ...(options.decision === undefined
          ? {}
          : { decision: options.decision }),
        // A posting the employer has taken down is not a suggestion.
        job: { closedAt: null },
      },
      orderBy: [{ score: 'desc' }, { scoredAt: 'desc' }],
      take: options.limit ?? 50,
      include: { job: { include: { company: true } } },
    });

    if (scores.length === 0) return [];

    const jobIds = scores.map((score) => score.jobId);

    // Two lookups for the whole page rather than two per row.
    const [variants, applications] = await Promise.all([
      this.prisma.resumeVariant.findMany({
        // Scoped to the SELECTED resume: a variant made from a resume that has since
        // been replaced is not the resume this candidate would send today, and
        // offering it would attach a document built from wording they have edited
        // away. Those rows are deleted with their profile anyway - this is the guard
        // for the case where two resumes are kept.
        where: {
          jobId: { in: jobIds },
          profile: { userId, isActive: true },
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          jobId: true,
          guardPassed: true,
          pdfPath: true,
          createdAt: true,
        },
      }),
      this.prisma.application.findMany({
        where: { userId, jobId: { in: jobIds } },
        select: { id: true, jobId: true, status: true },
      }),
    ]);

    // Newest wins. `variants` is ordered newest-first, so the first one seen for a
    // posting is the one to keep - a re-tailoring should be what the row talks about.
    // Built with a loop rather than `new Map(entries)`, which would keep the LAST
    // duplicate and therefore quietly report the oldest attempt.
    const byJob = new Map<string, (typeof variants)[number]>();
    for (const variant of variants) {
      if (!byJob.has(variant.jobId)) byJob.set(variant.jobId, variant);
    }
    const appByJob = new Map(applications.map((a) => [a.jobId, a]));

    return scores.map((score): MatchRow => {
      const variant = byJob.get(score.jobId);
      const application = appByJob.get(score.jobId);
      return {
        jobId: score.jobId,
        title: score.job.title,
        company: score.job.company?.name ?? 'unknown',
        companyTier: score.job.company?.tier ?? 'UNKNOWN',
        location: score.job.location,
        applyUrl: score.job.applyUrl,
        remoteType: score.job.remoteType,
        postedAt: score.job.postedAt?.toISOString() ?? null,
        score: score.score,
        verdict: score.verdict,
        reasons: score.reasons,
        missingSkills: score.missingSkills,
        estimatedSalaryLPA: score.estimatedSalaryLPA?.toString() ?? null,
        decision: score.decision,
        scoredAt: score.scoredAt.toISOString(),
        variant: variant
          ? {
              id: variant.id,
              guardPassed: variant.guardPassed,
              hasPdf: variant.pdfPath !== null,
              createdAt: variant.createdAt.toISOString(),
            }
          : null,
        application: application
          ? { id: application.id, status: application.status }
          : null,
      };
    });
  }

  /** A waiting or in-progress run for this candidate. */
  private async liveJob(userId: string): Promise<Job<ScoreJobData> | null> {
    return this.newestJob(userId, ['active', 'waiting', 'delayed', 'paused']);
  }

  /**
   * The newest job in these states belonging to this candidate.
   *
   * Scanned rather than looked up by id, because there is no id to look up: runs get a
   * fresh one each time. The window is small - `removeOnComplete` keeps 500 - and this
   * only runs when a screen is open.
   */
  private async newestJob(
    userId: string,
    states: Parameters<Queue['getJobs']>[0],
  ): Promise<Job<ScoreJobData> | null> {
    const jobs = await this.queue.getJobs(states, 0, 200);
    const mine = jobs.filter((job) => job.data?.userId === userId);
    if (mine.length === 0) return null;
    return mine.reduce((newest, job) =>
      (job.timestamp ?? 0) > (newest.timestamp ?? 0) ? job : newest,
    );
  }

  private async describe(job: Job<ScoreJobData>): Promise<MatchRunStatus> {
    const state = await job.getState();
    const result = job.returnvalue as
      | {
          considered?: number;
          stage1Survivors?: number;
          stage2Survivors?: number;
          scored?: number;
          scoreFailures?: number;
        }
      | null
      | undefined;

    return {
      state: this.plainState(state),
      runId: job.id ?? null,
      startedAt: job.processedOn
        ? new Date(job.processedOn).toISOString()
        : null,
      finishedAt: job.finishedOn
        ? new Date(job.finishedOn).toISOString()
        : null,
      counts:
        state === 'completed' && result
          ? {
              considered: result.considered ?? 0,
              screened: result.stage1Survivors ?? 0,
              ranked: result.stage2Survivors ?? 0,
              scored: result.scored ?? 0,
              failures: result.scoreFailures ?? 0,
            }
          : null,
      error: state === 'failed' ? (job.failedReason ?? 'the run failed') : null,
    };
  }

  /**
   * BullMQ's states, reduced to the four a person cares about.
   *
   * 'waiting-children' and 'prioritized' are queued as far as a screen is concerned,
   * and 'unknown' means the job was trimmed out from under us - which is only
   * reachable for a run old enough that reporting it as idle is honest.
   */
  private plainState(state: string): RunState {
    if (state === 'active') return 'running';
    if (state === 'completed') return 'done';
    if (state === 'failed') return 'failed';
    if (state === 'unknown') return 'idle';
    return 'queued';
  }
}
