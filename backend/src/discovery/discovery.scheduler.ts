/**
 * Enqueues the daily discovery pass.
 *
 * This class only ENQUEUES. The work happens in DiscoveryProcessor, so the cron
 * callback finishes in milliseconds - which matters because a cron that awaits a
 * ten-minute pass is a ten-minute window in which a shutdown loses the run with no
 * record that it started.
 */
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { QUEUE } from '../queue/queue.module';
import { DiscoverJobData } from './discovery.processor';
import { DiscoveryHttpClient } from './http.client';

@Injectable()
export class DiscoveryScheduler {
  private readonly logger = new Logger(DiscoveryScheduler.name);

  constructor(
    @InjectQueue(QUEUE.DISCOVER) private readonly queue: Queue<DiscoverJobData>,
    private readonly http: DiscoveryHttpClient,
  ) {}

  /**
   * 06:00 daily, ahead of the morning digest.
   *
   * Chosen to sit well clear of the 03:30 auth cleanup - the note on that cron
   * anticipated this one landing and asked for exactly this gap.
   */
  @Cron('0 6 * * *', { name: 'discovery-daily' })
  async enqueueDaily(): Promise<void> {
    // AppModule is loaded by main.ts AND worker.ts, so every @Cron in the tree is
    // registered twice. Without this guard the api would enqueue a second identical
    // pass, and unlike the idempotent auth cleanup, two passes means two sets of
    // outbound requests to every board we depend on.
    if (process.env.AUTOPILOT_ROLE !== 'worker') return;

    try {
      if (!this.http.isConfigured()) {
        // Said once a day, plainly, rather than as dozens of failed requests. This is
        // the message that tells you why the dashboard has not moved.
        this.logger.error(
          'skipping the daily discovery pass: DISCOVERY_CONTACT_EMAIL is not set. ' +
            'Outbound job-board requests carry a contact address so a site operator ' +
            'can reach a human. Add it to .env and restart the worker.',
        );
        return;
      }

      await this.queue.add(
        'daily',
        { requestedBy: 'cron' },
        {
          /**
           * A fixed id, so the day's pass cannot be enqueued twice.
           *
           * BullMQ treats a duplicate jobId as already-present and drops the second
           * one. That makes a worker restart at 05:59 harmless - the retry adds the
           * same id and no second pass is created.
           */
          jobId: `discover-${new Date().toISOString().slice(0, 10)}`,
        },
      );
      this.logger.log('enqueued the daily discovery pass');
    } catch (err) {
      // Never rethrow from a cron callback: an unhandled rejection there takes the
      // whole worker down, and losing the worker because Redis blipped is worse than
      // missing one day's discovery.
      this.logger.error(
        `could not enqueue the daily discovery pass: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
