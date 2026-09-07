/**
 * Stage 2 of the matching funnel: the vector prefilter.
 *
 * PLAN-v2 phase 4 stage 2 - cosine distance between the profile vector and each
 * surviving posting's vector, cheap, local, no API.
 *
 * WHAT THIS STAGE IS ACTUALLY FOR, because it is easy to over-trust. It is a spend
 * cap and an ordering, not a judgement. A 384-dimension embedding of a whole job
 * description against a whole resume measures topical overlap, and topical overlap is
 * not fit: a posting that is unmistakably about backend Python work scores close
 * whether it wants two years or twelve. Stage 3 makes the decision. Stage 2's job is
 * to make sure stage 3 spends its budget on the 60 most plausible postings rather
 * than the alphabetically first 60.
 *
 * WHICH IS WHY THE POLICY IS A SEPARATE, PURE FUNCTION from the query that produces
 * the distances. The failure mode here is not a crash, it is a threshold that quietly
 * discards good postings - and the only way to see that is to be able to run the
 * policy over known distances in a test.
 */

/** A row with its distance from the profile vector. */
export interface Ranked<T> {
  row: T;
  /**
   * pgvector `<=>` cosine distance: 0 is identical, 1 is orthogonal, 2 is opposite.
   *
   * Null when the posting has no vector. That is a real state - the embedding pass
   * can fail for one posting - and it must not read as distance 0.
   */
  distance: number | null;
}

export interface PrunePolicy {
  /**
   * How many postings stage 3 is allowed to see.
   *
   * The real cost gate. At Haiku 4.5 prices with a cached profile prefix a scored
   * posting is a fraction of a cent, so this number is not chosen to save money in
   * absolute terms - it is chosen so that a discovery run that suddenly returns 4000
   * postings (a new connector, a bug, a company list that grew 10x) cannot turn into
   * 4000 LLM calls before anyone notices.
   */
  maxSurvivors: number;

  /**
   * Distances above this are dropped as unrelated.
   *
   * DELIBERATELY LOOSE. bge-small puts a relevant JD/resume pair around 0.2-0.35 and
   * an unrelated one around 0.45-0.6, but those bands overlap and they shift with
   * description length - a 3000-word posting with legal boilerplate drifts further
   * from a terse resume than a short one does, regardless of fit. A tight threshold
   * here would silently delete good postings for being verbose. 0.6 is set to catch
   * only the obviously-unrelated, on the principle that stage 3 rejecting a posting
   * with a stated reason is always better than stage 2 rejecting it with none.
   */
  maxDistance: number;

  /**
   * Kept regardless of `maxDistance`.
   *
   * The safety valve, and the most important line in this file. If the threshold is
   * ever wrong - a model change, a profile that embeds oddly, an off-by-one in the
   * distance arithmetic - the symptom without this is a matching run that reports
   * zero matches and looks like a quiet job market. With it, the best N are always
   * scored, so a bad threshold shows up as "the scores are all terrible today", which
   * is a diagnosable complaint.
   */
  minSurvivors: number;
}

export const DEFAULT_PRUNE: PrunePolicy = {
  maxSurvivors: 60,
  maxDistance: 0.6,
  minSurvivors: 10,
};

export interface PruneResult<T> {
  /** Best first. Stage 3 scores them in this order, so a run that is cut short by a
   *  rate limit has still scored the most promising ones. */
  survivors: Ranked<T>[];
  /** Dropped for being too far away. */
  droppedFar: number;
  /** Dropped because the budget ran out, not because they were bad. Worth
   *  distinguishing: a nonzero count here means maxSurvivors is the binding
   *  constraint, which is a different problem from a bad match pool. */
  droppedOverBudget: number;
  /** Postings with no vector at all - an embedding failure, not a poor match. */
  unembedded: number;
}

/**
 * Orders by distance and cuts to budget.
 *
 * Unembedded postings sort LAST but are not discarded, because "we could not embed
 * this" is not evidence about the job. They only reach stage 3 if there is room after
 * everything with a real distance, which is the correct priority without being a
 * silent deletion.
 */
export function prune<T>(
  ranked: Ranked<T>[],
  policy: PrunePolicy = DEFAULT_PRUNE,
): PruneResult<T> {
  const withVector = ranked.filter((r) => r.distance !== null);
  const withoutVector = ranked.filter((r) => r.distance === null);

  // Non-mutating: the caller's array is the stage-1 survivor list, and reordering it
  // underneath them would make the per-stage counts in the log refer to a list that
  // no longer exists in that order.
  const sorted = [...withVector].sort(
    (a, b) => (a.distance as number) - (b.distance as number),
  );

  const near = sorted.filter((r) => (r.distance as number) <= policy.maxDistance);
  const far = sorted.filter((r) => (r.distance as number) > policy.maxDistance);

  // The safety valve. Top up from the far list - which is still distance-ordered, so
  // the nearest of the rejected come back first - until minSurvivors is met.
  const rescued =
    near.length >= policy.minSurvivors
      ? []
      : far.slice(0, policy.minSurvivors - near.length);

  const ordered = [...near, ...rescued, ...withoutVector];
  const survivors = ordered.slice(0, policy.maxSurvivors);

  return {
    survivors,
    droppedFar: far.length - rescued.length,
    droppedOverBudget: Math.max(0, ordered.length - survivors.length),
    unembedded: withoutVector.length,
  };
}

/**
 * The text that gets embedded for a posting.
 *
 * The TITLE IS INCLUDED and repeated first, and that is not padding. A long
 * description's vector is dominated by whatever the description spends its words on -
 * benefits, the company's mission, an equal-opportunity statement - and the title is
 * the single highest-signal token sequence in the whole posting. Leading with it
 * pulls the vector toward what the job actually is.
 *
 * TRUNCATED, because the model's context is 512 tokens and everything past that is
 * silently ignored by the tokenizer rather than erroring. 2000 characters is roughly
 * that budget with room for the title, and the first 2000 characters of a job
 * description are the part that describes the job - the boilerplate is at the bottom.
 * Getting this wrong produces vectors that are all subtly about employee benefits,
 * which would look like a working system with mediocre matches.
 */
export function postingEmbeddingText(posting: {
  title: string;
  descriptionText: string;
}): string {
  return `${posting.title}\n\n${posting.descriptionText.slice(0, 2000)}`.trim();
}
