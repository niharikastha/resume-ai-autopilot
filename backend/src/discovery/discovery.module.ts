/**
 * Phase 1: job discovery.
 *
 * Fetches every active company's job board, stores the postings WITH their
 * descriptions, and records what each run did. Everything downstream - scoring,
 * tailoring, applying - reads `descriptionText`, so this module is what makes the
 * rest of the pipeline possible rather than theoretical.
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';
import { CompanyProbeService } from './company-probe.service';
import { DiscoveryProcessor } from './discovery.processor';
import { DiscoveryScheduler } from './discovery.scheduler';
import { DiscoveryService } from './discovery.service';
import { DiscoveryHttpClient } from './http.client';

@Module({
  imports: [ConfigModule, PrismaModule, QueueModule],
  providers: [
    DiscoveryHttpClient,
    DiscoveryService,
    CompanyProbeService,
    // Registered in both processes. The processor is inert in the api - BullMQ only
    // pulls work where a worker connection exists - and the scheduler's @Cron
    // self-gates on AUTOPILOT_ROLE.
    DiscoveryProcessor,
    DiscoveryScheduler,
  ],
  exports: [DiscoveryService, CompanyProbeService, DiscoveryHttpClient],
})
export class DiscoveryModule {}
