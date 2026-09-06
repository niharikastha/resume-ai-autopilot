/**
 * A discovery pass: fetch every active board, write what came back, and record what
 * happened.
 *
 * THE RULE THIS FILE IS BUILT AROUND: one board must never be able to end the pass.
 * There are dozens of them, they are third-party, and they fail in uncorrelated ways
 * - a 502, a renamed field, an employer who deleted their board. Every failure is
 * caught at the board boundary, counted, and left behind. A pass that fetches 33 of
 * 34 boards is a good pass; a pass that aborts on the first error has thrown away 33
 * boards' worth of work over one company.
 */
import { Injectable, Logger } from '@nestjs/common';
import { AtsType, Company, Prisma, SalarySource } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { jobPostingInput } from '../validation/domain.schema';
import { connectorForAts, CONNECTORS } from './connectors';
import { Connector, RawPosting } from './connectors/types';
import {
  DEMOTED_BOARD_INTERVAL_DAYS,
  EMPTY_RUNS_BEFORE_DEMOTION,
  FETCH_CONCURRENCY,
  MAX_PLAUSIBLE_CLOSURE_RATIO,
} from './discovery.constants';
import { DiscoveryHttpClient, FetchError } from './http.client';
import { normalizeTitle, seniority } from './normalize';
import { createHash } from 'crypto';

/** Per-source totals, matching the columns on `source_runs`. */
export interface SourceOutcome {
  source: string;
  companiesTried: number;
  postingsSeen: number;
  postingsNew: number;
  postingsClosed: number;
  errors: number;
  errorSample: string[];
}

export interface DiscoverySummary {
  startedAt: Date;
  finishedAt: Date;
  sources: SourceOutcome[];
  skipped: string[];
}

/** What `Company.yieldStats` holds. Documented on the model. */
interface YieldStats {
  lastFetchedAt?: string;
  postingsSeen?: number;
  reachableSeen?: number;
  consecutiveEmptyRuns?: number;
}

@Injectable()
export class DiscoveryService {
  private readonly logger = new Logger(DiscoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: DiscoveryHttpClient,
  ) {}

  /**
   * Runs a full pass.
   *
   * `sources` narrows it to named connectors, which is what makes a single
   * misbehaving source debuggable without re-fetching everything. `dryRun` fetches
   * and parses but writes nothing, so a field-mapping change can be checked against
   * live data before it touches the table.
   */
  async runAll(
    options: {
      sources?: string[];
      companyLimit?: number;
      dryRun?: boolean;
    } = {},
  ): Promise<DiscoverySummary> {
    const startedAt = new Date();

    if (!this.http.isConfigured()) {
      // Refused up front rather than one failed request at a time. Without this the
      // pass would dutifully "try" every board and record dozens of identical
      // errors, burying the one fact that matters.
      throw new FetchError(
        'DISCOVERY_CONTACT_EMAIL is not set - refusing to start a discovery pass. ' +
          'Every outbound request carries a contact address so a site operator can ' +
          'reach a human. Set it in .env and restart the worker.',
        null,
      );
    }

    const companies = await this.selectCompanies(
      options.companyLimit,
      options.sources,
    );
    const outcomes: SourceOutcome[] = [];
    const skipped: string[] = [];

    // Grouped by source so the per-host interval applies within a source and the
    // sources themselves run one after another. Interleaving them would put four
    // concurrent requests on four different operators, which sounds gentler but
    // makes the total request rate the sum of all of them.
    const bySource = new Map<Connector, Company[]>();
    for (const company of companies) {
      const connector = connectorForAts(company.atsType);
      if (!connector) {
        skipped.push(`${company.slug}: no connector for ${company.atsType}`);
        continue;
      }
      if (options.sources && !options.sources.includes(connector.source))
        continue;
      const list = bySource.get(connector) ?? [];
      list.push(company);
      bySource.set(connector, list);
    }

    for (const [connector, list] of bySource) {
      const outcome = await this.runSource(
        connector,
        list,
        options.dryRun ?? false,
      );
      outcomes.push(outcome);

      if (!options.dryRun) {
        await this.prisma.sourceRun.create({
          data: {
            source: outcome.source,
            startedAt,
            finishedAt: new Date(),
            companiesTried: outcome.companiesTried,
            postingsSeen: outcome.postingsSeen,
            // Clamped, because `postingsNew <= postingsSeen` is a CHECK constraint
            // and a miscount here would fail the insert and lose the whole record of
            // the run. The counters below cannot currently disagree, but the row
            // that reports on a run is the wrong thing to lose to an off-by-one.
            postingsNew: Math.min(outcome.postingsNew, outcome.postingsSeen),
            errors: outcome.errors,
            errorSample:
              outcome.errorSample.length > 0 ? outcome.errorSample : undefined,
          },
        });
      }
    }

    const finishedAt = new Date();
    const seen = outcomes.reduce((a, o) => a + o.postingsSeen, 0);
    const fresh = outcomes.reduce((a, o) => a + o.postingsNew, 0);
    const failed = outcomes.reduce((a, o) => a + o.errors, 0);
    this.logger.log(
      `discovery pass ${options.dryRun ? '(dry run) ' : ''}finished in ` +
        `${Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000)}s: ` +
        `${seen} postings seen, ${fresh} new, ${failed} board errors`,
    );

    return { startedAt, finishedAt, sources: outcomes, skipped };
  }

