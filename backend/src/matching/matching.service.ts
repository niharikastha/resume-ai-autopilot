/**
 * The matching funnel: every open posting in, a ranked shortlist out.
 *
 * PLAN-v2 phase 4. Four stages, cheapest first, and the ORDER is the whole design:
 *
 *   1. deterministic screen  - free, drops ~90%, config/targets.yaml
 *   2. vector prefilter      - local embeddings, no API, orders and caps the rest
 *   3. LLM score             - the only stage that costs money
 *   4. pay gate and ranking  - tier is the pay signal, score leads the sort
 *
 * WHY EVERY STAGE LOGS ITS SURVIVOR COUNT. A funnel is unobservable from its output.
 * "Three matches today" is consistent with a working system in a quiet week and with
 * a rule that has silently started rejecting everything, and those have opposite
 * fixes. The per-stage counts plus stage 1's reason histogram are how the difference
 * is read, so they are part of the deliverable rather than debug output.
 *
 * ONE DELIBERATE DEVIATION FROM THE PLAN'S ORDERING. The stated-pay-below-floor gate
 * is applied BEFORE stage 3, not after. It is fully deterministic - it reads columns
 * the employer filled in - so scoring a posting that the gate will reject regardless
 * spends money to learn nothing. The ranking half of stage 4 stays where the plan puts
 * it, because it needs the scores. In practice this changes almost nothing (the gate
 * fires on ~0.3% of Indian postings, per PLAN-v2 change 2) which is exactly why it is
 * safe to move.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CompanyTier,
  Prisma,
  SalaryPeriod,
  SalarySource,
} from '@prisma/client';
import { Targets, loadTargets } from '../config/targets';
import {
  EmbeddingsService,
  toVectorLiteral,
} from '../embeddings/embeddings.service';
import { LLM_PROVIDER, LlmProvider } from '../llm/llm.types';
import {
  ScoreJobInput,
  ScoreJobOutput,
  ScoreJobShared,
  scoreJobTask,
} from '../llm/tasks/score-job.task';
import { PrismaService } from '../prisma/prisma.service';
import {
  RejectHistogram,
  RejectReason,
  ScreenablePosting,
  screenAll,
} from './stage1.screen';
import {
  DEFAULT_PRUNE,
  PrunePolicy,
  Ranked,
  postingEmbeddingText,
  prune,
} from './stage2.vector';
import { PayFacts, payGate, rankBy } from './stage4.pay';

/** A posting as the funnel carries it: stage 1's fields plus what stages 2-4 need. */
type Candidate = ScreenablePosting &
  PayFacts & {
    companyId: string | null;
    companyName: string;
    tier: CompanyTier;
    contentHash: string;
    embeddedContentHash: string | null;
    applyUrl: string;
  };

export interface MatchRunOptions {
  /** Which candidate to match for. Defaults to the only confirmed profile. */
  userId?: string;
  profileLabel?: string;
  /** Cap on postings read from the table. For a fast smoke run, not for production. */
  postingLimit?: number;
  /** Stop after stage 2 and report what WOULD be scored. The affordance that makes
   *  the funnel inspectable without an API key or a bill. */
  dryRun?: boolean;
  prunePolicy?: Partial<PrunePolicy>;
  /** Forwarded to the provider: 'inline' is immediate, 'batch' is half price and
   *  slow, 'auto' decides by volume. */
  mode?: 'auto' | 'batch' | 'inline';
}

export interface MatchRunResult {
  profileId: string;
  considered: number;
  stage1Survivors: number;
  stage1Rejected: RejectHistogram;
  stage1Examples: Map<RejectReason, string>;
  embedded: number;
  stage2Survivors: number;
  stage2DroppedFar: number;
  stage2DroppedOverBudget: number;
  stage2Unembedded: number;
  payGateRejected: number;
  scored: number;
  scoreFailures: number;
  /** Best first, per `rankBy`. */
  ranked: {
    jobId: string;
    title: string;
    company: string;
    tier: CompanyTier;
    score: number;
    verdict: string;
    reasons: string[];
    missingSkills: string[];
    estimatedSalaryLPA: number | null;
    vectorDistance: number | null;
    applyUrl: string;
  }[];
}

export class MatchingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MatchingError';
  }
}

@Injectable()
export class MatchingService {
  private readonly logger = new Logger(MatchingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: EmbeddingsService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
  ) {}

