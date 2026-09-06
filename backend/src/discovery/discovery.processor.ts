/**
 * The `discover` queue's worker.
 *
 * Why a queue at all, when a cron could call DiscoveryService directly: the pass
 * takes minutes, and BullMQ is what makes it restartable and observable. A worker
 * redeployed mid-pass leaves the job on the queue to be picked up rather than losing
 * the run until tomorrow, and a failure is retried with the backoff configured in
 * QueueModule instead of vanishing into a log line.
 */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE } from '../queue/queue.module';
import { DiscoverySummary, DiscoveryService } from './discovery.service';

/** The payload the scheduler and the admin trigger both send. */
export interface DiscoverJobData {
  /** Narrow to named connectors. Absent means all of them. */
  sources?: string[];
  /** Fetch and parse but write nothing. */
  dryRun?: boolean;
  /** Who asked. 'cron' for the scheduled pass, a user id for a manual one. */
  requestedBy?: string;
}

@Processor(QUEUE.DISCOVER, {
  /**
   * ONE at a time. The pass already parallelises internally at
   * FETCH_CONCURRENCY, and letting two passes overlap would double the request
   * rate at every board while both fought to upsert the same rows.
   */
  concurrency: 1,
})
export class DiscoveryProcessor extends WorkerHost {
  private readonly logger = new Logger(DiscoveryProcessor.name);

  constructor(private readonly discovery: DiscoveryService) {
    super();
  }

  async process(job: Job<DiscoverJobData>): Promise<DiscoverySummary> {
    const { sources, dryRun, requestedBy } = job.data ?? {};
    this.logger.log(
      `discovery pass starting (job ${job.id}, requested by ${requestedBy ?? 'unknown'}` +
        `${sources ? `, sources: ${sources.join(',')}` : ''}${dryRun ? ', dry run' : ''})`,
    );

    // Rethrown deliberately, unlike the cron in the scheduler. A processor that
    // swallows its error reports success, so BullMQ never retries and the failure is
    // invisible in the queue - which is the one place someone would look.
    return this.discovery.runAll({ sources, dryRun });
  }
}
