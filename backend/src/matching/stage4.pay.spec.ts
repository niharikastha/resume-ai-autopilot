/**
 * Stage 4: the pay gate and the ranking.
 *
 * THE UNIT CONVERSION IS WHAT THIS FILE IS FOR. Every way of getting it wrong fails in
 * the same direction - the gate compares a monthly figure against an annual floor,
 * 50000 > 12, and the gate silently stops gating. It would never throw and never
 * appear in a log. So the conversions are asserted with real Indian salary figures
 * rather than round numbers.
 */
import { CompanyTier, SalaryPeriod, SalarySource } from '@prisma/client';
import { clearTargetsCache, loadTargets, Targets } from '../config/targets';
import { PayFacts, payGate, rankBy, statedLPA } from './stage4.pay';

let targets: Targets;

beforeAll(() => {
  clearTargetsCache();
  targets = loadTargets();
});

function pay(overrides: Partial<PayFacts> = {}): PayFacts {
  return {
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryPeriod: null,
    salarySource: SalarySource.UNKNOWN,
    ...overrides,
  };
}

/** A stated INR annual figure, the shape the gate actually acts on. */
function statedINR(
  min: number | null,
  period: SalaryPeriod = SalaryPeriod.YEAR,
  max: number | null = null,
): PayFacts {
  return pay({
    salaryMin: min,
    salaryMax: max,
    salaryCurrency: 'INR',
    salaryPeriod: period,
    salarySource: SalarySource.STATED,
  });
}

describe('statedLPA', () => {
  it('converts an annual INR figure to lakhs', () => {
    expect(statedLPA(statedINR(1_800_000))).toBeCloseTo(18);
  });

  it('converts a MONTHLY figure, which is the mistake that disables the gate', () => {
    // 50,000/month is 6 LPA and must reject against a 12 LPA floor. Compared raw it
    // is 50000 > 12 and passes, which is a gate that has silently stopped gating.
    expect(statedLPA(statedINR(50_000, SalaryPeriod.MONTH))).toBeCloseTo(6);
  });

  it('converts DAY and HOUR using full-time-equivalent conventions', () => {
    // 260 working days and 2080 hours. Approximations that slightly OVERSTATE annual
    // pay, so the error sends a borderline posting to stage 3 rather than deleting it
    // on the strength of an assumption about working days.
    expect(statedLPA(statedINR(8_000, SalaryPeriod.DAY))).toBeCloseTo(20.8);
    expect(statedLPA(statedINR(1_000, SalaryPeriod.HOUR))).toBeCloseTo(20.8);
  });

  it('reads the BOTTOM of a stated range', () => {
    // A posting offering 8-20 LPA against a 12 LPA floor is ambiguous, and using the
    // top would let a wide range advertised as an aspiration clear the gate.
    expect(statedLPA(statedINR(800_000, SalaryPeriod.YEAR, 2_000_000))).toBeCloseTo(8);
  });

  it('falls back to the maximum when there is no minimum', () => {
    expect(statedLPA(statedINR(null, SalaryPeriod.YEAR, 2_000_000))).toBeCloseTo(20);
  });

  it('ignores an ESTIMATED figure entirely', () => {
    // The rule config/targets.yaml states: an estimate is a guess and must not
    // reject. ~99.7% of postings have no stated figure at all.
    expect(
      statedLPA({ ...statedINR(500_000), salarySource: SalarySource.ESTIMATED }),
    ).toBeNull();
  });

  it('returns null, not 0, for an unusable figure', () => {
    // 0 is below every floor and would reject, turning "we could not read this" into
    // "this pays nothing".
    expect(statedLPA(pay())).toBeNull();
    expect(statedLPA(statedINR(0))).toBeNull();
    expect(statedLPA(statedINR(-5))).toBeNull();
  });

  it('refuses a figure with no period rather than assuming annual', () => {
    // 60000 could be monthly or annual, and those sit on opposite sides of the floor.
    expect(
      statedLPA({ ...statedINR(60_000), salaryPeriod: null }),
    ).toBeNull();
  });

  it('refuses a currency it cannot convert', () => {
    // Deliberately not a stub for a future FX table: a hard-coded rate goes stale and
    // a live lookup makes the pay gate depend on a network call. Either would silently
    // change which jobs get rejected.
    expect(statedLPA({ ...statedINR(120_000), salaryCurrency: 'USD' })).toBeNull();
    expect(statedLPA({ ...statedINR(120_000), salaryCurrency: null })).toBeNull();
  });

  it('accepts a lower-case currency code', () => {
    expect(statedLPA({ ...statedINR(1_800_000), salaryCurrency: 'inr' })).toBeCloseTo(18);
  });
});