  async match(options: MatchRunOptions = {}): Promise<MatchRunResult> {
    const targets = loadTargets();
    const profile = await this.resolveProfile(options);

    const postings = await this.loadCandidates(options.postingLimit);
    this.logger.log(
      `stage 0: ${postings.length} open posting(s) with a description`,
    );

    // ---- STAGE 1 -----------------------------------------------------------
    const applied = await this.appliedJobIds(profile.userId);
    const stage1 = screenAll(postings, targets, {
      now: new Date(),
      appliedJobIds: applied,
    });

    this.logger.log(
      `stage 1: ${stage1.survivors.length}/${postings.length} survived the ` +
        'deterministic screen',
    );
    for (const [reason, count] of Object.entries(stage1.rejected).sort(
      (a, b) => b[1] - a[1],
    )) {
      this.logger.log(
        `  ${reason}: ${count}` +
          `  e.g. ${stage1.examples.get(reason as RejectReason) ?? ''}`,
      );
    }

    // ---- STAGE 2 -----------------------------------------------------------
    const embedded = await this.embedPostings(stage1.survivors);
    const ranked = await this.distancesFrom(profile.id, stage1.survivors);
    const policy: PrunePolicy = { ...DEFAULT_PRUNE, ...options.prunePolicy };
    const stage2 = prune(ranked, policy);

    this.logger.log(
      `stage 2: ${stage2.survivors.length} survivor(s) after the vector prefilter ` +
        `(${stage2.droppedFar} too far, ${stage2.droppedOverBudget} over the ` +
        `${policy.maxSurvivors} budget, ${stage2.unembedded} unembedded)`,
    );

    // ---- STAGE 4a: the deterministic half of the pay gate -------------------
    const affordable: Ranked<Candidate>[] = [];
    let payGateRejected = 0;
    for (const item of stage2.survivors) {
      const verdict = payGate(item.row, targets);
      if (verdict.pass) {
        affordable.push(item);
        continue;
      }
      payGateRejected++;
      this.logger.log(
        `  pay gate: ${item.row.title} at ${item.row.companyName} states ` +
          `${verdict.statedLPA.toFixed(1)} LPA, below the ` +
          `${targets.pay.floorLPA} LPA floor`,
      );
    }

    const base: MatchRunResult = {
      profileId: profile.id,
      considered: postings.length,
      stage1Survivors: stage1.survivors.length,
      stage1Rejected: stage1.rejected,
      stage1Examples: stage1.examples,
      embedded,
      stage2Survivors: stage2.survivors.length,
      stage2DroppedFar: stage2.droppedFar,
      stage2DroppedOverBudget: stage2.droppedOverBudget,
      stage2Unembedded: stage2.unembedded,
      payGateRejected,
      scored: 0,
      scoreFailures: 0,
      ranked: [],
    };

    if (options.dryRun) {
      this.logger.log(
        `dry run: stopping before stage 3. ${affordable.length} posting(s) would ` +
          `be scored by ${this.llm.modelFor(scoreJobTask.tier)}.`,
      );
      return base;
    }

    if (affordable.length === 0) return base;

    // ---- STAGE 3 -----------------------------------------------------------
    const shared = await this.scoringShared(profile.id, targets);
    const scores = await this.llm.completeMany<
      ScoreJobShared,
      ScoreJobInput,
      ScoreJobOutput
    >(
      scoreJobTask,
      shared,
      affordable.map((item) => ({
        key: item.row.id,
        input: {
          title: item.row.title,
          company: item.row.companyName,
          location: item.row.location ?? 'not stated',
          description: item.row.descriptionText,
          statedSalary: describeSalary(item.row),
        },
      })),
      {
        mode: options.mode,
        onProgress: (done, total) => {
          // Every ten, so a 60-posting run reports six times rather than sixty.
          if (done % 10 === 0 || done === total) {
            this.logger.log(`stage 3: scored ${done}/${total}`);
          }
        },
      },
    );

    this.logger.log(
      `stage 3: ${scores.size}/${affordable.length} posting(s) scored by ` +
        `${this.llm.modelFor(scoreJobTask.tier)}`,
    );

    // ---- STAGE 4b: persist and rank ---------------------------------------
    const rows: {
      item: Ranked<Candidate>;
      score: ScoreJobOutput;
      model: string;
    }[] = [];

    for (const item of affordable) {
      const result = scores.get(item.row.id);
      // An absent key means the call failed and was logged by the provider. It is
      // NOT written as a zero - a stored score of 0 is a judgement, and this is the
      // absence of one.
      if (!result) continue;
      rows.push({ item, score: result.value, model: result.model });
      await this.writeScore(profile.userId, item, result.value, result.model);
    }

    const compare = rankBy(targets);
    const ordered = [...rows].sort((a, b) =>
      compare(
        {
          score: a.score.score,
          tier: a.item.row.tier,
          vectorDistance: a.item.distance,
        },
        {
          score: b.score.score,
          tier: b.item.row.tier,
          vectorDistance: b.item.distance,
        },
      ),
    );

    return {
      ...base,
      scored: rows.length,
      scoreFailures: affordable.length - rows.length,
      ranked: ordered.map(({ item, score }) => ({
        jobId: item.row.id,
        title: item.row.title,
        company: item.row.companyName,
        tier: item.row.tier,
        score: score.score,
        verdict: score.verdict,
        reasons: score.reasons,
        missingSkills: score.missingSkills,
        estimatedSalaryLPA: score.estimatedSalaryLPA,
        vectorDistance: item.distance,
        applyUrl: item.row.applyUrl,
      })),
    };
  }

