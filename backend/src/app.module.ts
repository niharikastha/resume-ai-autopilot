import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { AppConfigModule } from './config/config.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { HealthController } from './health/health.controller';
import { MailModule } from './mail/mail.module';
import { MatchingModule } from './matching/matching.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { TailoringModule } from './tailoring/tailoring.module';

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    // AuthModule registers the global SessionGuard, so it must be imported for
    // ANY route to be protected. Removing it does not break the build - it
    // silently opens the whole API.
    AuthModule,
    MailModule,
    QueueModule,
    DashboardModule,
    DiscoveryModule,
    // Phase 4. Brings LlmModule (phase 2) and EmbeddingsModule with it, and
    // registers the 07:00 matching run - an hour after discovery's 06:00 pass.
    //
    // Importing this makes the api and the worker resolve LLM_PROVIDER at boot,
    // which is where the "ANTHROPIC_API_KEY is unset" warning comes from. That is
    // deliberate: the warning belongs at startup, not at 07:00 in a cron log.
    MatchingModule,
    // Phase 5. No processor and no cron of its own - the QUEUE.TAILOR consumer
    // belongs with the digest in phase 7, because a run that ends by writing files
    // nobody was told about is not the handoff this phase is for.
    TailoringModule,
    ScheduleModule.forRoot(),
    // Phase modules land here as they are built:
    //   ProfileModule (3, CLI-only so far),
    //   ApplyModule (6), SchedulerModule + NotifyModule (7)
  ],
  controllers: [HealthController],
})
export class AppModule {}