describe('payGate', () => {
  it('rejects a stated salary below the floor', () => {
    const verdict = payGate(statedINR(50_000, SalaryPeriod.MONTH), targets);
    expect(verdict).toMatchObject({ pass: false, reason: 'stated-pay-below-floor' });
  });

  it('accepts a stated salary at the floor exactly', () => {
    const atFloor = targets.pay.floorLPA * 100_000;
    expect(payGate(statedINR(atFloor), targets)).toMatchObject({ pass: true });
  });

  it('passes unknown pay through, which is the normal case', () => {
    // PLAN-v2 change 2: structured salary exists on 0.3% of India postings. A floor
    // applied to an absent field rejects essentially the entire funnel.
    expect(payGate(pay(), targets)).toEqual({ pass: true, statedLPA: null });
  });

  it('does not reject on an estimate below the floor', () => {
    expect(
      payGate(
        { ...statedINR(400_000), salarySource: SalarySource.ESTIMATED },
        targets,
      ),
    ).toEqual({ pass: true, statedLPA: null });
  });

  it('reports the converted figure so the log can state it', () => {
    const verdict = payGate(statedINR(600_000), targets);
    expect(verdict.pass).toBe(false);
    if (verdict.pass) throw new Error('unreachable');
    expect(verdict.statedLPA).toBeCloseTo(6);
  });
});

describe('rankBy', () => {
  const compare = () => rankBy(targets);

  function job(
    score: number,
    tier: CompanyTier,
    vectorDistance: number | null = null,
  ) {
    return { score, tier, vectorDistance };
  }

  it('puts the higher score first', () => {
    expect(compare()(job(90, CompanyTier.UNKNOWN), job(60, CompanyTier.T1_GLOBAL_INDIA_OFFICE))).toBeLessThan(0);
  });

  it('does not let tier outrank a real score difference', () => {
    // Tier is a tie-breaker, not a multiplier. A T4 posting the scorer rated 90
    // beats a T1 it rated 60, because the score is the thing a human reviews.
    const order = [
      job(60, CompanyTier.T1_GLOBAL_INDIA_OFFICE),
      job(90, CompanyTier.T4_SERVICES_STAFFING),
    ].sort(compare());
    expect(order[0].score).toBe(90);
  });

  it('breaks a near-tie on tier', () => {
    // 81 and 83 from an LLM is noise; a global product company versus a staffing firm
    // is not. The five-point bucket is what makes tier decide here.
    const order = [
      job(81, CompanyTier.T4_SERVICES_STAFFING),
      job(83, CompanyTier.T1_GLOBAL_INDIA_OFFICE),
    ].sort(compare());
    expect(order[0].tier).toBe(CompanyTier.T1_GLOBAL_INDIA_OFFICE);
  });

  it('respects the tier order from the config, not the enum declaration order', () => {
    // The reason rankBy is a factory. A comparator with a hard-coded order would
    // ignore config/targets.yaml, which exists specifically to let this be changed.
    const reversed: Targets = {
      ...targets,
      pay: {
        ...targets.pay,
        tierPreference: [...targets.pay.tierPreference].reverse(),
      },
    };
    const order = [
      job(80, CompanyTier.T1_GLOBAL_INDIA_OFFICE),
      job(80, CompanyTier.T4_SERVICES_STAFFING),
    ].sort(rankBy(reversed));
    expect(order[0].tier).toBe(CompanyTier.T4_SERVICES_STAFFING);
  });

  it('uses vector distance only as the last tie-breaker', () => {
    const order = [
      job(80, CompanyTier.T2_FUNDED_INDIAN_STARTUP, 0.4),
      job(80, CompanyTier.T2_FUNDED_INDIAN_STARTUP, 0.2),
    ].sort(compare());
    expect(order[0].vectorDistance).toBe(0.2);
  });

  it('sorts a missing distance after a present one', () => {
    // null treated as 0 would rank an embedding failure above every real match.
    const order = [
      job(80, CompanyTier.T2_FUNDED_INDIAN_STARTUP, null),
      job(80, CompanyTier.T2_FUNDED_INDIAN_STARTUP, 0.9),
    ].sort(compare());
    expect(order[0].vectorDistance).toBe(0.9);
  });

  it('is a total order - sorting twice gives the same list', () => {
    const rows = [
      job(90, CompanyTier.T3_INDIAN_MIDMARKET, 0.3),
      job(72, CompanyTier.T1_GLOBAL_INDIA_OFFICE, 0.1),
      job(90, CompanyTier.T1_GLOBAL_INDIA_OFFICE, 0.4),
      job(72, CompanyTier.T1_GLOBAL_INDIA_OFFICE, 0.1),
    ];
    const once = [...rows].sort(compare());
    const twice = [...once].sort(compare());
    expect(twice).toEqual(once);
  });
});
