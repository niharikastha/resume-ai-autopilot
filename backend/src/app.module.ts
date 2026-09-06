import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { AppConfigModule } from './config/config.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { HealthController } from './health/health.controller';
import { MailModule } from './mail/mail.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';

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
    ScheduleModule.forRoot(),
    // Phase modules land here as they are built:
    //   LlmModule (2), ProfileModule (3),
    //   MatchingModule (4), TailoringModule (5), ApplyModule (6),
    //   SchedulerModule + NotifyModule (7)
  ],
  controllers: [HealthController],
})
export class AppModule {}
