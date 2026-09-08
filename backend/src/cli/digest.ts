/**
 * The morning digest, on demand.
 *
 *   npm run cli -- digest                        # build today's and print it
 *   npm run cli -- digest --user me@example.com
 *   npm run cli -- digest --send                 # print it AND email/Telegram it
 *   npm run cli -- digest --all --send           # everybody, exactly as 09:00 does
 *   npm run cli -- digest --send --resend        # mail again, already-mailed or not
 *
 * WITHOUT --send THIS STILL WRITES THE ROW. Building is what produces the digest; the
 * flag only controls whether anybody is told. That is deliberate rather than a missing
 * dry-run: the row is the digest, the email is a copy of it, and a "dry run" that
 * printed different numbers from the ones that get stored would be worth nothing as a
 * test of the 09:00 run.
 *
 * The one thing it does NOT share with the cron is the recipient rule: `--user` will
 * build for anybody, where the scheduler only visits candidates with a selected resume.
 * Use `--all` to exercise that rule too.
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppConfigModule } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { MailModule } from '../mail/mail.module';
import { DigestService } from '../notify/digest.service';
import { digestText } from '../notify/digest.text';
import { NotifyService } from '../notify/notify.service';
import { TelegramService } from '../notify/telegram.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';

/**
 * NotifyModule's providers without NotifyModule, for the reason cli/submit.ts gives:
 * importing the module would also register DigestScheduler, and a CLI process that
 * quietly owned a 09:00 cron is not what `--send` asks for.
 */
@Module({
  imports: [AppConfigModule, PrismaModule, MailModule],
  providers: [DigestService, TelegramService, NotifyService],
})
class DigestCliModule {}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function main(): Promise<void> {
  const send = process.argv.includes('--send');
  const resend = process.argv.includes('--resend');
  const all = process.argv.includes('--all');

  const app = await NestFactory.createApplicationContext(DigestCliModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const digests = app.get(DigestService);
    const notify = app.get(NotifyService);
    const config = app.get<ConfigService<Env, true>>(ConfigService);
    const appUrl = config.get('APP_URL', { infer: true });

    const targets = all
      ? await digests.recipients()
      : [await resolveUser(app, flag('--user'))];

    if (targets.length === 0) {
      console.log(
        'nobody has a selected resume, so there is no digest to build. Upload one ' +
          'under Resumes in the web app, or pass --user.\n',
      );
      return;
    }

    for (const target of targets) {
      console.log(`\n=== ${target.email} ===\n`);

      if (send) {
        const { built, outcome } = await notify.sendFor(target.id, { resend });
        console.log(digestText(built.payload, appUrl));
        console.log('');
        console.log(`email    : ${outcome.email}`);
        console.log(`telegram : ${outcome.telegram}`);
        for (const note of outcome.notes) console.log(`  ${note}`);
      } else {
        const built = await digests.build(target.id);
        console.log(digestText(built.payload, appUrl));
        console.log('');
        console.log(
          `stored as digest ${built.id}. Nothing was emailed - add --send for that.`,
        );
      }
    }

    console.log('');
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

/**
 * `--user <email>` to a user, or the only selected candidate.
 *
 * Refuses to guess between two, as MatchingService and TailoringService do: a digest
 * names the postings somebody is applying for, and mailing one candidate's shortlist to
 * another is not a mistake that announces itself.
 */
async function resolveUser(
  app: { get: (token: unknown) => unknown },
  email?: string,
): Promise<{ id: string; email: string }> {
  const prisma = app.get(PrismaService) as PrismaService;

  if (email) {
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: { id: true, email: true },
    });
    if (!user) throw new Error(`no user with email ${email}`);
    return user;
  }

  const profiles = await prisma.candidateProfile.findMany({
    where: {
      confirmedAt: { not: null },
      isActive: true,
      user: { active: true },
    },
    select: { user: { select: { id: true, email: true } } },
    distinct: ['userId'],
  });

  if (profiles.length === 0) {
    throw new Error(
      'no candidate has a selected resume. Pick one under Resumes in the web app, ' +
        'or pass --user <email>.',
    );
  }
  if (profiles.length > 1) {
    throw new Error(
      `${profiles.length} candidates have a selected resume (` +
        profiles.map((profile) => profile.user.email).join(', ') +
        '). Pass --user, or --all to do every one of them.',
    );
  }
  return profiles[0].user;
}

void main();
