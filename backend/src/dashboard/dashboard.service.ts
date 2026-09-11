import { Injectable } from '@nestjs/common';
import { ApplicationStatus, Prisma } from '@prisma/client';
import { loadTargets } from '../config/targets';
import { suitsCandidateSql } from '../matching/relevance.sql';
import { PrismaService } from '../prisma/prisma.service';
import { missingRequiredAnswers, toStatedAnswers } from '../submission/answers';

/**
 * Regexes mirroring the spike's relevance filters, kept in SQL so the funnel is
 * computed over the whole table rather than paged into memory.
 *
 * These are deliberately the SAME definitions the spike measured with, so the
 * dashboard's funnel is comparable to the numbers in PLAN-v2 section 1.
 */
const IN_LOCATION =
  '(india|bengaluru|bangalore|hyderabad|pune|mumbai|delhi|gurgaon|gurugram|noida|chennai|kolkata|bhubaneswar|ahmedabad|jaipur|indore|kochi|coimbatore)';
const ENGINEERING =
  '(engineer|developer|sde|programmer|scientist|full[- ]?stack|backend|back[- ]end)';
const NON_ENGINEERING =
  '(sales|marketing|recruit|talent|people|finance|account|legal|counsel|designer|product manager|program manager|customer success|support|partner|business development|content|intern|internship)';
const TOO_SENIOR =
  '(staff|principal|director|head of|chief|distinguished|fellow|manager)';

/**
 * Which postings a jobs-page query is about.
 *
 * One shape for the posting list and the company list, so a filter added to the page
 * cannot end up applied to one of them and not the other - which would show a count that
 * expands into a different set of rows.
 */
export interface JobScope {
  /** Never optional. The attached match score must be the viewer's own. */
  viewerId: string;
  /** A job TITLE. The company list ignores this and matches names instead. */
  q?: string;
  source?: string;
  tier?: string;
  /** One employer. What a company row expands into. */
  companyId?: string;
  /** The company filter, from the picker at the top of the page. */
  companyIds?: string[];
  /**
   * `suits` applies the targets.yaml screen - engineering roles this candidate could
   * take, in a place they can work. `all` is every open posting, for the "show
   * everything" switch.
   */
  only: 'suits' | 'all';
}

