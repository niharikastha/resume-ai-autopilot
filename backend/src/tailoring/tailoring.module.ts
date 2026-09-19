/**
 * Phase 5 as a module.
 *
 * No processor and no scheduler yet, unlike DiscoveryModule and MatchingModule. That
 * is deliberate rather than unfinished: tailoring is the first stage whose output a
 * human is meant to read before anything happens with it, and the QUEUE.TAILOR
 * consumer belongs with the digest that presents it - phase 7, where a run ends by
 * asking rather than by writing files nobody was told about.
 *
 * So the PIPELINE half is CLI-only, which is also how ProfileModule shipped.
 *
 * THE OTHER HALF IS NOT. `ResumePreviewController` and `TailorController` are the resume
 * studio: the candidate looking at their own document, asking for suggestions on it, and
 * tailoring it to a job description they chose. That is the opposite situation from the
 * one above - a person is sitting there, they asked, and the answer is for them - so it
 * is a screen rather than a queue. It shares every component with the pipeline: one
 * prompt, one provenance guard, one document builder, one renderer.
 */
import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { LlmModule } from '../llm/llm.module';
import { PrismaModule } from '../prisma/prisma.module';
import { OnDemandTailoringService } from './on-demand.service';
import { PreviewService } from './preview.service';
import { ResumeSourceService } from './resume.source';
import { ResumePreviewController, TailorController } from './studio.controller';
import { SuggestionsService } from './suggestions.service';
import { TailoringService } from './tailoring.service';

@Module({
  imports: [AppConfigModule, PrismaModule, LlmModule],
  controllers: [ResumePreviewController, TailorController],
  providers: [
    TailoringService,
    ResumeSourceService,
    PreviewService,
    SuggestionsService,
    OnDemandTailoringService,
  ],
  exports: [TailoringService],
})
export class TailoringModule {}
