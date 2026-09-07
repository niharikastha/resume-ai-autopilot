/**
 * Turn config/companies.yaml into Company rows.
 *
 *   npm run cli -- companies:sweep --dry-run        # parse and plan, no requests
 *   npm run cli -- companies:sweep                 # probe and create
 *   npm run cli -- companies:sweep --tier T1 --tier T2
 *   npm run cli -- companies:sweep --limit 25       # a slice, to sanity-check first
 *   npm run cli -- companies:sweep --recheck        # re-ask questions already answered
 *
 * PLAN-v2 phase 1b, the priority deliverable. `companies:probe` already probes a
 * list of slugs; what this adds is the TIER, which probing cannot supply because it
 * is a judgement about an employer rather than something a board API reports. Tier is
 * the primary pay signal in this system, so a sweep that created 400 companies with
 * tier UNKNOWN would grow the list and leave the ranking blind.
 *
 * `--create` is not a flag here, unlike on `companies:probe`. Everything in the file
 * was put there deliberately by a human, so a hit is a company - that is the whole
 * point of the file existing. The flag that exists instead is `--dry-run`, which
 * prints the plan and sends nothing.
 *
 * EXPECT THIS TO TAKE A WHILE. Four connectors per slug at the politeness interval,
 * minus the ones already recorded in `company_probes`, and a hit stops the remaining
 * connectors for that slug. Roughly a second per request, so a full 400-company
 * sweep is tens of minutes. It is resumable: every answer is written as it arrives,
 * and a re-run skips what is already known.
 */
import 'reflect-metadata';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AtsType, CompanyTier, ProbeResult } from '@prisma/client';
import { AppConfigModule } from '../config/config.module';
import {
  CompanyFacts,
  CompanyProbeService,
} from '../discovery/company-probe.service';
import {
  CompanyListEntry,
  CompanyListError,
  loadCompanyList,
  tierCounts,
} from '../discovery/company-list';
import { DiscoveryHttpClient } from '../discovery/http.client';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  imports: [AppConfigModule, PrismaModule],
  providers: [DiscoveryHttpClient, CompanyProbeService],
})
class SweepCliModule {}

