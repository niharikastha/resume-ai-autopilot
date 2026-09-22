import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { AppConfigModule } from './config/config.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { HealthController } from './health/health.controller';
import { MailModule } from './mail/mail.module';
import { MatchingModule } from './matching/matching.module';
import { NotifyModule } from './notify/notify.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProfileModule } from './profile/profile.module';
import { QueueModule } from './queue/queue.module';
import { TailoringModule } from './tailoring/tailoring.module';
import { TrackerModule } from './tracker/tracker.module';

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
    // Phase 3, now with an HTTP surface: the resume library. Imported for its
    // controller - the CLI resolves ProfileService directly and does not need the
    // module to be registered here.
    ProfileModule,
    // The hand-kept tracker. Nothing in the pipeline reads it and it reads nothing back -
    // see the note in tracker.module.ts - so it is imported for its controller alone and
    // the worker never loads it.
    TrackerModule,
    ScheduleModule.forRoot(),
    // Phase 7. The 09:00 IST digest, the in-app copy and its API, and the
    // yes/no the digest collects. Imported here rather than only in the worker
    // because the digest is read over HTTP as well as written by a cron.
    //
    // SubmissionModule (phase 6) is deliberately NOT here. It has no controller
    // and no processor - opening a browser is something a person starts at a
    // desk, so the CLI resolves it directly and the api never loads Playwright.
    NotifyModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
