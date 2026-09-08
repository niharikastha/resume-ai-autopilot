/**
 * Set an existing account's password, CLI only.
 *
 *   SET_PASSWORD=... npm run cli -- set-password --email a@b.com
 *   npm run cli -- set-password --email a@b.com          # generates and prints one
 *
 * WHY THIS EXISTS. `create-user` prints a generated password once and never
 * stores it in a recoverable form - passwords are scrypt hashes, so there is no
 * "look it up" - and the self-service route out of that is /forgot-password,
 * which needs SMTP. On a local stack with no SMTP_HOST, MailService correctly
 * fails closed with a 503, and the account is then unreachable: right password
 * forgotten, reset email undeliverable. Recreating the account is not an answer
 * either, because the ingested profile, its atoms and its match scores hang off
 * the user row.
 *
 * So this is the shell-only equivalent of the reset email, and the trust
 * argument is `create-user`'s: whoever can run it already has the host and the
 * database, so requiring them to prove anything further would be theatre.
 *
 * THE PASSWORD IS NEVER AN ARGV FLAG, for the same reason as in create-user:
 * argv is world-readable through /proc on Linux and lands in shell history. It
 * comes from SET_PASSWORD, or is generated here and printed once.
 *
 * EVERY SESSION IS REVOKED. A password change that leaves old refresh-token
 * families alive is not a password change - the usual reason to set a new one is
 * that the old one might be in someone else's hands, and a stolen session
 * outlives the credential it came from. Same reasoning as the replay defence in
 * AuthService.
 */
import 'reflect-metadata';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';
import { config } from 'dotenv';
import { resolve } from 'path';
import { hashPassword } from '../auth/password';

config({ path: resolve(__dirname, '../../../.env') });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const email = arg('email')?.trim().toLowerCase();

  if (!email) {
    console.error(
      'usage: [SET_PASSWORD=<pw>] npm run cli -- set-password --email <email>',
    );
    process.exit(1);
  }

  const generated = !process.env.SET_PASSWORD;
  const password =
    process.env.SET_PASSWORD ?? randomBytes(12).toString('base64url');
  // The same 12-character floor create-user enforces. Checked before the user
  // lookup so a too-short password is rejected without touching the row.
  if (password.length < 12) {
    console.error('SET_PASSWORD must be at least 12 characters');
    process.exit(1);
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, role: true, active: true },
    });
    if (!user) {
      // Named plainly. There is no enumeration concern at a shell prompt, and
      // the alternative - a vague failure - just means typing the address again.
      console.error(`no user with email ${email}`);
      process.exit(1);
    }

    const passwordHash = await hashPassword(password);

    // One transaction: a hash written without the sessions being cleared would
    // leave the old credential's sessions valid, which is the exact thing this
    // command is supposed to end.
    const [, sessions] = await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
      prisma.session.deleteMany({ where: { userId: user.id } }),
    ]);

    console.log(`password set for ${user.role} ${user.email}`);
    console.log(`revoked ${sessions.count} active session(s)`);
    if (!user.active) {
      // Worth saying: signing in will still fail, and the password would look
      // like the reason.
      console.log(
        'NOTE: this account is not active, so it cannot sign in yet. ' +
          'Approve it in /admin/users first.',
      );
    }
    if (generated) {
      console.log(`password: ${password}`);
      console.log('^ shown once. Hand it over on a channel you trust.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main();
