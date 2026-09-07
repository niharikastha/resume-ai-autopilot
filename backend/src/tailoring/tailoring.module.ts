/**
 * Phase 5 as a module.
 *
 * No processor and no scheduler yet, unlike DiscoveryModule and MatchingModule. That
 * is deliberate rather than unfinished: tailoring is the first stage whose output a
 * human is meant to read before anything happens with it, and the QUEUE.TAILOR
 * consumer belongs with the digest that presents it - phase 7, where a run ends by
 * asking rather than by writing files nobody was told about.
 *
 * So this is CLI-only for now, which is also how ProfileModule shipped.
 */
import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { LlmModule } from '../llm/llm.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TailoringService } from './tailoring.service';

@Module({
  imports: [AppConfigModule, PrismaModule, LlmModule],
  providers: [TailoringService],
  exports: [TailoringService],
})
export class TailoringModule {}
