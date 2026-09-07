/**
 * Run the matching funnel and print the shortlist.
 *
 *   npm run cli -- match --dry-run          # stages 1-2 only. No API key, no bill.
 *   npm run cli -- match
 *   npm run cli -- match --user me@example.com --top 10
 *   npm run cli -- match --mode batch       # half price, up to an hour
 *
 * --dry-run IS THE ONE TO REACH FOR FIRST, and not only because stage 3 costs money.
 * The funnel's whole failure mode is silent over-rejection: a rule in
 * config/targets.yaml that is slightly too tight produces a short, plausible
 * shortlist, and a rule that has stopped firing produces a long one. Neither says
 * anything. The dry run prints the per-stage counts and stage 1's rejection histogram,
 * which is what those two look different in.
 *
 * The printout is the tuning instrument. Read the histogram before the shortlist.
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppConfigModule } from '../config/config.module';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { LlmModule } from '../llm/llm.module';
import { MatchingService } from '../matching/matching.service';
import { PrismaModule } from '../prisma/prisma.module';

/**
 * A MINIMAL container, listing MatchingService directly rather than importing
 * MatchingModule - which is what cli/discover.ts does and for the same reason.
 * MatchingModule also registers the BullMQ processor and the @Cron scheduler, so
 * importing it here would make this command require Redis and would register a daily
 * cron inside a process that exits seconds later.
 */
@Module({
  imports: [AppConfigModule, PrismaModule, EmbeddingsModule, LlmModule],
  providers: [MatchingService],
})
class MatchCliModule {}

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
  return value;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const top = number('--top') ?? 20;
  const mode = flag('--mode') as 'auto' | 'batch' | 'inline' | undefined;

  if (mode && !['auto', 'batch', 'inline'].includes(mode)) {
    throw new Error(`--mode must be auto, batch or inline, got "${mode}"`);
  }

  const app = await NestFactory.createApplicationContext(MatchCliModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const result = await app.get(MatchingService).match({
      userId: undefined,
      profileLabel: flag('--label'),
      postingLimit: number('--limit'),
      dryRun,
      mode,
      ...(number('--budget') ? { prunePolicy: { maxSurvivors: number('--budget') } } : {}),
      ...(await resolveUser(app, flag('--user'))),
    });

    console.log('\n--- funnel ---');
    console.log(`open postings considered : ${result.considered}`);
    console.log(`stage 1 survivors        : ${result.stage1Survivors}`);

    // Sorted by count, because the top line of this histogram is the rule doing the
    // most work and that is the one worth being sure about.
    const rejected = Object.entries(result.stage1Rejected).sort(
      (a, b) => b[1] - a[1],
    );
    for (const [reason, count] of rejected) {
      const example = result.stage1Examples.get(
        reason as keyof typeof result.stage1Rejected,
      );
      console.log(
        `  - ${reason.padEnd(22)} ${String(count).padStart(5)}` +
          (example ? `   e.g. ${example}` : ''),
      );
    }

    console.log(`postings embedded        : ${result.embedded}`);
    console.log(
      `stage 2 survivors        : ${result.stage2Survivors} ` +
        `(${result.stage2DroppedFar} too far, ` +
        `${result.stage2DroppedOverBudget} over budget, ` +
        `${result.stage2Unembedded} unembedded)`,
    );
    console.log(`pay gate rejections      : ${result.payGateRejected}`);

    if (dryRun) {
      console.log(
        '\ndry run - stopped before stage 3. Nothing was sent to an LLM and no ' +
          'MatchScore rows were written.\n',
      );
      return;
    }

    console.log(`stage 3 scored           : ${result.scored}`);
    if (result.scoreFailures > 0) {
      // Not silent: an unscored posting is one that will never appear in a digest,
      // and the reason is in the warnings above.
      console.log(
        `stage 3 FAILURES         : ${result.scoreFailures} ` +
          '(see the warnings above - these postings have no score row)',
      );
    }

    if (result.ranked.length === 0) {
      console.log(
        '\nnothing scored. If stage 1 rejected everything, read the histogram ' +
          'above; if stage 3 failed, check ANTHROPIC_API_KEY.\n',
      );
      return;
    }

    console.log(`\n--- top ${Math.min(top, result.ranked.length)} ---\n`);
    for (const match of result.ranked.slice(0, top)) {
      console.log(
        `${String(match.score).padStart(3)}  ${match.verdict.padEnd(10)} ` +
          `${match.tier.padEnd(24)} ${match.title} @ ${match.company}`,
      );
      for (const reason of match.reasons) console.log(`       - ${reason}`);
      if (match.missingSkills.length > 0) {
        console.log(`       missing: ${match.missingSkills.join(', ')}`);
      }
      if (match.estimatedSalaryLPA !== null) {
        console.log(`       estimated: ~${match.estimatedSalaryLPA} LPA (a guess)`);
      }
      console.log(`       ${match.applyUrl}\n`);
    }

    console.log(
      `${result.scored} MatchScore row(s) written. Nothing has been applied to - ` +
        'submission is phase 6 and is assisted, never automatic.\n',
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

/**
 * Turns `--user <email>` into a userId.
 *
 * By email rather than id because an id is not something anyone has to hand, and the
 * error when no user matches is clearer here than a run that silently matched the
 * only other profile in the database.
 */
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