export interface FunnelStage {
  key: string;
  label: string;
  count: number;
  /** What produces this stage, so an empty stage reads as "not built yet"
   *  rather than "broken". */
  phase: string;
}

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * ADMIN overview: the whole machine. Discovery funnel, connector health,
   * company counts, and application state across every account.
   */
  async adminOverview() {
    const [
      companies,
      activeCompanies,
      postings,
      funnel,
      scored,
      applications,
      sourceHealth,
      scoreDistribution,
      lastRun,
    ] = await Promise.all([
      this.prisma.company.count(),
      this.prisma.company.count({ where: { active: true } }),
      this.prisma.jobPosting.count(),
      this.funnel(),
      this.prisma.matchScore.count(),
      this.applicationCounts(),
      this.sourceHealth(),
      this.scoreDistribution(),
      this.prisma.sourceRun.findFirst({ orderBy: { startedAt: 'desc' } }),
    ]);

    return {
      scope: 'admin' as const,
      kpis: {
        companies,
        activeCompanies,
        postings,
        addressable: funnel.find((s) => s.key === 'reachable')?.count ?? 0,
        scored,
        awaitingReview: applications.AWAITING_REVIEW ?? 0,
        prepared: applications.PREPARED ?? 0,
        submitted: applications.SUBMITTED ?? 0,
      },
      funnel,
      applications,
      sourceHealth,
      scoreDistribution,
      lastRun,
    };
  }

  /**
   * USER overview: only this candidate's own progress.
   *
   * Deliberately NOT the admin funnel with a filter applied. A candidate has no
   * use for connector health or board yield, and the discovery total (thousands
   * of postings, almost all irrelevant to them) is actively misleading as a
   * personal metric. So the shape differs, not just the numbers.
   */
  async userOverview(userId: string) {
    const [profile, scored, strong, applications, recent, answers] =
      await Promise.all([
        // The SELECTED resume, falling back to the newest. It has to be the one
        // matching would use, or the card reports on a resume the shortlist below
        // it was not built from.
        this.prisma.candidateProfile.findFirst({
          where: { userId },
          select: {
            id: true,
            label: true,
            isActive: true,
            confirmedAt: true,
            updatedAt: true,
          },
          orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }],
        }),
        this.prisma.matchScore.count({ where: { userId } }),
        this.prisma.matchScore.count({
          where: { userId, verdict: { in: ['STRONG', 'GOOD'] } },
        }),
        this.applicationCounts(userId),
        this.prisma.application.findMany({
          where: { userId },
          include: {
            company: { select: { name: true, tier: true } },
            job: { select: { title: true, location: true, applyUrl: true } },
          },
          orderBy: { updatedAt: 'desc' },
          take: 10,
        }),
        this.prisma.applicationAnswers.findUnique({ where: { userId } }),
      ]);

    // The two things that block the pipeline for this candidate, reported as
    // blockers rather than left for them to infer from empty screens.
    const blockers: { key: string; label: string; phase: string }[] = [];
    if (!profile) {
      blockers.push({
        key: 'no_profile',
        label: 'Upload your resume to get started',
        phase: 'phase 3',
      });
    } else if (!profile.confirmedAt) {
      blockers.push({
        key: 'unconfirmed_profile',
        label: 'Confirm the details read from your resume',
        phase: 'phase 3',
      });
    }
    // The same rule the answers screen marks its own fields with, imported rather
    // than repeated: two readings of "which answers are missing" is a screen that
    // says you are finished while this blocker still says you are not.
    if (missingRequiredAnswers(toStatedAnswers(answers)).length > 0) {
      blockers.push({
        key: 'missing_answers',
        label:
          'Fill your application answers - these are never guessed for you',
        phase: 'phase 6',
      });
    }

    return {
      scope: 'user' as const,
      profile,
      kpis: {
        scored,
        strongMatches: strong,
        awaitingReview: applications.AWAITING_REVIEW ?? 0,
        prepared: applications.PREPARED ?? 0,
        submitted: applications.SUBMITTED ?? 0,
      },
      funnel: await this.userFunnel(userId),
      applications,
      recent,
      blockers,
    };
  }

  /** Per-candidate funnel: scored -> good match -> tailored -> prepared -> sent. */
  private async userFunnel(userId: string): Promise<FunnelStage[]> {
    const [scored, good, tailored, prepared, submitted] = await Promise.all([
      this.prisma.matchScore.count({ where: { userId } }),
      this.prisma.matchScore.count({
        where: { userId, verdict: { in: ['STRONG', 'GOOD'] } },
      }),
      this.prisma.resumeVariant.count({
        where: { guardPassed: true, profile: { userId } },
      }),
      this.prisma.application.count({
        where: { userId, status: ApplicationStatus.PREPARED },
      }),
      this.prisma.application.count({
        where: { userId, status: ApplicationStatus.SUBMITTED },
      }),
    ]);

    return [
      {
        key: 'scored',
        label: 'Scored for you',
        count: scored,
        phase: 'phase 4',
      },
      { key: 'good', label: 'Good match', count: good, phase: 'phase 4' },
      {
        key: 'tailored',
        label: 'Resume tailored',
        count: tailored,
        phase: 'phase 5',
      },
      {
        key: 'prepared',
        label: 'Form filled',
        count: prepared,
        phase: 'phase 6',
      },
      {
        key: 'submitted',
        label: 'Submitted by you',
        count: submitted,
        phase: 'phase 6',
      },
    ];
  }

  /**
   * The discovery funnel. Stages beyond "reachable" depend on phases that are
   * not built yet and legitimately return 0 - the UI labels them by phase so a
   * zero is distinguishable from a failure.
   */
  private async funnel(): Promise<FunnelStage[]> {
    const rows = await this.prisma.$queryRaw<
      {
        discovered: bigint;
        in_india: bigint;
        engineering: bigint;
        reachable: bigint;
      }[]
    >`
      SELECT
        COUNT(*) AS discovered,
        COUNT(*) FILTER (
          WHERE location ~* ${IN_LOCATION}
             OR "remoteType" IN ('REMOTE_INDIA', 'REMOTE_GLOBAL')
        ) AS in_india,
        COUNT(*) FILTER (
          WHERE (location ~* ${IN_LOCATION}
                 OR "remoteType" IN ('REMOTE_INDIA', 'REMOTE_GLOBAL'))
            AND title ~* ${ENGINEERING}
            AND title !~* ${NON_ENGINEERING}
        ) AS engineering,
        COUNT(*) FILTER (
          WHERE (location ~* ${IN_LOCATION}
                 OR "remoteType" IN ('REMOTE_INDIA', 'REMOTE_GLOBAL'))
            AND title ~* ${ENGINEERING}
            AND title !~* ${NON_ENGINEERING}
            AND title !~* ${TOO_SENIOR}
        ) AS reachable
      FROM job_postings
      WHERE "closedAt" IS NULL
    `;

    const r = rows[0];
    const n = (v: bigint | undefined) => Number(v ?? 0n);

    const [tailored, prepared] = await Promise.all([
      this.prisma.resumeVariant.count({ where: { guardPassed: true } }),
      this.prisma.application.count({
        where: { status: ApplicationStatus.PREPARED },
      }),
    ]);

    return [
      {
        key: 'discovered',
        label: 'Discovered',
        count: n(r?.discovered),
        phase: 'phase 1',
      },
      {
        key: 'in_india',
        label: 'India-eligible',
        count: n(r?.in_india),
        phase: 'phase 1',
      },
      {
        key: 'engineering',
        label: 'Engineering',
        count: n(r?.engineering),
        phase: 'phase 4 · stage 1',
      },
      {
        key: 'reachable',
        label: 'At your level',
        count: n(r?.reachable),
        phase: 'phase 4 · stage 1',
      },
      { key: 'tailored', label: 'Tailored', count: tailored, phase: 'phase 5' },
      { key: 'prepared', label: 'Prepared', count: prepared, phase: 'phase 6' },
    ];
  }

  /** userId omitted = every account (admin view); supplied = that account only. */
  private async applicationCounts(
    userId?: string,
  ): Promise<Record<string, number>> {
    const grouped = await this.prisma.application.groupBy({
      by: ['status'],
      where: userId ? { userId } : undefined,
      _count: { _all: true },
    });
    return Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
  }

  /**
   * Per-source health. A connector that silently starts returning zero is the
   * main failure mode of depending on undocumented endpoints, so this is
   * derived from actual run history rather than from config.
   */
  private async sourceHealth() {
    const rows = await this.prisma.$queryRaw<
      {
        source: string;
        boards: bigint;
        postings: bigint;
        last_run: Date | null;
        empty_runs: bigint;
      }[]
    >`
      SELECT
        p.source                              AS source,
        COUNT(DISTINCT p."companyId")         AS boards,
        COUNT(*)                              AS postings,
        MAX(r."startedAt")                    AS last_run,
        COALESCE(SUM(CASE WHEN r."postingsSeen" = 0 THEN 1 ELSE 0 END), 0) AS empty_runs
      FROM job_postings p
      LEFT JOIN source_runs r ON r.source = p.source
      GROUP BY p.source
      ORDER BY postings DESC
    `;

    return rows.map((r) => {
      const postings = Number(r.postings);
      const emptyRuns = Number(r.empty_runs);
      // Three states only. A fourth ("serious") was dropped because it is not
      // distinguishable from "warning" for colour-blind readers at the sizes
      // used here - and every state ships with an icon and a text label anyway.
      const status: 'healthy' | 'degraded' | 'dead' =
        postings === 0 ? 'dead' : emptyRuns > 2 ? 'degraded' : 'healthy';
      return {
        source: r.source,
        boards: Number(r.boards),
        postings,
        lastRun: r.last_run,
        status,
      };
    });
  }

  /** 10-point bins. Empty until phase 4 scores anything. */
  private async scoreDistribution() {
    const rows = await this.prisma.$queryRaw<
      { bucket: number; count: bigint }[]
    >`
      SELECT (score / 10) * 10 AS bucket, COUNT(*) AS count
      FROM match_scores
      GROUP BY bucket
      ORDER BY bucket
    `;
    const byBucket = new Map(
      rows.map((r) => [Number(r.bucket), Number(r.count)]),
    );
    return Array.from({ length: 10 }, (_, i) => ({
      bucket: i * 10,
      label: `${i * 10}-${i * 10 + 9}`,
      count: byBucket.get(i * 10) ?? 0,
    }));
  }

  /**
   * Postings are shared, public data - both roles may browse them.
   *
   * viewerId is NOT optional. The attached match score must be the viewer's own:
   * a plain `include: { matchScores: { take: 1 } }` would hand one candidate
   * another candidate's score and reasons. Requiring the parameter means that
   * leak cannot be reintroduced by forgetting a filter at a call site.
   */
  async jobs(params: JobScope & { limit: number; offset: number }) {
    const scope = Prisma.sql`
      FROM job_postings j
      LEFT JOIN companies c ON c.id = j."companyId"
      WHERE ${this.postingWhere(params)}
    `;

    // Chosen in SQL and hydrated by Prisma, in that order and for one reason: the
    // "suits me" rule is a regex over term lists from targets.yaml, and Prisma's where
    // has no way to express a word boundary. Doing the whole thing in raw SQL instead
    // would mean hand-writing the company and match-score joins and rebuilding the
    // nested shape this returns, which is the shape the jobs page reads.
    //
    // Only `limit` ids come back, so the `IN` list is at most 200 wide however large
    // the table gets.
    const [totals, chosen] = await Promise.all([
      this.prisma.$queryRaw<{ total: bigint }[]>`
        SELECT COUNT(*) AS total ${scope}
      `,
      this.prisma.$queryRaw<{ id: string }[]>`
        SELECT j.id ${scope}
        -- NULLS LAST is load-bearing. Postgres sorts NULLs FIRST on DESC, so the
        -- default would rank every posting whose date we could not parse ABOVE a
        -- genuinely fresh one. Most boards omit a post date, so that is the common
        -- case, not the edge case.
        --
        -- The trailing id is the tiebreak. postedAt and firstSeenAt both tie in bulk -
        -- a connector run writes its whole batch on one timestamp - and offset paging
        -- over a non-deterministic order silently repeats rows on one page and skips
        -- them on the next.
        ORDER BY j."postedAt" DESC NULLS LAST, j."firstSeenAt" DESC, j.id DESC
        LIMIT ${params.limit} OFFSET ${params.offset}
      `,
    ]);

    const order = chosen.map((row) => row.id);
    const rows =
      order.length === 0
        ? []
        : await this.prisma.jobPosting.findMany({
            where: { id: { in: order } },
            include: {
              company: { select: { name: true, tier: true, atsType: true } },
              matchScores: {
                where: { userId: params.viewerId },
                orderBy: { scoredAt: 'desc' },
                take: 1,
              },
            },
          });

    // Re-ordered to match the ids, because `IN` imposes no order and the page would
    // otherwise be sorted by whatever the planner found convenient.
    const byId = new Map(rows.map((row) => [row.id, row]));
    const items = order
      .map((id) => byId.get(id))
      .filter((row): row is (typeof rows)[number] => row !== undefined);

    return { total: Number(totals[0]?.total ?? 0), items };
  }

  /**
   * Which postings are in scope, as a WHERE body over `j` (job_postings) and `c`
   * (companies).
   *
   * SHARED BY THE POSTING LIST AND THE COMPANY LIST, which is the whole point. A company
   * row reading "12 openings for you" that expands into a list built from a different
   * WHERE is the bug this prevents, and it is a bug only findable by counting rows by
   * hand. Returned as the WHERE body rather than a whole FROM..WHERE because the company
   * query has a second join to slot in between them.
   */
  private postingWhere(params: JobScope): Prisma.Sql {
    const ids = params.companyIds?.length
      ? params.companyIds
      : params.companyId
        ? [params.companyId]
        : [];

    const filters = [
      params.q
        ? Prisma.sql`AND j.title ILIKE ${`%${params.q}%`}`
        : Prisma.empty,
      params.source
        ? Prisma.sql`AND j.source = ${params.source}`
        : Prisma.empty,
      ids.length > 0
        ? Prisma.sql`AND j."companyId" IN (${Prisma.join(ids)})`
        : Prisma.empty,
      params.tier
        ? Prisma.sql`AND c.tier::text = ${params.tier}`
        : Prisma.empty,
      // The default. A page whose counts mean "engineering roles you could take in
      // India" is the page somebody asked for; "every posting on the board" is the
      // escape hatch, not the resting state.
      params.only === 'all'
        ? Prisma.empty
        : Prisma.sql`AND (${suitsCandidateSql(loadTargets())})`,
    ];

    return Prisma.sql`j."closedAt" IS NULL ${Prisma.join(filters, ' ')}`;
  }

  /**
   * The employers, each with a count of what is open there and how it scored for you.
   *
   * WHY THIS EXISTS AS A SEPARATE CALL. There are 16,500 open postings across 142
   * companies, and the largest single employer accounts for 900 of them. A flat list
   * paged 50 at a time means the first three pages are one company, which is a browsing
   * experience with no shape - you cannot tell whether you have seen a company yet. The
   * employer is the unit a person actually thinks in, so it is the unit the list is built
   * from, and the postings load only when a company is opened.
   *
   * `openPostings` counts OPEN ones. Prisma's `_count` counts every posting ever seen
   * including the ones the employer has taken down, and it cannot be filtered inside an
   * orderBy - which is why this is raw SQL rather than a findMany. Measured on the real
   * data: Databricks has 1240 postings of which 870 are open, Veeva has 900 of which all
   * 900 are open, so "most openings first" put 870 above 900 and the list visibly
   * contradicted its own numbers.
   *
   * SORTING AND PAGING HAPPEN IN THE SAME PLACE, for the same reason. Sorting by best
   * score in JS would only have reordered the fifty rows the database had already picked,
   * so a company on page 3 with a 90 would never reach page 1 - a sort control that
   * quietly means "sort what you can already see".
   *
   * THE SCORES ARE THE VIEWER'S OWN. The join carries `m."userId" = viewerId`, so the
   * best-match figure is per-candidate and one candidate cannot be shown another's.
   * Interpolated through Prisma.sql, which parameterises rather than concatenates.
   *
   * WHAT `openPostings` COUNTS depends on `only`, and both readings are honest. Under the
   * default it is the openings that suit this candidate, which is what makes the number
   * worth reading: OpenAI's board carries 780 open roles and the reader can apply for a
   * handful of them, so a row promising 780 sends them scrolling through marketing jobs in
   * Tokyo. Under `all` it is every open posting. The expanded list uses the same rule
   * either way, which is the property that matters - the count and the list it opens into
   * can never disagree.
   */
  async companyGroups(params: {
    viewerId: string;
    /** Matches the company NAME here, not a job title. */
    q?: string;
    tier?: string;
    /** The company filter: show only these employers. Empty means all of them. */
    companyIds?: string[];
    only: 'suits' | 'all';
    sort: 'postings' | 'name' | 'score';
    limit: number;
    offset: number;
  }) {
    // The INNER JOIN is what excludes employers with nothing in scope - there is no row
    // worth expanding - and it also guarantees every count below is at least 1. Kept apart
    // from the WHERE because the row query has a second join to slot in between them.
    const from = Prisma.sql`
      FROM companies c
      JOIN job_postings j ON j."companyId" = c.id
    `;
    // `q` is the one filter this does NOT hand to the shared scope: here it means a
    // company name, and there it means a job title.
    const where = Prisma.sql`
      WHERE ${this.postingWhere({ ...params, q: undefined })}
      ${params.q ? Prisma.sql`AND c.name ILIKE ${`%${params.q}%`}` : Prisma.empty}
    `;

    // COUNT(DISTINCT j.id), not COUNT(j.id): the left join below multiplies each posting
    // by however many score rows it has, and a plain count would inflate the openings
    // figure for exactly the companies that have been scored the most.
    const openings = Prisma.sql`COUNT(DISTINCT j.id)`;

    // The name is the last tiebreak on every sort, for the same reason the id is in
    // `jobs`: offset paging over a non-deterministic order repeats rows on one page and
    // skips them on the next, and these counts tie constantly - dozens of companies have
    // exactly one opening.
    const order =
      params.sort === 'name'
        ? Prisma.sql`c.name ASC`
        : params.sort === 'score'
          ? // NULLS LAST, or every company nobody has scored would outrank the good
            // matches: Postgres sorts NULLs first on DESC.
            Prisma.sql`MAX(m.score) DESC NULLS LAST, ${openings} DESC, c.name ASC`
          : Prisma.sql`${openings} DESC, c.name ASC`;

    const [totals, rows] = await Promise.all([
      this.prisma.$queryRaw<{ total: bigint }[]>`
        SELECT COUNT(DISTINCT c.id) AS total ${from} ${where}
      `,
      this.prisma.$queryRaw<
        {
          id: string;
          name: string;
          tier: string;
          atsType: string;
          isAgency: boolean;
          openPostings: bigint;
          scoredForYou: bigint;
          bestScore: number | null;
        }[]
      >`
        SELECT
          c.id,
          c.name,
          c.tier::text              AS "tier",
          c."atsType"::text         AS "atsType",
          c."isAgency",
          ${openings}               AS "openPostings",
          COUNT(DISTINCT m."jobId") AS "scoredForYou",
          MAX(m.score)              AS "bestScore"
        ${from}
        LEFT JOIN match_scores m
          ON m."jobId" = j.id AND m."userId" = ${params.viewerId}
        ${where}
        GROUP BY c.id, c.name, c.tier, c."atsType", c."isAgency"
        ORDER BY ${order}
        LIMIT ${params.limit} OFFSET ${params.offset}
      `,
    ]);

    return {
      total: Number(totals[0]?.total ?? 0),
      // COUNT returns bigint over the wire and JSON.stringify throws on one, so these are
      // narrowed here rather than at the controller.
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        tier: row.tier,
        atsType: row.atsType,
        isAgency: row.isAgency,
        openPostings: Number(row.openPostings),
        scoredForYou: Number(row.scoredForYou),
        /** Null, not 0, when nothing here has been scored - a real 0 would read as
         *  "checked and hopeless" rather than "not looked at yet". MAX over no rows is
         *  already NULL, so this needs no special case. */
        bestScore: row.bestScore,
      })),
    };
  }

  /**
   * Every employer with something open, by name. What the company filter is a list of.
   *
   * Not `companyGroups` with a big limit: the picker needs all 142 names at once so it can
   * be searched in the browser without a request per keystroke, and it needs none of the
   * counts or scores that make that query expensive. Two fields per row is small enough to
   * fetch once and keep.
   *
   * DELIBERATELY NOT NARROWED BY `only`. A picker whose contents change when the "show
   * everything" switch is flipped would remove the company you had just selected, and the
   * selection would silently stop meaning anything.
   */
  async companyNames(): Promise<{ id: string; name: string }[]> {
    return this.prisma.company.findMany({
      where: { postings: { some: { closedAt: null } } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  async companies(limit: number) {
    return this.prisma.company.findMany({
      include: { _count: { select: { postings: true } } },
      orderBy: { name: 'asc' },
      take: limit,
    });
  }

  /**
   * userId is required, and there is no overload that omits it. An admin
   * reviewing the whole system uses adminApplications() explicitly - the choice
   * to cross the account boundary is always written down at the call site.
   */
  async applications(userId: string, status?: ApplicationStatus) {
    return this.prisma.application.findMany({
      where: { userId, ...(status ? { status } : {}) },
      include: {
        company: { select: { name: true, tier: true } },
        job: {
          select: {
            title: true,
            location: true,
            applyUrl: true,
            atsType: true,
          },
        },
        resumeVariant: { select: { pdfPath: true, guardPassed: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  /** Admin-only. Carries the owning account so cross-account rows are labelled,
   *  never silently merged into one undifferentiated list. */
  async adminApplications(status?: ApplicationStatus) {
    return this.prisma.application.findMany({
      where: status ? { status } : undefined,
      include: {
        user: { select: { id: true, name: true, email: true } },
        company: { select: { name: true, tier: true } },
        job: {
          select: {
            title: true,
            location: true,
            applyUrl: true,
            atsType: true,
          },
        },
        resumeVariant: { select: { pdfPath: true, guardPassed: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async runs(limit: number) {
    return this.prisma.sourceRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
  }

  /** Admin-only account list. Never selects passwordHash. */
  async users() {
    return this.prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        active: true,
        // approvedAt is what lets the UI tell a NEW signup apart from a
        // SUSPENDED account - both are inactive, and they need opposite actions.
        approvedAt: true,
        lastLoginAt: true,
        createdAt: true,
        _count: { select: { applications: true, matchScores: true } },
        profiles: { select: { confirmedAt: true }, take: 1 },
      },
      // Inactive first (false sorts before true), so accounts waiting on the
      // admin are at the top of the list rather than buried below the working
      // ones. Someone who signed up should not have to be searched for.
      orderBy: [{ active: 'asc' }, { role: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * Integration status for the admin settings screen.
   *
   * Reports NAME + CONFIGURED ONLY. No value, not even masked - a masked key
   * still leaks length and prefix, and there is no reason for the browser to
   * receive any part of a credential. Editing happens in .env (PLAN-v2 2A.4).
   */
  integrations() {
    const present = (key: string): boolean => {
      const v = process.env[key];
      return typeof v === 'string' && v.trim().length > 0;
    };

    return {
      editableIn: '.env at the repo root - not through this UI, by design',
      items: [
        {
          key: 'ANTHROPIC_API_KEY',
          label: 'Claude (local development provider)',
          configured: present('ANTHROPIC_API_KEY'),
          required: false,
          note: 'Used when LLM_PROVIDER=claude. Not needed on the server.',
        },
        {
          key: 'GOOGLE_API_KEY',
          label: 'Gemini (production provider)',
          configured: present('GOOGLE_API_KEY'),
          required: false,
          note: 'Free tier is what runs the daily job on the server.',
        },
        {
          key: 'TELEGRAM_BOT_TOKEN',
          label: 'Telegram digest',
          configured: present('TELEGRAM_BOT_TOKEN'),
          required: false,
          note: 'Falls back to an email digest if absent.',
        },
        {
          key: 'DISCOVERY_CONTACT_EMAIL',
          label: 'Contact email sent in the User-Agent',
          configured: present('DISCOVERY_CONTACT_EMAIL'),
          required: true,
          note: 'Every outbound request identifies itself honestly. Required.',
        },
        {
          key: 'DATABASE_URL',
          label: 'Postgres',
          configured: present('DATABASE_URL'),
          required: true,
          note: 'Reached over an SSH tunnel in production, never exposed.',
        },
        {
          // REDIS_HOST + REDIS_PORT, not REDIS_URL. This screen checked
          // REDIS_URL, which nothing in the app reads (see config/env.schema),
          // so a perfectly healthy Redis reported as "Not set" on the one
          // screen whose entire job is telling the truth about configuration.
          // A config screen that lies is worse than no config screen.
          //
          // And these two carry schema DEFAULTS, so absence from .env is not a
          // fault - the app boots and connects to localhost:6380. Reporting raw
          // .env presence here would just be the same lie pointing the other
          // way, so this row reports the EFFECTIVE state and says when the
          // fallback is what is in use.
          key: 'REDIS_HOST',
          label: 'Redis (BullMQ)',
          configured: true,
          required: true,
          note:
            present('REDIS_HOST') && present('REDIS_PORT')
              ? 'Queue backend for discovery, scoring and tailoring jobs.'
              : 'Queue backend. Not set in .env, so the schema default localhost:6380 is in use.',
        },
      ],
    };
  }
}