  /**
   * The boards worth fetching today.
   *
   * A board that has come back empty EMPTY_RUNS_BEFORE_DEMOTION times in a row drops
   * to a weekly check. That is what lets the company list grow ten-fold without the
   * daily pass growing with it, since most additions to a list like this are boards
   * that never have an Indian engineering role.
   *
   * `sources` is applied HERE rather than after the query, so that `--source ashby
   * --limit 3` means three Ashby boards. Filtering afterwards took the first three
   * companies of any source and then discarded the non-Ashby ones, so the same flags
   * fetched one board and looked like Ashby only had one.
   */
  private async selectCompanies(
    limit?: number,
    sources?: string[],
  ): Promise<Company[]> {
    const atsTypes = sources
      ?.map((source) => CONNECTORS.find((c) => c.source === source)?.atsType)
      .filter((ats): ats is AtsType => ats !== undefined);

    const companies = await this.prisma.company.findMany({
      where: {
        active: true,
        atsToken: { not: null },
        // A named source with no connector yields an empty `in`, which matches
        // nothing - the honest result for `--source nosuchats`.
        atsType: atsTypes ? { in: atsTypes } : { not: AtsType.UNKNOWN },
      },
      orderBy: [{ tier: 'asc' }, { slug: 'asc' }],
      ...(limit ? { take: limit } : {}),
    });

    const now = Date.now();
    return companies.filter((company) => {
      const stats = (company.yieldStats ?? {}) as YieldStats;
      const empties = stats.consecutiveEmptyRuns ?? 0;
      if (empties < EMPTY_RUNS_BEFORE_DEMOTION) return true;

      const last = stats.lastFetchedAt ? Date.parse(stats.lastFetchedAt) : 0;
      const dueAfter = DEMOTED_BOARD_INTERVAL_DAYS * 24 * 3600 * 1000;
      return now - last >= dueAfter;
    });
  }

