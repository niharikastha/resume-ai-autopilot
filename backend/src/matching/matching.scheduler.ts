/**
 * Enqueues the daily matching run, one job per confirmed candidate.
 *
 * 07:00, an hour after the 06:00 discovery pass. The gap is deliberate and it is a
 * guess rather than a measurement: a full pass over ~140 boards took minutes in
 * testing, and an hour is enough slack that a slow morning does not have matching
 * scoring yesterday's postings. When phase 7 builds the digest this should become a
 * proper chain - discovery completing enqueues matching - because a fixed gap is a
 * timing assumption that fails silently the first time discovery takes 70 minutes.
 *
 * ONE JOB PER CANDIDATE, not one job for everyone. MatchingService deliberately
 * refuses to guess which profile to use, and the cached scoring prefix is per profile,
 * so a run is inherently per candidate. Separate jobs also mean one candidate's
 * failure - an unembedded profile, say - does not stop the others.
 */
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { QUEUE } from '../queue/queue.module';
import { ScoreJobData } from './matching.processor';

@Injectable()
export class MatchingScheduler {
  private readonly logger = new Logger(MatchingScheduler.name);

  constructor(
    @InjectQueue(QUEUE.SCORE) private readonly queue: Queue<ScoreJobData>,
    private readonly prisma: PrismaService,
  ) {}

  @Cron('0 7 * * *', { name: 'matching-daily' })
  async enqueueDaily(): Promise<void> {
    // AppModule is loaded by main.ts AND worker.ts, so every @Cron in the tree is
    // registered twice. The fixed jobId below would absorb the duplicate, but the
    // guard is kept for the same reason discovery has it: relying on the id means
    // relying on both processes computing the same date string at the same minute.
    if (process.env.AUTOPILOT_ROLE !== 'worker') return;

    try {
      // SELECTED, not merely confirmed. A candidate holding three confirmed
      // resumes with none chosen is a state `resolveProfile` refuses to guess at,
      // so enqueueing them would put a job on the queue that cannot succeed - and
      // the reason would be buried in a worker log at 07:00 rather than shown on
      // the screen where the choice is made.
      const profiles = await this.prisma.candidateProfile.findMany({
        where: { confirmedAt: { not: null }, isActive: true },
        select: { userId: true },
        distinct: ['userId'],
      });

      if (profiles.length === 0) {
        this.logger.warn(
          'no candidate has a selected resume, so there is nothing to match. ' +
            'Upload one under Resumes in the web app, or run ' +
            '`npm run cli -- profile:ingest <resume>`.',
        );
        return;
      }

      const day = new Date().toISOString().slice(0, 10);

      for (const { userId } of profiles) {
        await this.queue.add(
          'daily',
          { userId, requestedBy: 'cron' },
          // A fixed id per candidate per day. BullMQ drops a duplicate jobId, so a
          // worker restart at 06:59 is harmless - the retry adds the same ids and no
          // second run is created. This is the only thing standing between a restart
          // loop and paying for the same scoring run repeatedly.
          { jobId: `score-${day}-${userId}` },
        );
      }

      this.logger.log(
        `enqueued the daily matching run for ${profiles.length} candidate(s)`,
      );
    } catch (err) {
      // Never rethrow from a cron callback: an unhandled rejection there takes the
      // whole worker down, and losing the worker because Redis blipped is worse than
      // missing one day's matching.
      this.logger.error(
        `could not enqueue the daily matching run: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