function numberFlag(name: string): number | undefined {
  const at = process.argv.indexOf(name);
  if (at === -1 || !process.argv[at + 1]) return undefined;
  const n = Number(process.argv[at + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** `--tier T1 --tier t2` and `--tier T1,T2` both work. */
function tierFilter(): Set<CompanyTier> | undefined {
  const wanted: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === '--tier' && process.argv[i + 1]) {
      wanted.push(...process.argv[i + 1].split(',').map((s) => s.trim()));
    }
  }
  if (wanted.length === 0) return undefined;

  const tiers = new Set<CompanyTier>();
  for (const raw of wanted) {
    const prefix = raw.toUpperCase();
    const match = Object.values(CompanyTier).find((t) => t.startsWith(prefix));
    if (!match) {
      console.error(
        `unknown tier "${raw}" - use T1, T2, T3, T4 or a full name like ` +
          'T1_GLOBAL_INDIA_OFFICE',
      );
      process.exit(1);
    }
    tiers.add(match);
  }
  return tiers;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const recheck = process.argv.includes('--recheck');
  const limit = numberFlag('--limit');
  const tiers = tierFilter();

  let entries: CompanyListEntry[];
  try {
    entries = loadCompanyList(flagValue('--file'));
  } catch (err) {
    console.error(
      `\n${err instanceof CompanyListError ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  const counts = tierCounts(entries);
  console.log(
    `\nconfig/companies.yaml: ${entries.length} companies\n` +
      Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([tier, n]) => `  ${tier.padEnd(26)}${n}`)
        .join('\n'),
  );

  let selected = tiers ? entries.filter((e) => tiers.has(e.tier)) : entries;
  if (limit) selected = selected.slice(0, limit);

  const app = await NestFactory.createApplicationContext(SweepCliModule, {
    logger: dryRun ? ['error', 'warn'] : ['error', 'warn', 'log'],
  });
  const logger = new Logger('sweep');

  try {
    const probe = app.get(CompanyProbeService);
    const prisma = app.get(PrismaService);

    // A board this repository has ALREADY found counts as known, exactly like one
    // stated in the YAML. The spike left 34 such rows and `company_probes` is
    // empty, so without this the sweep re-discovers all of them from scratch - four
    // connectors each, against APIs that owe us nothing. Adopting instead costs one
    // query and still applies the tier from the file, which is the part the probe
    // could never have supplied.
    const alreadyFound = new Map(
      (
        await prisma.company.findMany({
          // UNKNOWN, not null: atsType is non-nullable with a default, so "we have
          // not identified this board" is a sentinel value rather than an absence.
          where: {
            slug: { in: selected.map((e) => e.slug) },
            atsType: { not: AtsType.UNKNOWN },
          },
          select: { slug: true, atsType: true, atsToken: true },
        })
      ).map((c) => [c.slug, c]),
    );

    // The two paths through the list. A known board is stated rather than searched
    // for, so it costs no requests at all.
    const known: { entry: CompanyListEntry; atsType: AtsType; token: string }[] = [];
    const toProbe: CompanyListEntry[] = [];
    for (const e of selected) {
      const db = alreadyFound.get(e.slug);
      if (e.atsType && e.token) {
        known.push({ entry: e, atsType: e.atsType, token: e.token });
      } else if (db) {
        // atsToken is nullable and older rows were written before tokens were
        // stored separately, where the slug WAS the token.
        known.push({ entry: e, atsType: db.atsType, token: db.atsToken ?? e.slug });
      } else {
        toProbe.push(e);
      }
    }

    console.log(
      `\nselected ${selected.length}: ${known.length} with a known board ` +
        `(no requests needed), ${toProbe.length} to probe\n`,
    );

    if (dryRun) {
      const where = new Map(
        known.map((k) => [k.entry.slug, `${k.atsType}/${k.token}`]),
      );
      for (const e of selected) {
        console.log(
          `  ${e.slug.padEnd(24)}${e.tier.padEnd(26)}` +
            `${where.get(e.slug) ?? 'probe all connectors'}`,
        );
      }
      console.log('\n--dry-run: nothing was probed and nothing was written.\n');
      return;
    }

    // --- boards already known ------------------------------------------------
    let adopted = 0;
    for (const k of known) {
      const ok = await probe.adoptKnownBoard({
        slug: k.entry.slug,
        atsType: k.atsType,
        token: k.token,
        facts: facts(k.entry),
      });
      if (ok) adopted++;
    }
    if (known.length > 0) {
      console.log(`adopted ${adopted}/${known.length} known board(s)\n`);
    }

    // --- everything else -----------------------------------------------------
    if (toProbe.length > 0) {
      console.log(
        `probing ${toProbe.length} slug(s). Rate limited, resumable, and most will ` +
          'miss - a ~24% hit rate is the expected shape, not a problem.\n',
      );

      const outcomes = await probe.probeMany(
        toProbe.map((e) => e.slug),
        {
          createCompanies: true,
          recheck,
          facts: new Map(toProbe.map((e) => [e.slug, facts(e)])),
        },
      );

      const hits = outcomes.filter((o) => o.result === ProbeResult.HIT);
      const byResult = new Map<ProbeResult, number>();
      for (const o of outcomes) {
        byResult.set(o.result, (byResult.get(o.result) ?? 0) + 1);
      }

      console.log('\nhits:');
      for (const h of hits) {
        console.log(
          `  ${h.slug.padEnd(24)}${h.atsType.padEnd(16)}` +
            `${String(h.jobsFound ?? 0).padStart(4)} postings` +
            `${h.token && h.token !== h.slug ? `   token: ${h.token}` : ''}`,
        );
      }

      console.log(`\n${outcomes.length} probe(s):`);
      for (const [result, n] of [...byResult].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${result.padEnd(20)}${n}`);
      }
      if (outcomes.length === 0) {
        console.log(
          '  every slug/ATS pair in this selection was already recorded - ' +
            'use --recheck to ask again.',
        );
      }
    }

    // --- where the list now stands ------------------------------------------
    const [total, active, byTier] = await Promise.all([
      prisma.company.count(),
      prisma.company.count({ where: { active: true } }),
      prisma.company.groupBy({ by: ['tier'], _count: true }),
    ]);

    console.log(`\ncompanies in the database: ${total} (${active} active)`);
    for (const row of byTier.sort((a, b) => a.tier.localeCompare(b.tier))) {
      console.log(`  ${row.tier.padEnd(26)}${row._count}`);
    }
    console.log(
      '\nRun `npm run cli -- discover` to fetch the new boards, or wait for the ' +
        '06:00 cron.\n',
    );
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

/** The curated facts a probe cannot discover for itself. */
function facts(entry: CompanyListEntry): CompanyFacts {
  return { name: entry.name, tier: entry.tier, isAgency: entry.isAgency };
}

function flagValue(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

void main();