  /** Every board for one source, at bounded concurrency. */
  private async runSource(
    connector: Connector,
    companies: Company[],
    dryRun: boolean,
  ): Promise<SourceOutcome> {
    const outcome: SourceOutcome = {
      source: connector.source,
      companiesTried: companies.length,
      postingsSeen: 0,
      postingsNew: 0,
      postingsClosed: 0,
      errors: 0,
      errorSample: [],
    };

    const queue = [...companies];

    const worker = async (): Promise<void> => {
      for (;;) {
        const company = queue.shift();
        if (!company) return;

        try {
          const postings = await this.fetchBoard(connector, company.atsToken!);
          outcome.postingsSeen += postings.length;

          if (!dryRun) {
            const written = await this.persist(company, connector, postings);
            outcome.postingsNew += written.created;
            outcome.postingsClosed += written.closed;
            await this.recordYield(company, postings.length);
          }
        } catch (err) {
          outcome.errors++;
          const message = err instanceof Error ? err.message : String(err);
          // Ten is enough to see a pattern; the rest would make errorSample a log
          // file living in a jsonb column.
          if (outcome.errorSample.length < 10) {
            outcome.errorSample.push(`${company.slug}: ${message}`);
          }
          this.logger.warn(`${connector.source}/${company.slug}: ${message}`);
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, worker),
    );

    return outcome;
  }

  /**
   * Every posting on one board, following pagination and hydrating details.
   *
   * The pagination loop is bounded by `totalAvailable` AND by a page cap. A board
   * that reports a total it never reaches - or reports one page's worth forever -
   * would otherwise be an infinite loop holding a worker, and an infinite loop that
   * makes a network request each time around is the worst kind.
   */
  private async fetchBoard(
    connector: Connector,
    token: string,
  ): Promise<RawPosting[]> {
    const label = `${connector.source}/${token}`;
    const collected: RawPosting[] = [];

    const pageSize = connector.pageSize ?? 0;
    const maxPages = pageSize > 0 ? 50 : 1;

    for (let page = 0; page < maxPages; page++) {
      const body = await this.http.fetchJson<unknown>(
        connector.listUrl(token, page * pageSize),
        label,
      );
      const batch = connector.parse(body, token);
      collected.push(...batch);

      if (pageSize === 0) break;
      // Stop on a short page as well as on the declared total: a board whose total
      // is stale still terminates.
      if (batch.length < pageSize) break;
      const total = connector.totalAvailable?.(body) ?? null;
      if (total !== null && collected.length >= total) break;
    }

    if (!connector.detailUrl || !connector.mergeDetail) return collected;

    // The N+1 path, SmartRecruiters only. Sequential on purpose: these all hit one
    // host, and the point of the per-host interval is that we do not send a burst
    // to a single operator just because we have several things to ask them.
    const hydrated: RawPosting[] = [];
    for (const posting of collected) {
      try {
        const detail = await this.http.fetchJson<unknown>(
          connector.detailUrl(posting, token),
          `${label}#${posting.sourceJobId}`,
        );
        hydrated.push(connector.mergeDetail(posting, detail));
      } catch (err) {
        // One posting's detail failing is not the board failing. Dropped rather than
        // stored description-less, since a row with no description is precisely the
        // state this phase exists to remove.
        this.logger.warn(
          `${label}#${posting.sourceJobId}: detail fetch failed, dropping - ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return hydrated;
  }

  /**
   * Writes one board's postings and closes the ones that vanished.
   *
   * Sequential upserts rather than a transaction. A transaction around 500 upserts
   * holds a connection and a write lock for the length of the board, and if it fails
   * at posting 499 the other 498 are lost for no benefit - these rows are
   * independent, so a partial write is a partial success rather than an inconsistent
   * state.
   */
  private async persist(
    company: Company,
    connector: Connector,
    postings: RawPosting[],
  ): Promise<{ created: number; updated: number; closed: number }> {
    let created = 0;
    let updated = 0;

    const seenIds: string[] = [];

    for (const posting of postings) {
      const data = this.toRow(company, connector, posting);
      if (!data) continue;
      seenIds.push(posting.sourceJobId);

      try {
        const adopted = await this.adoptSeedRow(company, connector, data);
        if (adopted) {
          updated++;
          continue;
        }

        const before = await this.prisma.jobPosting.findUnique({
          where: {
            source_sourceJobId: {
              source: connector.source,
              sourceJobId: posting.sourceJobId,
            },
          },
          select: { id: true },
        });

        await this.prisma.jobPosting.upsert({
          where: {
            source_sourceJobId: {
              source: connector.source,
              sourceJobId: posting.sourceJobId,
            },
          },
          create: { ...data, companyId: company.id },
          // firstSeenAt is deliberately absent from the update: it records when WE
          // first saw the posting, and overwriting it on every pass would make every
          // job look like it appeared today.
          //
          // closedAt is reset, because a posting that is back on the board is open
          // again - boards do re-list roles, and leaving it closed would hide a live
          // job forever on the strength of one day's absence.
          update: {
            ...data,
            companyId: company.id,
            closedAt: null,
          },
        });

        if (before) updated++;
        else created++;
      } catch (err) {
        this.logger.warn(
          `${connector.source}/${company.slug}#${posting.sourceJobId}: ` +
            `write failed - ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const closed = await this.closeMissing(company, connector, seenIds);
    return { created, updated, closed };
  }

  /**
   * Converts a leftover seed row into a real one, in place.
   *
   * WHY THIS EXISTS. The seed invented `sourceJobId` as
   * `seed:{company}:{hash(title|location)}` because the spike never captured the
   * ATS's own ids. The real connectors use the ATS id. Those are different values
   * under the same `@@unique([source, sourceJobId])`, so without this method the
   * first real pass would INSERT a second row for every one of the 4,765 postings
   * already in the table - the same job twice, one copy with a description and one
   * without, both live, both scoreable.
   *
   * So the seed row is found by what actually identifies the job - company plus
   * normalized title - and updated to carry the real id and the description. That
   * keeps its `firstSeenAt`, which is a fact worth keeping: it is genuinely when this
   * posting was first observed.
   *
   * Ambiguity is declined. If two seed rows normalize to the same title at one
   * company, there is no way to tell which is which, so neither is adopted and both
   * are left for the closure pass to retire. Guessing here would attach a
   * description to the wrong posting.
   *
   * WHAT ACTUALLY HAPPENED WHEN IT RAN (first real pass, 2026-09-06). 3,679 of the
   * 4,765 seed rows were adopted in place. The other 1,086 hit the ambiguity rule and
   * were closed, with a fresh row inserted for each - Databricks alone lists fourteen
   * open "Solutions Architect" roles in fourteen cities, and they all normalize to the
   * same title. So the cost of declining is a reset `firstSeenAt` on those, and the
   * benefit is that no description was attached to the wrong city's posting. Only 6 of
   * the closures were jobs that had genuinely left their board.
   *
   * That is the whole job of this method, and it is a ONE-TIME migration: once no row
   * has a `seed:` id, every call falls through on the first query.
   */
  private async adoptSeedRow(
    company: Company,
    connector: Connector,
    // Unchecked, not the checked variant: this row carries `companyId` as a scalar,
    // and the checked input's `company` relation object is not something an
    // `update`'s data can accept - so widening the parameter to a union of both is
    // what makes this call fail to typecheck.
    data: Prisma.JobPostingUncheckedCreateInput,
  ): Promise<boolean> {
    const candidates = await this.prisma.jobPosting.findMany({
      where: {
        companyId: company.id,
        source: connector.source,
        sourceJobId: { startsWith: 'seed:' },
        normalizedTitle: data.normalizedTitle,
      },
      select: { id: true },
      take: 2,
    });

    if (candidates.length !== 1) return false;

    try {
      await this.prisma.jobPosting.update({
        where: { id: candidates[0].id },
        data: { ...data, companyId: company.id, closedAt: null },
      });
      return true;
    } catch {
      // The real id already exists as its own row - so this seed row is a duplicate
      // of a posting we have properly. Left alone; the closure pass retires it.
      return false;
    }
  }

  /**
   * Marks postings that were not in this board's response as closed.
   *
   * GUARDED, because a board answering 200 with an empty list is ambiguous from the
   * outside: it looks identical whether the employer filled every role or the ATS had
   * a bad deploy. Closing a posting removes it from scoring and from the digest, so
   * believing a mass disappearance is a decision that silently shrinks the pool. Past
   * MAX_PLAUSIBLE_CLOSURE_RATIO the result is treated as a fault to be logged rather
   * than a fact to be recorded.
   */
  private async closeMissing(
    company: Company,
    connector: Connector,
    seenIds: string[],
  ): Promise<number> {
    const open = await this.prisma.jobPosting.count({
      where: {
        companyId: company.id,
        source: connector.source,
        closedAt: null,
      },
    });
    if (open === 0) return 0;

    // A sentinel rather than an empty array, and the difference is not cosmetic:
    // Prisma renders `notIn: []` as a condition that excludes nothing AND matches
    // nothing useful, so relying on it here makes the empty-response case behave
    // differently from every other case. This value cannot be an ATS id, so `notIn`
    // on it excludes nothing and `missing` comes out as "every open posting" - which
    // is exactly what a board answering with zero jobs claims, and exactly what the
    // ratio guard below is there to disbelieve.
    //
    // (It held a literal NUL byte for one commit's worth of drafting, which made the
    // file read as binary to grep. Hence a name.)
    const notSeen =
      seenIds.length > 0 ? seenIds : ['__no_posting_has_this_id__'];

    const missing = await this.prisma.jobPosting.count({
      where: {
        companyId: company.id,
        source: connector.source,
        closedAt: null,
        sourceJobId: { notIn: notSeen },
      },
    });
    if (missing === 0) return 0;

    if (missing / open > MAX_PLAUSIBLE_CLOSURE_RATIO && open > 5) {
      this.logger.warn(
        `${connector.source}/${company.slug}: ${missing} of ${open} open postings ` +
          `absent from this response - treating as a source fault, not ${missing} ` +
          `closures. Nothing was closed.`,
      );
      return 0;
    }

    const result = await this.prisma.jobPosting.updateMany({
      where: {
        companyId: company.id,
        source: connector.source,
        closedAt: null,
        sourceJobId: { notIn: notSeen },
      },
      data: { closedAt: new Date() },
    });
    return result.count;
  }

  /**
   * A validated row, or null if the posting is not storable.
   *
   * Runs `jobPostingInput` - the same schema the API uses - so a connector cannot
   * write a row that a CHECK constraint would reject. A rejected posting is logged
   * and skipped, never coerced: a connector producing invalid data is a bug to be
   * seen, and patching it up here would hide it.
   *
   * An EMPTY description is stored, not rejected. Two of the 4,804 postings from the
   * first real pass genuinely have no body on the board - Lever returns
   * `description: ''` with no `lists` at all - and that is a true fact about the
   * posting rather than a fetch failure, so the row records it. The consequence
   * belongs downstream: SCORING AND EMBEDDING MUST SKIP `descriptionText = ''`,
   * because there is nothing there to read and an LLM call on it spends money to
   * learn only the title. (A description-less posting that came from a FAILED detail
   * fetch is different, and fetchBoard drops those.)
   */
  private toRow(
    company: Company,
    connector: Connector,
    posting: RawPosting,
  ): Prisma.JobPostingUncheckedCreateInput | null {
    const salary = posting.salary;

    const parsed = jobPostingInput.safeParse({
      source: connector.source,
      sourceJobId: posting.sourceJobId,
      title: posting.title,
      normalizedTitle: normalizeTitle(posting.title),
      descriptionRaw: posting.descriptionRaw,
      descriptionText: posting.descriptionText,
      location: posting.location || null,
      remoteType: posting.remoteType,
      seniority: seniority(posting.title),
      salaryMin: salary?.min ?? null,
      salaryMax: salary?.max ?? null,
      salaryCurrency: salary?.currency ?? null,
      salaryPeriod: salary?.period ?? null,
      // STATED only when there is a figure, which the schema also enforces. An
      // employer's own number is the one salary signal in this system that is not an
      // estimate, so it is worth labelling honestly.
      salarySource: salary ? SalarySource.STATED : SalarySource.UNKNOWN,
      applyUrl: posting.applyUrl,
      postedAt: posting.postedAt,
      contentHash: this.contentHash(posting),
    });

    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      this.logger.warn(
        `${connector.source}/${company.slug}#${posting.sourceJobId} rejected - ${issues}`,
      );
      return null;
    }

    const v = parsed.data;
    return {
      source: v.source,
      sourceJobId: v.sourceJobId,
      title: v.title,
      normalizedTitle: v.normalizedTitle,
      descriptionRaw: v.descriptionRaw,
      descriptionText: v.descriptionText,
      location: v.location ?? null,
      remoteType: v.remoteType,
      seniority: v.seniority ?? null,
      salaryMin: v.salaryMin ?? null,
      salaryMax: v.salaryMax ?? null,
      salaryCurrency: v.salaryCurrency ?? null,
      salaryPeriod: v.salaryPeriod ?? null,
      salarySource: v.salarySource,
      applyUrl: v.applyUrl,
      atsType: connector.atsType,
      postedAt: v.postedAt ?? null,
      contentHash: v.contentHash,
    };
  }

  /**
   * A hash of the parts of a posting that matter if they change.
   *
   * The description is included, which is the whole point: `contentHash` is how a
   * re-scored posting is told from a new one, and an employer who rewrites the
   * requirements has produced a job that needs scoring again even though its title
   * and id did not move. The seed hashed company/title/location only - it had no
   * description to hash.
   */
  private contentHash(posting: RawPosting): string {
    return createHash('sha256')
      .update(
        [
          posting.title.trim(),
          posting.location.trim(),
          posting.descriptionText.trim(),
          posting.salary ? `${posting.salary.min}-${posting.salary.max}` : '',
        ].join('|'),
      )
      .digest('hex');
  }

  /**
   * Updates the board's yield history, which drives the demotion in
   * selectCompanies.
   */
  private async recordYield(company: Company, seen: number): Promise<void> {
    const previous = (company.yieldStats ?? {}) as YieldStats;
    const stats: YieldStats = {
      lastFetchedAt: new Date().toISOString(),
      postingsSeen: seen,
      reachableSeen: previous.reachableSeen ?? 0,
      consecutiveEmptyRuns:
        seen > 0 ? 0 : (previous.consecutiveEmptyRuns ?? 0) + 1,
    };

    await this.prisma.company.update({
      where: { id: company.id },
      data: { yieldStats: stats as Prisma.InputJsonValue },
    });
  }
}
