/**
 * Hourly, at :20: one sync pass for every connected mailbox.
 *
 * At :20 so it never lands on the hour with discovery, matching and the digest. Worker
 * only, for the reason DigestScheduler gives: AppModule loads in both processes, and a
 * pass run twice would read every message twice. GmailSyncService records failures per
 * mailbox, so nothing here should throw - and a cron that did would only be logged.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { GmailSyncService } from './gmail-sync.service';

@Injectable()
export class GmailScheduler {
  private readonly logger = new Logger(GmailScheduler.name);

  constructor(private readonly gmail: GmailSyncService) {}

  @Cron('20 * * * *', { name: 'gmail-sync', timeZone: 'Asia/Kolkata' })
  async syncHourly(): Promise<void> {
    if (process.env.AUTOPILOT_ROLE !== 'worker') return;
    try {
      await this.gmail.syncAll();
    } catch (err) {
      this.logger.error(
        `gmail sync sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
