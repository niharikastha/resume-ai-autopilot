/**
 * The matching funnel as a module.
 *
 * Three dependencies and each one is a stage: Prisma reads the postings, embeddings
 * runs stage 2 locally, and LLM_PROVIDER runs stage 3. It imports the TOKEN's module
 * rather than ClaudeProvider, so nothing here knows or can find out which provider is
 * in use - that is the point of the abstraction, and MatchScore.llmProvider is the
 * record of the answer.
 */
import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { LlmModule } from '../llm/llm.module';
import { PrismaModule } from '../prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';
import { MatchingProcessor } from './matching.processor';
import { MatchingScheduler } from './matching.scheduler';
import { MatchingService } from './matching.service';

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    EmbeddingsModule,
    LlmModule,
    QueueModule,
  ],
  providers: [
    MatchingService,
    // Registered in both processes, exactly as DiscoveryModule does it: the processor
    // is inert in the api because BullMQ only pulls work where a worker connection
    // exists, and the scheduler's @Cron self-gates on AUTOPILOT_ROLE.
    MatchingProcessor,
    MatchingScheduler,
  ],
  exports: [MatchingService],
})
export class MatchingModule {}
