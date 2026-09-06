import { Injectable } from '@nestjs/common';
import { ApplicationStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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
        this.prisma.candidateProfile.findFirst({
          where: { userId },
          select: { id: true, label: true, confirmedAt: true, updatedAt: true },
          orderBy: { updatedAt: 'desc' },
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
    if (!answers?.workAuthorization || answers.noticePeriodDays === null) {
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
  async jobs(params: {
    viewerId: string;
    q?: string;
    source?: string;
    tier?: string;
    limit: number;
    offset: number;
  }) {
    const where: Prisma.JobPostingWhereInput = { closedAt: null };
    if (params.q) where.title = { contains: params.q, mode: 'insensitive' };
    if (params.source) where.source = params.source;
    if (params.tier) {
      where.company = { tier: params.tier as never };
    }

    const [total, items] = await Promise.all([
      this.prisma.jobPosting.count({ where }),
      this.prisma.jobPosting.findMany({
        where,
        include: {
          company: { select: { name: true, tier: true, atsType: true } },
          matchScores: {
            where: { userId: params.viewerId },
            orderBy: { scoredAt: 'desc' },
            take: 1,
          },
        },
        // nulls: 'last' is load-bearing. Postgres sorts NULLs FIRST on DESC, so
        // the default would rank every posting whose date we could not parse
        // ABOVE a genuinely fresh one. Most boards omit a post date, so that is
        // the common case, not the edge case.
        //
        // The trailing id is the tiebreak. postedAt and firstSeenAt both tie in
        // bulk - a connector run writes its whole batch on one timestamp - and
        // offset pagination over a non-deterministic order silently repeats
        // rows on one page and skips them on the next.
        orderBy: [
          { postedAt: { sort: 'desc', nulls: 'last' } },
          { firstSeenAt: 'desc' },
          { id: 'desc' },
        ],
        take: params.limit,
        skip: params.offset,
      }),
    ]);

    return { total, items };
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
