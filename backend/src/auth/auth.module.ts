import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MailModule } from '../mail/mail.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionCleanupService } from './session-cleanup.service';
import { SessionGuard } from './session.guard';

@Global()
@Module({
  imports: [MailModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    // Prunes expired sessions, access tokens and reset requests nightly. Lives
    // in AuthModule because it owns those tables; it no-ops outside the worker.
    SessionCleanupService,
    // Global, so the default is DENY. A route added later is protected because
    // nobody had to remember to protect it; opting out takes an explicit
    // @Public(). See PLAN-v2 2A.1.
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
  exports: [AuthService, SessionCleanupService],
})
export class AuthModule {}
