/**
 * Stage 2's pruning policy.
 *
 * Every test here is about a posting being DROPPED that should not have been. That is
 * the only failure this stage has: it produces no error, the run completes, the digest
 * is shorter, and a threshold that is quietly too tight is indistinguishable from a
 * week with no good jobs.
 */
import { DEFAULT_PRUNE, Ranked, postingEmbeddingText, prune } from './stage2.vector';

/** `n` rows at evenly spaced distances starting at `from`. */
function ranked(distances: (number | null)[]): Ranked<{ id: string }>[] {
  return distances.map((distance, i) => ({ row: { id: `job-${i}` }, distance }));
}

const ids = (r: Ranked<{ id: string }>[]) => r.map((x) => x.row.id);

describe('prune', () => {
  it('orders by distance, nearest first', () => {
    // Stage 3 scores in this order, so a run cut short by a rate limit has still
    // scored the most promising postings.
    const result = prune(ranked([0.5, 0.1, 0.3]));
    expect(ids(result.survivors)).toEqual(['job-1', 'job-2', 'job-0']);
  });

  it('does not mutate the caller array', () => {
    // The caller's array is the stage 1 survivor list, and the per-stage counts in
    // the log refer to it in its original order.
    const input = ranked([0.5, 0.1]);
    prune(input);
    expect(ids(input)).toEqual(['job-0', 'job-1']);
  });

  it('drops postings beyond maxDistance', () => {
    const result = prune(ranked([0.1, 0.2, 0.9, 0.95]), {
      ...DEFAULT_PRUNE,
      minSurvivors: 0,
    });
    expect(ids(result.survivors)).toEqual(['job-0', 'job-1']);
    expect(result.droppedFar).toBe(2);
  });

  it('rescues the nearest of the far ones to meet minSurvivors', () => {
    // THE SAFETY VALVE, and the most important behaviour in the file. Without it, a
    // wrong threshold produces an empty shortlist that reads as a quiet job market.
    // With it, the best three are always scored, so the symptom becomes "today's
    // scores are all bad" - which is a complaint someone can act on.
    const result = prune(ranked([0.9, 0.95, 0.7, 0.99]), {
      maxSurvivors: 60,
      maxDistance: 0.6,
      minSurvivors: 3,
    });

    // Nearest first among the rescued, so the top-up is not arbitrary.
    expect(ids(result.survivors)).toEqual(['job-2', 'job-0', 'job-1']);
    expect(result.droppedFar).toBe(1);
  });

  it('does not rescue when enough postings are already near', () => {
    const result = prune(ranked([0.1, 0.2, 0.3, 0.9]), {
      maxSurvivors: 60,
      maxDistance: 0.6,
      minSurvivors: 3,
    });
    expect(result.survivors).toHaveLength(3);
    expect(result.droppedFar).toBe(1);
  });

  it('caps at maxSurvivors and says so separately', () => {
    // droppedOverBudget is distinguished from droppedFar because they mean opposite
    // things: over budget is "there were more good ones than we can afford", too far
    // is "these were not good". Conflating them hides the first, which is the one
    // worth raising the budget for.
    const result = prune(ranked([0.1, 0.15, 0.2, 0.25]), {
      maxSurvivors: 2,
      maxDistance: 0.6,
      minSurvivors: 0,
    });
    expect(ids(result.survivors)).toEqual(['job-0', 'job-1']);
    expect(result.droppedOverBudget).toBe(2);
    expect(result.droppedFar).toBe(0);
  });

  it('keeps unembedded postings but sorts them last', () => {
    // A missing vector is a fact about our pipeline, not evidence about the job, so
    // it must not be a rejection. It also must not be treated as distance 0, which
    // would rank an embedding failure above every real match.
    const result = prune(ranked([0.4, null, 0.1]));
    expect(ids(result.survivors)).toEqual(['job-2', 'job-0', 'job-1']);
    expect(result.unembedded).toBe(1);
  });

  it('ranks a real distance above a null one even when the distance is poor', () => {
    const result = prune(ranked([null, 0.59]), { ...DEFAULT_PRUNE, minSurvivors: 0 });
    expect(ids(result.survivors)).toEqual(['job-1', 'job-0']);
  });

  it('handles an empty input without inventing anything', () => {
    const result = prune([]);
    expect(result.survivors).toEqual([]);
    expect(result.droppedFar).toBe(0);
    expect(result.droppedOverBudget).toBe(0);
  });

  it('treats maxDistance as inclusive', () => {
    // A posting exactly at the threshold is kept. The boundary has to be decided one
    // way, and keeping is the direction whose mistakes are visible.
    const result = prune(ranked([0.6]), {
      maxSurvivors: 60,
      maxDistance: 0.6,
      minSurvivors: 0,
    });
    expect(result.survivors).toHaveLength(1);
    expect(result.droppedFar).toBe(0);
  });

  it('has a default policy loose enough to be a spend cap rather than a filter', () => {
    // The stated intent, asserted so that tightening it is a deliberate act with a
    // failing test attached. bge-small puts unrelated pairs around 0.45-0.6, so a
    // default below that would start rejecting on topical drift alone.
    expect(DEFAULT_PRUNE.maxDistance).toBeGreaterThanOrEqual(0.5);
    expect(DEFAULT_PRUNE.minSurvivors).toBeGreaterThan(0);
    expect(DEFAULT_PRUNE.maxSurvivors).toBeGreaterThan(DEFAULT_PRUNE.minSurvivors);
  });
});

describe('postingEmbeddingText', () => {
  it('leads with the title', () => {
    // The single highest-signal part of a posting. A long description's vector is
    // otherwise dominated by whatever the description spends its words on.
    const text = postingEmbeddingText({
      title: 'Backend Engineer',
      descriptionText: 'We offer excellent health insurance and free lunch.',
    });
    expect(text.startsWith('Backend Engineer')).toBe(true);
  });

  it('truncates to roughly the model context', () => {
    // bge-small silently ignores everything past 512 tokens rather than erroring, so
    // an untruncated input does not fail - it just quietly embeds the wrong half.
    const text = postingEmbeddingText({
      title: 'Backend Engineer',
      descriptionText: 'x'.repeat(50_000),
    });
    expect(text.length).toBeLessThan(2200);
  });

  it('never returns empty text for a posting with a title', () => {
    // EmbeddingsService throws on empty input by design, and it should never be
    // reached from here.
    expect(
      postingEmbeddingText({ title: 'Backend Engineer', descriptionText: '' }).length,
    ).toBeGreaterThan(0);
  });
});