  /**
   * The profile to match for.
   *
   * Only a CONFIRMED profile is usable, and the error says so rather than matching
   * against a half-parsed one - phase 3's confirmation gate exists because everything
   * downstream treats atoms as ground truth.
   *
   * WITHIN one candidate, `isActive` decides. That column is why this method no
   * longer has to guess: a candidate may hold several resumes, and the most
   * recently updated one is not reliably the one they intend to apply with - a
   * typo fixed in an old variant would have promoted it. An explicit --label still
   * wins over the flag, because naming one is a clearer statement of intent than
   * a setting made on a screen last week.
   *
   * ACROSS candidates it still refuses. Scoring the wrong person's resume against
   * every posting produces a complete, plausible, wrong shortlist, and no default
   * is defensible there.
   */
  private async resolveProfile(
    options: MatchRunOptions,
  ): Promise<{ id: string; userId: string }> {
    const profiles = await this.prisma.candidateProfile.findMany({
      where: {
        confirmedAt: { not: null },
        ...(options.userId ? { userId: options.userId } : {}),
        ...(options.profileLabel ? { label: options.profileLabel } : {}),
      },
      select: {
        id: true,
        userId: true,
        label: true,
        isActive: true,
        user: { select: { email: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    if (profiles.length === 0) {
      throw new MatchingError(
        'no confirmed candidate profile found. Upload one under Resumes in the ' +
          'web app, or run `npm run cli -- profile:ingest <resume>` - matching ' +
          'reads the atoms it produces, and an unconfirmed profile is ' +
          'deliberately unusable.',
      );
    }

    // An explicit label was already applied to the query above, so anything left
    // is the caller's own choice.
    const chosen = options.profileLabel
      ? profiles
      : profiles.filter((p) => p.isActive);

    if (chosen.length === 0) {
      throw new MatchingError(
        `${profiles.length} confirmed resume(s) exist and none is selected. Pick ` +
          'one under Resumes in the web app, or pass --profile <label>.',
      );
    }

    if (chosen.length > 1 && !options.userId) {
      throw new MatchingError(
        `${chosen.length} candidates have a selected resume (` +
          chosen.map((p) => `${p.user.email}/${p.label}`).join(', ') +
          '). Pass --user to choose one.',
      );
    }

    return chosen[0];
  }

  /**
   * Every open posting worth screening.
   *
   * `descriptionText` non-empty is filtered IN SQL, not in stage 1, because it is the
   * one exclusion that is about data quality rather than about the candidate's
   * preferences - a posting whose detail fetch returned nothing is not a job that was
   * considered and rejected, and counting it in the histogram would inflate the
   * rejection numbers the histogram exists to make readable.
   */
  private async loadCandidates(limit?: number): Promise<Candidate[]> {
    const rows = await this.prisma.jobPosting.findMany({
      where: { closedAt: null, descriptionText: { not: '' } },
      select: {
        id: true,
        title: true,
        normalizedTitle: true,
        descriptionText: true,
        location: true,
        remoteType: true,
        seniority: true,
        yoeMin: true,
        yoeMax: true,
        postedAt: true,
        closedAt: true,
        contentHash: true,
        embeddedContentHash: true,
        applyUrl: true,
        salaryMin: true,
        salaryMax: true,
        salaryCurrency: true,
        salaryPeriod: true,
        salarySource: true,
        companyId: true,
        company: { select: { name: true, tier: true } },
      },
      orderBy: { postedAt: { sort: 'desc', nulls: 'last' } },
      ...(limit ? { take: limit } : {}),
    });

    return rows.map((r) => ({
      ...r,
      companyName: r.company?.name ?? 'unknown company',
      // A posting with no company row ranks as UNKNOWN rather than crashing. It
      // should not happen - companyId is set by every connector - but the tier is a
      // ranking input, and an exception here would lose the whole run.
      tier: r.company?.tier ?? CompanyTier.UNKNOWN,
      // Decimal -> number at the edge. `toNumber` on a Decimal that came from
      // Decimal(14,2) is exact for any real salary figure.
      salaryMin: decimalToNumber(r.salaryMin),
      salaryMax: decimalToNumber(r.salaryMax),
    }));
  }

  /** Postings this user already has an application for, at any status. */
  private async appliedJobIds(userId: string): Promise<Set<string>> {
    const rows = await this.prisma.application.findMany({
      where: { userId },
      select: { jobId: true },
    });
    return new Set(rows.map((r) => r.jobId));
  }

  /**
   * Embeds the survivors whose vector is missing or stale.
   *
   * ONLY THE SURVIVORS, which is why this is inside the funnel rather than a nightly
   * backfill: stage 1 has already dropped ~90%, so embedding after it does a tenth of
   * the work for exactly the same result. Every vector this writes is one a posting
   * needed.
   *
   * Stale is `embeddedContentHash <> contentHash`. See the column's comment in
   * schema.prisma - the discovery upsert cannot touch `embedding`, so without that
   * comparison an edited posting keeps a vector describing text that is gone.
   */
  private async embedPostings(postings: Candidate[]): Promise<number> {
    const stale = postings.filter(
      (p) => p.embeddedContentHash !== p.contentHash,
    );
    if (stale.length === 0) return 0;

    this.logger.log(`stage 2: embedding ${stale.length} posting(s)`);

    // In chunks, so a 400-posting run holds 400 texts rather than 400 texts and 400
    // vectors at once, and so a failure part way through has still written the ones
    // before it.
    const CHUNK = 32;
    let written = 0;

    for (let at = 0; at < stale.length; at += CHUNK) {
      const chunk = stale.slice(at, at + CHUNK);
      const vectors = await this.embeddings.embed(
        chunk.map(postingEmbeddingText),
      );

      for (const [i, posting] of chunk.entries()) {
        // Both columns in one statement. The CHECK constraint on the table refuses a
        // vector without a hash, so a write that set only the embedding would fail
        // loudly - which is the point of the constraint.
        await this.prisma.$executeRaw`
          UPDATE job_postings
             SET embedding = ${toVectorLiteral(vectors[i])}::vector,
                 "embeddedContentHash" = ${posting.contentHash}
           WHERE id = ${posting.id}
        `;
        written++;
      }
    }

    return written;
  }

  /**
   * Cosine distance from the profile centroid to each survivor.
   *
   * EXACT, not the HNSW index, and the migration that created that index explains
   * why: an ANN index accelerates an unfiltered `ORDER BY embedding <=> $1 LIMIT n`
   * over the whole table, and this is a distance projection over a known set of ids.
   * A few hundred 384-dimension dot products is microseconds.
   */
  private async distancesFrom(
    profileId: string,
    postings: Candidate[],
  ): Promise<Ranked<Candidate>[]> {
    const [profile] = await this.prisma.$queryRaw<
      { embedding: string | null }[]
    >`
      SELECT embedding::text AS embedding
        FROM candidate_profiles
       WHERE id = ${profileId}
    `;

    if (!profile?.embedding) {
      // Not fatal. Stage 2 degrades to "no ordering", every posting reaches stage 3
      // in table order, and the run still produces scores - which is much better than
      // failing, because the fix (`profile:embed`) is one command.
      this.logger.warn(
        `profile ${profileId} has no whole-profile vector, so stage 2 cannot ` +
          'order anything. Run `npm run cli -- profile:embed`. Every stage 1 ' +
          'survivor will be passed to stage 3 up to the budget.',
      );
      return postings.map((row) => ({ row, distance: null }));
    }

    const rows = await this.prisma.$queryRaw<
      { id: string; distance: number }[]
    >`
      SELECT id, (embedding <=> ${profile.embedding}::vector) AS distance
        FROM job_postings
       WHERE id = ANY(${postings.map((p) => p.id)}::text[])
         AND embedding IS NOT NULL
    `;

    const byId = new Map(rows.map((r) => [r.id, r.distance]));
    return postings.map((row) => ({ row, distance: byId.get(row.id) ?? null }));
  }

  /**
   * The cached half of the scoring prompt.
   *
   * Built ONCE per run and passed to every call, which is the entire reason
   * `LlmTask` splits `prefix` from `question`. Atoms are ordered by `ordinal` because
   * the prefix has to be byte-identical across calls and an unordered query is not
   * required to return rows in the same order twice.
   */
  private async scoringShared(
    profileId: string,
    targets: Targets,
  ): Promise<ScoreJobShared> {
    const profile = await this.prisma.candidateProfile.findUniqueOrThrow({
      where: { id: profileId },
      select: {
        atoms: {
          orderBy: { ordinal: 'asc' },
          select: { kind: true, text: true, tech: true, employer: true },
        },
      },
    });

    const tech = [...new Set(profile.atoms.flatMap((a) => a.tech))].sort();

    return {
      // From the config rather than computed from the atoms: "how many years does
      // this candidate have" is a claim the candidate makes, and dates on a resume
      // are not a reliable arithmetic input.
      candidateYears: targets.experience.candidateYears,
      headline: null,
      atoms: profile.atoms.map((a) => ({
        kind: a.kind,
        text: a.text,
        tech: a.tech,
        employer: a.employer,
      })),
      tech,
    };
  }

  /**
   * Writes the score.
   *
   * Upsert on (userId, jobId), which the schema makes unique: re-scoring after an
   * employer edits a posting replaces the score rather than adding a second one, so
   * "how many postings has this candidate been scored against" stays a count.
   *
   * `llmProvider` and `model` are recorded on every row. That is one of PLAN-v2's four
   * defenses against the two environments diverging - a quality regression that
   * appeared when the provider changed is invisible unless the rows say which provider
   * produced them.
   */
  private async writeScore(
    userId: string,
    item: Ranked<Candidate>,
    score: ScoreJobOutput,
    model: string,
  ): Promise<void> {
    const data = {
      score: score.score,
      verdict: score.verdict,
      reasons: score.reasons,
      missingSkills: score.missingSkills,
      estimatedSalaryLPA: score.estimatedSalaryLPA,
      salaryConfidence: score.salaryConfidence,
      llmProvider: this.llm.id,
      model,
      vectorDistance: item.distance,
      scoredAt: new Date(),
    };

    await this.prisma.matchScore.upsert({
      where: { userId_jobId: { userId, jobId: item.row.id } },
      create: { userId, jobId: item.row.id, ...data },
      update: data,
    });
  }
}

/**
 * The stated salary as a sentence for the prompt, or undefined.
 *
 * The RAW figures, not the LPA conversion. The model is being asked to estimate pay
 * and it should see what the employer actually wrote - "₹50,000 per MONTH" carries the
 * information that this is a monthly quote, which "6 LPA" has already digested away.
 * The gate has done its own conversion separately and does not depend on this.
 */
function describeSalary(pay: PayFacts): string | undefined {
  if (pay.salarySource !== SalarySource.STATED) return undefined;
  if (pay.salaryMin === null && pay.salaryMax === null) return undefined;

  const range =
    pay.salaryMin !== null && pay.salaryMax !== null
      ? `${pay.salaryMin} - ${pay.salaryMax}`
      : `${pay.salaryMin ?? pay.salaryMax}`;

  return [
    range,
    pay.salaryCurrency ?? '(currency not stated)',
    pay.salaryPeriod
      ? `per ${period(pay.salaryPeriod)}`
      : '(period not stated)',
  ].join(' ');
}

function period(p: SalaryPeriod): string {
  return p.toLowerCase();
}

/** Prisma Decimal at the edge of the domain, once. */
function decimalToNumber(value: Prisma.Decimal | null): number | null {
  return value === null ? null : value.toNumber();
}
