/**
 * Prune expired auth rows on demand.
 *
 *   npm run cli -- prune-auth            # show what would go, delete nothing
 *   npm run cli -- prune-auth --apply    # actually delete
 *
 * The same rules the nightly worker job uses, runnable by hand - because the
 * reason these tables look untidy is usually a burst of local testing, and
 * waiting until 03:30 to see the effect is a poor way to work.
 *
 * Defaults to a DRY RUN. A delete against auth tables should have to be asked
 * for out loud, not be what happens when you hit enter to see what the command
 * does.
 *
 * This deliberately does not boot the Nest container: starting AppModule to run
 * three deletes would also bring up the queue, the mailer and the scheduler. It
 * shares the RULES with the nightly job through auth-retention.ts, so there is
 * one definition of which rows are safe to delete rather than two that drift.
 */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { config } from 'dotenv';
import { resolve } from 'path';
import { authPruneFilters } from '../auth/auth-retention';

config({ path: resolve(__dirname, '../../../.env') });

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const now = new Date();

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  const {
    sessions: sessionWhere,
    accessTokens: accessWhere,
    resets: resetWhere,
  } = authPruneFilters(now);

  try {
    const [sessions, accessTokens, resets] = await Promise.all([
      prisma.session.count({ where: sessionWhere }),
      prisma.accessToken.count({ where: accessWhere }),
      prisma.passwordReset.count({ where: resetWhere }),
    ]);
    const total = sessions + accessTokens + resets;

    const [liveSessions, totalSessions] = await Promise.all([
      prisma.session.count({ where: { revokedAt: null } }),
      prisma.session.count(),
    ]);

    console.log(`sessions        ${totalSessions} rows, ${liveSessions} live`);
    console.log(`${apply ? 'deleting' : 'would delete'}:`);
    console.log(`  sessions        ${sessions}`);
    console.log(`  access tokens   ${accessTokens}`);
    console.log(`  password resets ${resets}`);

    if (total === 0) {
      console.log('nothing to prune');
      return;
    }

    if (!apply) {
      console.log('\ndry run - re-run with --apply to delete');
      return;
    }

    // Ordered, not concurrent. Deleting a session cascades to its access
    // tokens, so doing both at once means two statements racing to remove the
    // same rows.
    const s = await prisma.session.deleteMany({ where: sessionWhere });
    const a = await prisma.accessToken.deleteMany({ where: accessWhere });
    const r = await prisma.passwordReset.deleteMany({ where: resetWhere });
    console.log(
      `\ndeleted ${s.count + a.count + r.count} rows ` +
        `(sessions ${s.count}, access tokens ${a.count}, resets ${r.count})`,
    );
    console.log('live sessions are untouched - nobody was signed out.');
  } finally {
    await prisma.$disconnect();
  }
}

void main();
