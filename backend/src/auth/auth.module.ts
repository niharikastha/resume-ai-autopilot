import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { MailModule } from '../mail/mail.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionCleanupService } from './session-cleanup.service';
import { SessionGuard } from './session.guard';

@Global()
@Module({
  imports: [
    MailModule,
    /**
     * Rate limits for the auth surface. See auth.controller.ts for the per-route
     * numbers; this is only the ceiling every unmarked route falls back to.
     *
     * NOT REGISTERED AS AN APP_GUARD, unlike SessionGuard. A global throttle would
     * cover the dashboard's own polling, where the correct limit is "as often as the
     * UI asks" and any number picked here would eventually be wrong in a way that
     * looks like the app being broken. The routes worth limiting are the handful
     * that a stranger can reach without a session, and they are all in one
     * controller.
     *
     * IN-MEMORY STORAGE, which is correct for `instances: 1` in ecosystem.config.js
     * and WRONG the moment the api runs in cluster mode - each worker would keep its
     * own count and the effective limit would multiply by the worker count. Switching
     * to Redis storage is the fix, and Redis is already a dependency.
     *
     * Keyed on `req.ip`, so it depends on TRUST_PROXY being right. Behind a proxy
     * with TRUST_PROXY=0 every caller shares the proxy's address and the first
     * person to fail a login locks out everyone.
     */
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 60 }],
    }),
  ],
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
