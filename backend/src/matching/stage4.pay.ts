/**
 * Stage 4 of the matching funnel: the pay gate and the final ranking.
 *
 * PLAN-v2 phase 4 stage 4, and config/targets.yaml states the rule this file
 * implements, in full:
 *
 *   - a STATED salary below the floor rejects     (real data, trust it)
 *   - an LLM ESTIMATE below the floor does not    (a guess, ~99.7% of cases)
 *   - unknown pay passes through                  (the normal case)
 *
 * THE MEASUREMENT BEHIND THAT ASYMMETRY is PLAN-v2 change 2: structured salary
 * appears on 0.3% of Indian postings, and both instances the phase 1 spike found were
 * junk. A floor applied to an absent field rejects essentially the entire funnel, and
 * a floor applied to a model's guess rejects on the basis of a number nobody stated.
 * So the gate almost never fires, and CompanyTier is what actually sorts on pay -
 * which is why `tier` is the primary pay signal in this system and a salary column
 * is not.
 *
 * NORMALISATION IS THE DANGEROUS PART, not the comparison. `salaryMin` is a raw
 * Decimal with a separate currency and period, and the floor is 12 LPA. A monthly
 * figure of 50000 INR is 6 LPA and must reject; compared raw against 12 it passes,
 * because 50000 > 12. Every one of those mistakes fails in the SAME direction - the
 * gate silently stops gating - so the conversion refuses anything it cannot convert
 * exactly rather than guessing.
 */
import { CompanyTier, SalaryPeriod, SalarySource } from '@prisma/client';
import { Targets, tierRank } from '../config/targets';

/** One lakh. The unit the whole Indian market quotes in and the unit floorLPA is in. */
const LAKH = 100_000;

/**
 * Periods to annual multipliers.
 *
 * DAY and HOUR are here because ATSs do emit them, usually on a contract role. 260
 * working days and 2080 hours are the standard full-time-equivalent conventions -
 * approximations, but the direction of the error is safe: they slightly overstate
 * annual pay, so a borderline posting passes the gate and reaches stage 3 rather than
 * being silently dropped on the strength of an assumption about working days.
 */
const PER_YEAR: Record<SalaryPeriod, number> = {
  YEAR: 1,
  MONTH: 12,
  DAY: 260,
  HOUR: 2080,
};

/**
 * Only INR is converted, and everything else is treated as unknown.
 *
 * NOT a stub to be filled in with an FX table later - the absence is the decision. A
 * hard-coded USD rate goes stale and a live FX lookup makes the pay gate depend on a
 * network call, and either one would silently change which jobs get rejected. A
 * posting quoting USD is one where `tier` and stage 3 decide, which is where 99.7% of
 * postings are decided anyway.
 */
const CONVERTIBLE = new Set(['INR']);

export interface PayFacts {
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: SalaryPeriod | null;
  salarySource: SalarySource;
}

/**
 * The stated salary in LPA, or null when there is no usable figure.
 *
 * Reads the BOTTOM of the range. A posting offering 8-20 LPA against a 12 LPA floor is
 * genuinely ambiguous, and using the top would let a wide range advertised as an
 * aspiration clear the gate - but the gate exists to catch postings that cannot pay
 * enough, and one that might pay 20 is not that. So `salaryMin` is what is compared,
 * and `salaryMax` is only used when there is no minimum at all.
 *
 * Returns null - not 0 - for an unusable figure. 0 would be below every floor and
 * would reject, turning "we could not read this" into "this pays nothing".
 */
export function statedLPA(pay: PayFacts): number | null {
  // ESTIMATED and UNKNOWN are not statements by the employer. The gate only acts on
  // STATED, so anything else stops here regardless of what is in the columns.
  if (pay.salarySource !== SalarySource.STATED) return null;

  if (!pay.salaryCurrency || !CONVERTIBLE.has(pay.salaryCurrency.toUpperCase())) {
    return null;
  }

  // A figure with no period is uninterpretable: 60000 could be a monthly salary or an
  // annual one, and the two are a factor of twelve apart in opposite directions
  // across the floor.
  if (!pay.salaryPeriod) return null;

  const figure = pay.salaryMin ?? pay.salaryMax;
  if (figure === null || !Number.isFinite(figure) || figure <= 0) return null;

  return (figure * PER_YEAR[pay.salaryPeriod]) / LAKH;
}

export type PayVerdict =
  | { pass: true; statedLPA: number | null }
  | { pass: false; reason: 'stated-pay-below-floor'; statedLPA: number };

/** Applies the gate. Almost always passes, by design - see the header. */
export function payGate(pay: PayFacts, targets: Targets): PayVerdict {
  const lpa = statedLPA(pay);
  if (lpa === null) return { pass: true, statedLPA: null };

  return lpa < targets.pay.floorLPA
    ? { pass: false, reason: 'stated-pay-below-floor', statedLPA: lpa }
    : { pass: true, statedLPA: lpa };
}

/** What the ranking needs to know about a scored posting. */
export interface Rankable {
  score: number;
  tier: CompanyTier;
  vectorDistance: number | null;
}

/**
 * Builds the comparator for the final list. Negative means `a` sorts first.
 *
 * A FACTORY, not a bare comparator, because the tier order is DATA: it lives in
 * config/targets.yaml as `pay.tierPreference`, and a comparator that hard-coded the
 * enum's declaration order would quietly ignore the config file that exists
 * specifically to let that order be changed.
 *
 * SCORE LEADS, and tier is a tie-breaker rather than a multiplier. The temptation is
 * to fold tier into the score - a T1 bonus, a T4 penalty - and it is the wrong shape:
 * a blended number cannot be reviewed. "84, GOOD, T4" is a sentence the candidate can
 * disagree with; "79 (adjusted)" is not, and the morning review is the only mechanism
 * in this system for noticing the scorer has drifted.
 *
 * Score is BUCKETED to multiples of five before comparing, because the difference
 * between 81 and 83 from an LLM is noise while the difference between a global product
 * company and a staffing firm is not. Without the bucket, a one-point scoring wobble
 * would outrank a whole tier.
 */
export function rankBy(targets: Targets) {
  const bucket = (n: number) => Math.floor(n / 5);

  return (a: Rankable, b: Rankable): number => {
    if (bucket(b.score) !== bucket(a.score)) {
      return bucket(b.score) - bucket(a.score);
    }

    const tierDelta = tierRank(targets, a.tier) - tierRank(targets, b.tier);
    if (tierDelta !== 0) return tierDelta;

    // Vector distance last, as the tie-breaker of tie-breakers. A posting with no
    // vector sorts after one that has a distance rather than before it, which `null`
    // treated as 0 would have done.
    const da = a.vectorDistance ?? Number.POSITIVE_INFINITY;
    const db = b.vectorDistance ?? Number.POSITIVE_INFINITY;
    return da - db;
  };
}
