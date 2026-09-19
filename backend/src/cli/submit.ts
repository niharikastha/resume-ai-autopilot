/**
 * The handoff. A real browser opens, forms arrive filled in, and you click submit.
 *
 *   npm run cli -- submit --plan            # what a session would consist of, no browser
 *   npm run cli -- submit
 *   npm run cli -- submit --user me@example.com --limit 3
 *   npm run cli -- submit --job <jobId>     # one posting, for working on an adapter
 *
 * WHAT IT DOES, per application: opens the form, fills everything it is allowed to
 * fill, attaches the tailored PDF, screenshots the result, and then STOPS and waits
 * for you. You read the form, answer whatever it flagged, clear any CAPTCHA, and
 * click submit yourself. There is no submit codepath in this program - see
 * form-page.ts, where that is a property of the types rather than a setting.
 *
 * THEN IT CHECKS WHAT THE PAGE SAYS. Pressing Enter here does not record a
 * submission; it makes the program read the page and look for the employer's own
 * confirmation. No confirmation, no SUBMITTED row - because that row is what stops
 * this system ever offering the role again, and the failure has to fall on the side of
 * offering it twice rather than losing it silently.
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createInterface } from 'node:readline/promises';
import { AppConfigModule } from '../config/config.module';
import { LlmModule } from '../llm/llm.module';
import { PrismaModule } from '../prisma/prisma.module';
import {
  AdapterRegistry,
  boardAdapters,
  GenericAdapter,
} from '../submission/board.adapters';
import { BrowserService } from '../submission/browser.service';
import { LlmFieldResolver } from '../submission/field-resolver';
import {
  SubmissionService,
  type PlannedApplication,
  type PreparedResult,
} from '../submission/submission.service';

/**
 * The same minimal container the other CLI commands build, for the reason
 * cli/discover.ts documents: importing SubmissionModule works today and would start
 * pulling in whatever phase 7 adds to it.
 */
@Module({
  imports: [AppConfigModule, PrismaModule, LlmModule],
  providers: [
    BrowserService,
    LlmFieldResolver,
    {
      provide: AdapterRegistry,
      useFactory: (resolver: LlmFieldResolver) =>
        new AdapterRegistry(
          boardAdapters(),
          new GenericAdapter((fields) => resolver.resolve(fields)),
        ),
      inject: [LlmFieldResolver],
    },
    SubmissionService,
  ],
})
class SubmitCliModule {}

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
  const planOnly = process.argv.includes('--plan');

  const app = await NestFactory.createApplicationContext(SubmitCliModule, {
    logger: ['error', 'warn', 'log'],
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const service = app.get(SubmissionService);
    const plan = await service.plan({
      limit: number('--limit'),
      jobId: flag('--job'),
      profileLabel: flag('--label'),
      ...(await resolveUser(app, flag('--user'))),
    });

    console.log('\n--- this session ---');
    console.log(`ready to prepare : ${plan.items.length}`);
    for (const item of plan.items) {
      console.log(
        `${String(item.score).padStart(3)}  ${item.title} @ ${item.company}` +
          `${item.resumePath ? '' : '   (no tailored file - the form will need a resume by hand)'}`,
      );
    }

    if (plan.skipped.length > 0) {
      console.log(`\nleft out (${plan.skipped.length}):`);
      for (const item of plan.skipped) {
        console.log(`     ${item.title} @ ${item.company} - ${item.reason}`);
      }
    }

    if (plan.items.length === 0) {
      console.log(
        '\nNothing to prepare. Run `npm run cli -- match` and then ' +
          '`npm run cli -- tailor` first.\n',
      );
      return;
    }

    if (planOnly) {
      console.log(
        '\n--plan, so no browser was opened and nothing was claimed.\n',
      );
      return;
    }

    console.log(
      '\nA Chrome window will open. Nothing is ever submitted for you - read each ' +
        'form, finish it, and click submit yourself.\n',
    );

    let submitted = 0;
    let prepared = 0;

    for (const [index, item] of plan.items.entries()) {
      console.log(`\n=== ${index + 1} of ${plan.items.length} ===`);

      let ready: PreparedResult;
      try {
        ready = await service.prepare(plan.userId, item);
      } catch (err) {
        // One form's failure ends that form, not the session. The row is already
        // FAILED with the reason on it.
        console.error(err instanceof Error ? err.message : String(err));
        continue;
      }

      prepared++;
      report(item, ready);

      const answer = (
        await rl.question(
          '\n[Enter] once you have submitted it, [s] skip this one, [q] end the session: ',
        )
      )
        .trim()
        .toLowerCase();

      if (answer === 'q') {
        console.log('stopping. Everything prepared so far is saved.');
        break;
      }
      if (answer === 's') {
        await service.skip(
          ready.applicationId,
          'skipped by hand during the session',
        );
        console.log('marked skipped.');
        continue;
      }

      const result = await service.confirm(
        ready.applicationId,
        await ready.readPageText(),
      );

      if (result.submitted) {
        submitted++;
        console.log(`SUBMITTED - the page said: "${result.confirmationText}"`);
      } else {
        // Said plainly, because the natural reading of "I pressed Enter" is that the
        // program believed you.
        console.log(
          'No confirmation found on the page, so this stays PREPARED rather than ' +
            'SUBMITTED. If you did submit it, the duplicate check will still catch it ' +
            'next time.',
        );
      }
    }

    console.log(`\n--- done ---`);
    console.log(`forms prepared   : ${prepared}`);
    console.log(`confirmed sent   : ${submitted}`);
    console.log(
      `still PREPARED   : ${prepared - submitted}` +
        (prepared - submitted > 0 ? ' (re-offered next session)' : ''),
    );
    console.log('');
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    rl.close();
    await app.close();
  }
}

/** What was filled, what was not, and what is left for the human. */
function report(item: PlannedApplication, ready: PreparedResult): void {
  const { prefill } = ready;
  console.log(`${item.title} @ ${item.company}`);
  console.log(`  ${item.applyUrl}`);
  // A null coverage is a board this system does not fill, and printing "0%" for it
  // would read as a prefill that went wrong rather than one never attempted. The
  // needsHuman lines below say what to do instead.
  console.log(
    ready.coverage === null
      ? '  this board is filled by hand - nothing was typed for you'
      : `  ${prefill.requiredFilled}/${prefill.requiredTotal} required fields filled ` +
          `(${Math.round(ready.coverage * 100)}%)`,
  );

  const filled = prefill.fields.filter((field) => field.outcome === 'filled');
  if (filled.length > 0) {
    console.log(`  filled: ${filled.map((field) => field.label).join(', ')}`);
  }

  if (prefill.needsHuman.length > 0) {
    console.log('  YOU NEED TO:');
    for (const line of prefill.needsHuman) console.log(`    - ${line}`);
  }

  const failed = prefill.fields.filter((field) => field.outcome === 'failed');
  for (const field of failed) {
    console.log(`  ! ${field.label}: ${field.reason}`);
  }

  if (prefill.screenshotPath) console.log(`  ${prefill.screenshotPath}`);
}

/** `--user <email>` to a userId, as in cli/tailor.ts. */
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
