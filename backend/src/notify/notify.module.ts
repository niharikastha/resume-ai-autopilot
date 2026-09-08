/**
 * Phase 7: the daily schedule and the notifications.
 *
 * The scheduler is registered in BOTH processes, exactly as DiscoveryModule and
 * MatchingModule do it, and self-gates on AUTOPILOT_ROLE - see digest.scheduler.ts for
 * why that gate matters more here than for the queue-based ones.
 *
 * The controller is registered in both too, and is harmless in the worker: nothing
 * routes HTTP to that process.
 */
import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { MailModule } from '../mail/mail.module';
import { PrismaModule } from '../prisma/prisma.module';
import { DigestController } from './digest.controller';
import { DigestScheduler } from './digest.scheduler';
import { DigestService } from './digest.service';
import { NotifyService } from './notify.service';
import { TelegramService } from './telegram.service';

@Module({
  imports: [AppConfigModule, PrismaModule, MailModule],
  controllers: [DigestController],
  providers: [DigestService, TelegramService, NotifyService, DigestScheduler],
  exports: [DigestService, NotifyService],
})
export class NotifyModule {}
