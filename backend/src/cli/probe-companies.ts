/**
 * Find out which ATS a company uses.
 *
 *   npm run cli -- companies:probe --slug acme --slug betacorp
 *   npm run cli -- companies:probe --file slugs.txt
 *   npm run cli -- companies:probe --slug acme --create
 *   npm run cli -- companies:probe --slug acme --recheck
 *
 * Tries each slug against every connector and records the answer in
 * `company_probes`, so a slug is never probed twice. `--create` turns a hit into a
 * Company row; without it the command only looks, because adding a company puts it
 * into the daily fetch and that should be a decision rather than a side effect.
 *
 * A HIT is decided by the RESPONSE BODY, never by the status code - see the note at
 * the top of company-probe.service.ts for why that distinction is load-bearing.
 */
import 'reflect-metadata';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ProbeResult } from '@prisma/client';
import { readFileSync } from 'fs';
import { AppConfigModule } from '../config/config.module';
import { CompanyProbeService } from '../discovery/company-probe.service';
import { DiscoveryHttpClient } from '../discovery/http.client';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [AppConfigModule, PrismaModule],
  providers: [DiscoveryHttpClient, CompanyProbeService],
})
class ProbeCliModule {}

function collectSlugs(): string[] {
  const slugs: string[] = [];
  const argv = process.argv;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--slug' && argv[i + 1]) {
      slugs.push(...argv[i + 1].split(',').map((s) => s.trim()));
    }
    if (argv[i] === '--file' && argv[i + 1]) {
      try {
        slugs.push(
          ...readFileSync(argv[i + 1], 'utf8')
            .split(/[\r\n,]+/)
            // '#' so a slug list can carry notes about why a company is on it.
            .map((s) => s.trim())
            .filter((s) => s && !s.startsWith('#')),
        );
      } catch (err) {
        console.error(
          `could not read ${argv[i + 1]}: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    }
  }

  return [...new Set(slugs.filter(Boolean))];
}

async function main(): Promise<void> {
  const slugs = collectSlugs();
  if (slugs.length === 0) {
    console.error(
      'usage: npm run cli -- companies:probe --slug <slug> [--slug <slug>] ' +
        '[--file <path>] [--create] [--recheck]',
    );
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(ProbeCliModule, {
    logger: ['error', 'warn', 'log'],
  });
  const logger = new Logger('probe');

  try {
    const probe = app.get(CompanyProbeService);
    console.log(
      `probing ${slugs.length} slug(s) against 5 ATSes - this is rate limited, so ` +
        'expect roughly a second per request\n',
    );

    const outcomes = await probe.probeMany(slugs, {
      createCompanies: process.argv.includes('--create'),
      recheck: process.argv.includes('--recheck'),
    });

    const hits = outcomes.filter((o) => o.result === ProbeResult.HIT);

    console.log('\nresults:');
    for (const o of outcomes) {
      const detail =
        o.jobsFound !== null ? `${o.jobsFound} postings` : (o.notes ?? '');
      console.log(
        `  ${o.result.padEnd(18)}${o.atsType.padEnd(16)}${o.slug.padEnd(24)}${detail}`,
      );
    }

    console.log(
      `\n${hits.length} hit(s) from ${outcomes.length} probe(s)` +
        `${process.argv.includes('--create') ? ' - companies created' : ''}`,
    );
    if (hits.length > 0 && !process.argv.includes('--create')) {
      console.log('re-run with --create to add these as companies.');
    }
    // The nothing-happened case, which otherwise reads as a silent success.
    if (outcomes.length === 0) {
      console.log(
        'every slug/ATS pair was already recorded - use --recheck to probe again.',
      );
    }
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
