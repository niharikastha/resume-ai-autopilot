/**
 * Ingest a resume into a candidate profile.
 *
 *   npm run cli -- profile:ingest "~/Documents/resume.pdf"
 *   npm run cli -- profile:ingest "resume.pdf" --confirm
 *   npm run cli -- profile:ingest "resume.pdf" --user me@example.com --label senior
 *
 * WITHOUT `--confirm` this parses, prints every atom, and writes nothing. That is
 * not a convenience flag - it is PLAN-v2 phase 3 step 2, the human confirmation
 * gate. Everything downstream inherits these atoms as fact: matching embeds them,
 * tailoring may quote nothing else, and the provenance guard treats them as the
 * definition of what the candidate has done. A wrong atom is not a display bug, it
 * is a false claim on a resume that gets sent to an employer.
 *
 * So read the printout. In particular check that no bullet is cut in half, that
 * the metrics on each bullet are the numbers that bullet actually contains, and
 * that the tech tags are things you would defend in an interview - the tag list is
 * exactly what the model will later be allowed to say you have used.
 *
 * Builds a minimal container rather than AppModule, for the same reason
 * `discover` does: the full tree brings up Redis, the mailer and the scheduler,
 * none of which a one-shot command needs.
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AtomKind } from '@prisma/client';
import { AppConfigModule } from '../config/config.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { ProfileModule } from '../profile/profile.module';
import {
  ProfileIngestError,
  ProfilePreview,
  ProfileService,
} from '../profile/profile.service';
import { ResumeExtractionError } from '../profile/resume.text';

@Module({
  imports: [AppConfigModule, PrismaModule, ProfileModule],
})
class ProfileCliModule {}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

/**
 * The resume path: the first argument that is not a flag or a flag's value.
 *
 * Positional rather than `--file` because the path is the whole point of the
 * command, and because it is the form PLAN-v2 writes it in.
 */
function resumePath(): string | undefined {
  const flagsWithValues = new Set(['--user', '--label']);
  const args = process.argv.slice(3);
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      if (flagsWithValues.has(args[i])) i++;
      continue;
    }
    return args[i];
  }
  return undefined;
}

/** Truncates for display only. The stored text is never shortened. */
function wrap(text: string, width = 92, indent = '      '): string {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join(`\n${indent}`);
}

const KIND_ORDER: AtomKind[] = [
  AtomKind.ROLE,
  AtomKind.BULLET,
  AtomKind.SKILL,
  AtomKind.EDU,
];

function printPreview(preview: ProfilePreview): void {
  const { parsed, counts, techUnion, resumePath: path } = preview;

  console.log(`\nresume: ${path}\n`);
  console.log('CONTACT');
  const field = (label: string, value: string | null): void => {
    console.log(`  ${label.padEnd(10)} ${value ?? '(not found)'}`);
  };
  field('name', parsed.fullName || null);
  field('email', parsed.email);
  field('phone', parsed.phone);
  field('location', parsed.location);
  field('linkedin', parsed.linkedIn);
  field('github', parsed.github);
  field('portfolio', parsed.portfolio);
  if (parsed.headline) {
    // Shown but not stored - there is no column for it, and each tailored resume
    // writes its own headline for the role it targets.
    console.log(`  ${'headline'.padEnd(10)} ${parsed.headline}  (not stored)`);
  }

  console.log(
    `\nATOMS  ${parsed.atoms.length} total - ` +
      KIND_ORDER.map((k) => `${counts[k]} ${k.toLowerCase()}`).join(', '),
  );

  for (const kind of KIND_ORDER) {
    const group = parsed.atoms.filter((a) => a.kind === kind);
    if (group.length === 0) continue;

    console.log(`\n  ${kind}`);
    for (const atom of group) {
      const ordinal = parsed.atoms.indexOf(atom);
      console.log(`  [${String(ordinal).padStart(2)}] ${wrap(atom.text)}`);
      const where = [atom.employer, atom.dateRange].filter(Boolean).join('  |  ');
      if (where) console.log(`       @ ${where}`);
      if (atom.metrics.length > 0) {
        console.log(`       metrics: ${atom.metrics.join(', ')}`);
      }
      if (atom.tech.length > 0) {
        console.log(`       tech:    ${atom.tech.join(', ')}`);
      }
    }
  }

  console.log(
    `\nTECH the model will be allowed to claim (${techUnion.length})\n  ` +
      wrap(techUnion.join(', '), 92, '  '),
  );

  if (parsed.warnings.length > 0) {
    console.log(`\nWARNINGS (${parsed.warnings.length})`);
    for (const warning of parsed.warnings) {
      console.log(`  ! ${wrap(warning, 90, '    ')}`);
    }
  }
}

async function main(): Promise<void> {
  const path = resumePath();
  if (!path) {
    console.error(
      'usage: npm run cli -- profile:ingest "<resume path>" [--user <email>] ' +
        '[--label <name>] [--confirm] [--force]',
    );
    process.exit(1);
  }

  const confirm = process.argv.includes('--confirm');
  const force = process.argv.includes('--force');
  const label = flag('--label') ?? 'primary';

  const app = await NestFactory.createApplicationContext(ProfileCliModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const profiles = app.get(ProfileService);
    const preview = await profiles.preview(path);
    printPreview(preview);

    if (!confirm) {
      console.log(
        '\nNOTHING WAS WRITTEN.\n\n' +
          'Read the atoms above before confirming - they are the only facts the\n' +
          'tailoring step is allowed to use, and every number and technology in a\n' +
          'generated resume is checked against them. If a bullet is split, a metric\n' +
          'is missing, or a tech tag is something you would not defend in an\n' +
          'interview, fix the resume (or paste it into a .txt file and edit that)\n' +
          'and run this again.\n\n' +
          `To write it:  npm run cli -- profile:ingest "${path}" --confirm\n`,
      );
      return;
    }

    // Resolve the user only on the write path, so a dry run works against a file
    // before any account exists.
    const prisma = app.get(PrismaService);
    const email = flag('--user');
    const user = email
      ? await prisma.user.findUnique({ where: { email: email.toLowerCase() } })
      : await singleUser(prisma);

    if (!user) {
      console.error(
        email
          ? `\nno user with email ${email}`
          : '\nmore than one user exists, so --user <email> is required',
      );
      process.exitCode = 1;
      return;
    }
    if (!email) console.log(`\nusing the only account: ${user.email}`);

    const result = await profiles.commit({
      userId: user.id,
      label,
      preview,
      force,
    });

    console.log(
      `\n${result.created ? 'created' : 'updated'} profile "${label}" ` +
        `(${result.profileId})\n` +
        `  atoms:   ${result.atomsCreated} new, ${result.atomsUpdated} unchanged, ` +
        `${result.atomsDeleted} removed\n` +
        `  vectors: ${result.atomsEmbedded} computed, ${result.atomsReused} reused\n` +
        `  confirmed at ${new Date().toISOString()}\n`,
    );
  } catch (err) {
    // These three carry a message written for a human; anything else is a bug and
    // deserves its stack.
    if (
      err instanceof ProfileIngestError ||
      err instanceof ResumeExtractionError
    ) {
      console.error(`\n${err.message}\n`);
    } else {
      console.error(err);
    }
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

/** The only account, if there is exactly one. */
async function singleUser(
  prisma: PrismaService,
): Promise<{ id: string; email: string } | null> {
  const users = await prisma.user.findMany({
    select: { id: true, email: true },
    take: 2,
  });
  return users.length === 1 ? users[0] : null;
}

void main();
