import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { authPruneFilters } from './auth-retention';

/**
 * Nightly pruning of expired auth rows.
 *
 * Without this the auth tables only ever grow, and faster than they look like
 * they should: the access cookie lives 15 minutes, so an active browser rotates
 * its refresh token roughly four times an hour and EVERY rotation writes a new
 * session row. One person using the app for an eight-hour day leaves behind
 * something like thirty rows. None are reachable afterwards; they accumulate
 * until the table is mostly history.
 *
 * The retention rules live in auth-retention.ts, shared with the `prune-auth`
 * CLI command.
 */
@Injectable()
export class SessionCleanupService {
  private readonly logger = new Logger(SessionCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 03:30 daily. An arbitrary quiet hour - there is nothing to coordinate with
   * yet, but when discovery lands it runs in the morning, so cleanup should not
   * be competing with it for connections.
   */
  @Cron('30 3 * * *', { name: 'auth-cleanup' })
  async run(): Promise<void> {
    // AppModule is loaded by BOTH main.ts and worker.ts, so a @Cron declared
    // here is registered in each process and would otherwise fire twice. These
    // deletes are idempotent so double-running is harmless, but "harmless" is no
    // reason to do the work twice, and the next job added here might not be.
    // worker.ts sets this variable; the api never does.
    if (process.env.AUTOPILOT_ROLE !== 'worker') return;

    try {
      const { sessions, accessTokens, resets } = await this.prune();
      const total = sessions + accessTokens + resets;
      // Silent when there was nothing to do. A nightly "deleted 0 rows" line
      // trains you to ignore this logger, which is where real problems hide.
      if (total > 0) {
        this.logger.log(
          `pruned ${total} expired auth rows (sessions ${sessions}, ` +
            `access tokens ${accessTokens}, password resets ${resets})`,
        );
      }
    } catch (err) {
      // Never rethrow. An unhandled rejection out of a cron callback takes the
      // whole worker down, and losing the pipeline because a cleanup query
      // failed is a far worse outcome than a table staying large.
      this.logger.error(
        `auth cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * The deletes themselves, separate from the schedule so a test or the CLI can
   * drive them directly.
   */
  async prune(now = new Date()): Promise<{
    sessions: number;
    accessTokens: number;
    resets: number;
  }> {
    const where = authPruneFilters(now);

    // Ordered, not concurrent. Deleting a session cascades to its access tokens,
    // so running both at once means two statements racing to remove the same
    // rows.
    const sessions = await this.prisma.session.deleteMany({
      where: where.sessions,
    });
    const accessTokens = await this.prisma.accessToken.deleteMany({
      where: where.accessTokens,
    });
    const resets = await this.prisma.passwordReset.deleteMany({
      where: where.resets,
    });

    return {
      sessions: sessions.count,
      accessTokens: accessTokens.count,
      resets: resets.count,
    };
  }
}
