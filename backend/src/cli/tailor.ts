/**
 * Tailor resumes for the current shortlist.
 *
 *   npm run cli -- tailor --dry-run           # real tailoring, real guard, no files
 *   npm run cli -- tailor
 *   npm run cli -- tailor --user me@example.com --limit 3
 *   npm run cli -- tailor --job <jobId> --force
 *
 * UNLIKE `match --dry-run`, THIS DRY RUN COSTS MONEY. It makes the deep-tier calls -
 * it has to, because the thing worth inspecting before writing anything is what the
 * model actually returned and what the guard made of it. What it skips is the
 * filesystem and the ResumeVariant rows. `--limit 1` is the cheap way to look.
 *
 * The number to watch in the output is the guard line. A run where every variant
 * passes is the expected state; a run where several fail the same way is the prompt
 * drifting, and the violations printed underneath say how.
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppConfigModule } from '../config/config.module';
import { LlmModule } from '../llm/llm.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TailoringService } from '../tailoring/tailoring.service';

/**
 * A MINIMAL container, for the reason documented in cli/discover.ts: importing the
 * feature module would pull in the queue and a cron in a process that exits in
 * seconds. TailoringModule happens to have neither today, but listing the provider
 * directly is what keeps that true accidentally rather than by luck.
 */
@Module({
  imports: [AppConfigModule, PrismaModule, LlmModule],
  providers: [TailoringService],
})
class TailorCliModule {}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

function number(name: string): number | undefined {
  const raw = flag(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return Math.floor(value);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const mode = flag('--mode') as 'auto' | 'batch' | 'inline' | undefined;

  if (mode && !['auto', 'batch', 'inline'].includes(mode)) {
    throw new Error(`--mode must be auto, batch or inline, got "${mode}"`);
  }

  const app = await NestFactory.createApplicationContext(TailorCliModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const result = await app.get(TailoringService).tailor({
      profileLabel: flag('--label'),
      limit: number('--limit'),
      jobId: flag('--job'),
      force: process.argv.includes('--force'),
      dryRun,
      mode,
      ...(await resolveUser(app, flag('--user'))),
    });

    console.log('\n--- tailoring ---');
    console.log(`shortlisted        : ${result.shortlisted}`);
    console.log(`tailored           : ${result.tailored}`);
    console.log(`guard passed       : ${result.guardPassed}`);
    console.log(`guard FAILED       : ${result.guardFailed}`);
    if (result.callFailures > 0) {
      console.log(`call failures      : ${result.callFailures}`);
    }

    if (result.guardFailed > 0) {
      // Spelled out rather than left as a count. A guard failure is not an error the
      // candidate needs to fix, it is the system declining to send something - and
      // the resume that WAS rendered for those is the base one.
      console.log(
        `\n${result.guardFailed} variant(s) were discarded and fell back to the ` +
          'base resume. The violations are in the warnings above.',
      );
    }

    for (const item of result.results) {
      console.log(
        `\n${String(item.score).padStart(3)}  ${item.guardPassed ? 'TAILORED' : 'BASE    '} ` +
          `${item.title} @ ${item.company}`,
      );
      const counts = item.report.counts;
      console.log(
        `     ${counts.selected} atoms, ${counts.rewrites} rewrites, ` +
          `${counts.numbersChecked} numbers and ${counts.techTokensChecked} tech ` +
          'tokens checked',
      );
      for (const violation of item.report.violations) {
        console.log(`     ! ${violation.kind}: ${violation.detail}`);
      }
      if (item.docxPath) console.log(`     ${item.docxPath}`);
      if (item.pdfPath) console.log(`     ${item.pdfPath}`);
      else if (item.docxPath) {
        // Said once per item rather than thrown, because the docx is the artifact an
        // ATS reads and a missing pdf only costs the human preview.
        console.log('     (no pdf - LibreOffice unavailable or conversion failed)');
      }
    }

    if (dryRun) {
      console.log(`\n${dryRunSummary(result)}\n`);
      return;
    }

    console.log(
      '\nNothing has been applied to. Submission is phase 6 and is assisted, ' +
        'never automatic.\n',
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

/**
 * What the dry run actually did.
 *
 * Three outcomes, not one. This line used to read "the LLM calls were made and the
 * guard ran" unconditionally, which it printed to a run that shortlisted nothing and
 * to a run whose every call failed - in both cases stating the one thing that had
 * definitely not happened, directly underneath the counts that said so.
 */
function dryRunSummary(result: {
  shortlisted: number;
  tailored: number;
  callFailures: number;
}): string {
  if (result.shortlisted === 0) {
    return 'dry run - no LLM calls were made, because nothing was shortlisted.';
  }
  if (result.tailored === 0) {
    return (
      `dry run - all ${result.callFailures} call(s) failed, so the guard never ran. ` +
      'The warnings above say why; nothing was written either way.'
    );
  }
  return (
    `dry run - ${result.tailored} LLM call(s) were made and the guard ran, but no ` +
    'files and no ResumeVariant rows were written.'
  );
}

/** `--user <email>` to a userId, as in cli/match.ts. */
async function resolveUser(
  app: { get: (token: unknown) => unknown },
  email?: string,
): Promise<{ userId?: string }> {
  if (!email) return {};

  const { PrismaService } = await import('../prisma/prisma.service');
  const prisma = app.get(PrismaService) as InstanceType<typeof PrismaService>;

  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true },
  });

  if (!user) throw new Error(`no user with email ${email}`);
  return { userId: user.id };
}

void main();
