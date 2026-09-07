/**
 * The `score` queue's worker.
 *
 * A queue rather than a direct call from the cron, for the reason the discovery
 * processor gives: stage 3 talks to an API over minutes, and BullMQ is what makes that
 * restartable. It matters more here than for discovery, because this is the stage that
 * spends money - a run that dies half way and is retried from the beginning pays twice
 * for the postings it already scored.
 *
 * Which is why the retry policy is narrowed below rather than inherited.
 */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE } from '../queue/queue.module';
import { MatchRunResult, MatchingService } from './matching.service';

/** The payload the scheduler and a future admin trigger both send. */
export interface ScoreJobData {
  /** Which candidate. The scheduler always sets it - see the note there. */
  userId: string;
  /** Stop after stage 2, spending nothing. */
  dryRun?: boolean;
  /** 'cron' for the scheduled run, a user id for a manual one. */
  requestedBy?: string;
}

@Processor(QUEUE.SCORE, {
  /**
   * ONE at a time. Two concurrent runs for the same candidate would score the same
   * postings twice - the MatchScore upsert makes that harmless in the database but not
   * on the bill - and two runs for different candidates would each write the cached
   * prefix rather than one reading the other's, since the prefix is per profile.
   */
  concurrency: 1,
})
export class MatchingProcessor extends WorkerHost {
  private readonly logger = new Logger(MatchingProcessor.name);

  constructor(private readonly matching: MatchingService) {
    super();
  }

  async process(job: Job<ScoreJobData>): Promise<MatchRunResult> {
    const { userId, dryRun, requestedBy } = job.data;

    this.logger.log(
      `matching run starting (job ${job.id}, user ${userId}, requested by ` +
        `${requestedBy ?? 'unknown'}${dryRun ? ', dry run' : ''})`,
    );

    const result = await this.matching.match({ userId, dryRun });

    // The one line worth reading in the queue UI. Both halves are here on purpose:
    // the survivor counts say whether the funnel is behaving, and the score count says
    // whether stage 3 actually ran.
    this.logger.log(
      `matching run done: ${result.considered} considered -> ` +
        `${result.stage1Survivors} screened -> ${result.stage2Survivors} ranked -> ` +
        `${result.scored} scored` +
        (result.scoreFailures > 0 ? `, ${result.scoreFailures} FAILED` : ''),
    );

    // Rethrowing is left to `match` - a processor that swallows its error reports
    // success, so BullMQ never retries and the failure is invisible in the one place
    // someone would look for it.
    return result;
  }
}
