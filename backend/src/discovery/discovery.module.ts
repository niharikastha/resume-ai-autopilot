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
import { LlmModule } from '../llm/llm.module';
import { PrismaModule } from '../prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';
import { CompanyAddController } from './company-add.controller';
import { CompanyAddService } from './company-add.service';
import { CompanyProbeService } from './company-probe.service';
import { DiscoveryProcessor } from './discovery.processor';
import { DiscoveryScheduler } from './discovery.scheduler';
import { DiscoveryService } from './discovery.service';
import { DiscoveryHttpClient } from './http.client';

@Module({
  // LlmModule for the careers-page fallback only: adding a company whose URL is not a
  // board reads the page with a model. Nothing on the nightly path needs it, which is
  // why this module went four phases without the import.
  imports: [ConfigModule, PrismaModule, QueueModule, LlmModule],
  controllers: [CompanyAddController],
  providers: [
    DiscoveryHttpClient,
    DiscoveryService,
    CompanyProbeService,
    CompanyAddService,
    // Registered in both processes. The processor is inert in the api - BullMQ only
    // pulls work where a worker connection exists - and the scheduler's @Cron
    // self-gates on AUTOPILOT_ROLE.
    DiscoveryProcessor,
    DiscoveryScheduler,
  ],
  exports: [
    DiscoveryService,
    CompanyProbeService,
    CompanyAddService,
    DiscoveryHttpClient,
  ],
})
export class DiscoveryModule {}
