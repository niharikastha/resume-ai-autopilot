/**
 * Account creation, CLI only.
 *
 *   npm run cli -- create-user --email a@b.com --name "A B" --role user
 *
 * The ONLY route that can produce an ADMIN. POST /api/auth/signup is open to
 * anyone, but it hardcodes Role.USER and creates the account switched off
 * pending approval - so the privileged path still requires a shell on the host
 * rather than a session that a phished admin could be talked into using.
 *
 * Accounts created here skip the approval queue, which is correct: whoever can
 * run this command is already fully trusted, and making them then go and approve
 * their own account in the UI would be theatre. They are marked approved rather
 * than merely active, so the admin list can tell them apart from a signup nobody
 * has looked at yet.
 *
 * The password is read from CREATE_USER_PASSWORD or generated and printed once -
 * never passed as an argv flag, because argv is visible to every process on the
 * machine via /proc and lands in shell history.
 */
import 'reflect-metadata';
import { PrismaClient, Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
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
  const name = arg('name')?.trim();
  const roleRaw = (arg('role') ?? 'user').toUpperCase();

  if (!email || !name) {
    console.error(
      'usage: npm run cli -- create-user --email <email> --name <name> [--role admin|user]',
    );
    process.exit(1);
  }
  if (roleRaw !== 'ADMIN' && roleRaw !== 'USER') {
    console.error(`--role must be admin or user, got "${roleRaw}"`);
    process.exit(1);
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    if (await prisma.user.findUnique({ where: { email } })) {
      console.error(`a user with email ${email} already exists`);
      process.exit(1);
    }

    const generated = !process.env.CREATE_USER_PASSWORD;
    const password =
      process.env.CREATE_USER_PASSWORD ?? randomBytes(12).toString('base64url');
    if (password.length < 12) {
      console.error('CREATE_USER_PASSWORD must be at least 12 characters');
      process.exit(1);
    }

    const user = await prisma.user.create({
      data: {
        email,
        name,
        role: roleRaw === 'ADMIN' ? Role.ADMIN : Role.USER,
        active: true,
        approvedAt: new Date(),
        passwordHash: await hashPassword(password),
      },
    });

    console.log(`created ${user.role} ${user.email}`);
    if (generated) {
      console.log(`password: ${password}`);
      console.log('^ shown once. Hand it over on a channel you trust.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main();
