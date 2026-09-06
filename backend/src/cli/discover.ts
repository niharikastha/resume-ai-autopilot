/**
 * Run a discovery pass by hand.
 *
 *   npm run cli -- discover --dry-run              # fetch and parse, write nothing
 *   npm run cli -- discover --source ashby --limit 3
 *   npm run cli -- discover                        # the real thing, every board
 *
 * The nightly cron enqueues the same pass. This exists because waiting until 06:00
 * to find out whether a connector change works is no way to develop one, and
 * `--dry-run` in particular is how a field-mapping edit gets checked against live
 * data before it is allowed near the table.
 *
 * Builds a MINIMAL container rather than booting AppModule: the full tree brings up
 * the queue, the mailer and the scheduler, so running this would require Redis and
 * would register a cron in a process that exits seconds later. The providers below
 * are the ones a pass actually needs.
 */
import 'reflect-metadata';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppConfigModule } from '../config/config.module';
import { DiscoveryService } from '../discovery/discovery.service';
import { DiscoveryHttpClient } from '../discovery/http.client';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [AppConfigModule, PrismaModule],
  providers: [DiscoveryHttpClient, DiscoveryService],
})
class DiscoverCliModule {}

/** `--source a --source b` and `--source a,b` both work. */
function multi(flag: string): string[] | undefined {
  const values: string[] = [];
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1]) {
      values.push(
        ...argv[i + 1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    }
  }
  return values.length > 0 ? values : undefined;
}

function numberFlag(flag: string): number | undefined {
  const at = process.argv.indexOf(flag);
  if (at === -1 || !process.argv[at + 1]) return undefined;
  const n = Number(process.argv[at + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const sources = multi('--source');
  const companyLimit = numberFlag('--limit');

  // 'log' and above only. The default includes debug from every Nest module, which
  // buries the pass's own output in dependency-injection chatter.
  const app = await NestFactory.createApplicationContext(DiscoverCliModule, {
    logger: ['error', 'warn', 'log'],
  });
  const logger = new Logger('discover');

  try {
    const discovery = app.get(DiscoveryService);
    const summary = await discovery.runAll({ sources, companyLimit, dryRun });

    console.log(
      `\n${dryRun ? 'DRY RUN - nothing was written' : 'pass complete'}\n`,
    );
    console.log('source            boards   seen    new  closed  errors');
    for (const s of summary.sources) {
      console.log(
        `${s.source.padEnd(17)}${String(s.companiesTried).padStart(6)}` +
          `${String(s.postingsSeen).padStart(7)}${String(s.postingsNew).padStart(7)}` +
          `${String(s.postingsClosed).padStart(8)}${String(s.errors).padStart(8)}`,
      );
    }

    const failures = summary.sources.flatMap((s) => s.errorSample);
    if (failures.length > 0) {
      console.log('\nboard failures:');
      for (const line of failures) console.log(`  ${line}`);
    }
    if (summary.skipped.length > 0) {
      console.log('\nskipped:');
      for (const line of summary.skipped) console.log(`  ${line}`);
    }
  } catch (err) {
    // The one error worth spelling out, since it is the likely first run.
    logger.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
