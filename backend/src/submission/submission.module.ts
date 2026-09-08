/**
 * Phase 6, wired.
 *
 * NO CONTROLLER AND NO QUEUE PROCESSOR, on purpose. There is nothing here for the web
 * app to POST to: a submission session is a human sitting in front of a real browser
 * window on their own machine, and an HTTP endpoint that opened one would be a way to
 * make the server apply for jobs. What the web app gets in phase 7 is the RESULT -
 * which applications are prepared, and how much of each form was filled.
 */
import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { LlmModule } from '../llm/llm.module';
import { PrismaModule } from '../prisma/prisma.module';
import {
  AdapterRegistry,
  boardAdapters,
  GenericAdapter,
} from './board.adapters';
import { BrowserService } from './browser.service';
import { LlmFieldResolver } from './field-resolver';
import { SubmissionService } from './submission.service';

@Module({
  imports: [AppConfigModule, PrismaModule, LlmModule],
  providers: [
    BrowserService,
    LlmFieldResolver,
    {
      // Built by a factory rather than injected as six providers, because the ORDER of
      // the adapter list is load-bearing - specific hosts first, and the generic filler
      // reachable only as the documented fallback. A DI container that resolved them by
      // token would decide that order by accident.
      provide: AdapterRegistry,
      useFactory: (resolver: LlmFieldResolver) =>
        new AdapterRegistry(
          boardAdapters(),
          new GenericAdapter((fields) => resolver.resolve(fields)),
        ),
      inject: [LlmFieldResolver],
    },
    SubmissionService,
  ],
  exports: [SubmissionService, BrowserService],
})
export class SubmissionModule {}
