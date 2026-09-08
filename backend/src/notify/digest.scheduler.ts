/**
 * 09:00 IST, every day: build each candidate's digest and send it.
 *
 * WHY 09:00 AND WHY THAT IS THE END OF THE CHAIN. Discovery runs at 06:00 and matching
 * at 07:00, so by nine the numbers exist and the postings are today's. PLAN-v2 phase 7
 * puts the digest here for a reason that is about the human and not the machine: the
 * candidate reads it on their phone in the morning, rejects what they do not want, and
 * the desktop session that evening opens only the forms they said yes to. Rejecting
 * before the expensive work rather than after it is the whole design.
 *
 * `timeZone` IS SET, and none of the other schedulers set it. Theirs run in the server's
 * local time, which is correct while the server is this laptop and quietly wrong the
 * morning it moves to a cloud region - a digest called "your morning" would arrive at
 * 09:00 UTC, which is 14:30 in India, after the day it describes is half over. The
 * others should follow; this one is pinned now because its name makes a promise about a
 * time of day.
 *
 * ONE DIGEST PER CANDIDATE, and one failure does not stop the others. The loop catches
 * per candidate for the same reason MatchingScheduler enqueues one job each: a broken
 * profile belongs to one person, and everybody else's morning should still arrive.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DigestService } from './digest.service';
import { NotifyService } from './notify.service';

@Injectable()
export class DigestScheduler {
  private readonly logger = new Logger(DigestScheduler.name);

  constructor(
    private readonly digests: DigestService,
    private readonly notify: NotifyService,
  ) {}

  @Cron('0 9 * * *', { name: 'digest-daily', timeZone: 'Asia/Kolkata' })
  async sendDaily(): Promise<void> {
    // AppModule is loaded by main.ts AND worker.ts, so every @Cron in the tree is
    // registered twice. Unlike the queue-based schedulers there is no BullMQ job id
    // here to absorb the duplicate - the upsert on (userId, day) would keep the row
    // single, but both processes would still SEND. Two identical emails at 09:00 is
    // exactly the kind of thing that gets an address marked as spam.
    if (process.env.AUTOPILOT_ROLE !== 'worker') return;

    try {
      const recipients = await this.digests.recipients();
      if (recipients.length === 0) {
        this.logger.warn(
          'no candidate has a selected resume, so there is no digest to send. ' +
            'Upload one under Resumes in the web app.',
        );
        return;
      }

      let sent = 0;
      for (const recipient of recipients) {
        try {
          const { built, outcome } = await this.notify.sendFor(recipient.id);
          sent++;
          this.logger.log(
            `${recipient.email}: ${built.payload.candidate.newMatches} new, ` +
              `${built.payload.candidate.undecided} to review - email ` +
              `${outcome.email}, telegram ${outcome.telegram}`,
          );
        } catch (err) {
          this.logger.error(
            `digest for ${recipient.email} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      this.logger.log(`built ${sent} of ${recipients.length} digest(s)`);
    } catch (err) {
      // Never rethrow from a cron callback. An unhandled rejection here takes the
      // worker down, and losing the worker because Postgres blipped at nine is worse
      // than missing one morning's digest.
      this.logger.error(
        `the daily digest run failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
