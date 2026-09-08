/**
 * The targets loader.
 *
 * The tests that matter here are the REFUSALS. A targets file that fails to load is
 * a loud error at the start of a run; a targets file that loads with a rule quietly
 * missing produces a run whose numbers look fine and whose filter has stopped
 * filtering. Nothing downstream can tell the difference, because a rejected posting
 * leaves no row behind - so the boundary is the only place this can be caught.
 *
 * The real config/targets.yaml is loaded too, so a stray key in it fails in CI.
 */
import { CompanyTier } from '@prisma/client';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  clearTargetsCache,
  loadTargets,
  TargetsError,
  tierRank,
} from './targets';

const REAL = resolve(__dirname, '../../../config/targets.yaml');

/** A minimal file that passes, so a test can omit one field to check the refusal. */
const VALID = `
titles:
  include: [software engineer]
  exclude: [intern]
seniority:
  allow: [junior, mid]
experience:
  minYears: 0
  maxYears: 6
  candidateYears: 2
locations:
  allow: [bengaluru]
  allowRemoteIndia: true
  allowRemoteUnspecified: true
keywords:
  mustHaveAny: [node]
  dealbreakers: [unpaid]
freshness:
  maxAgeDays: 45
  allowUnknownAge: true
limits:
  maxApplicationsPerDay: 15
  perCompanyCooldownDays: 14
pay:
  floorLPA: 12
  tierPreference:
    - T1_GLOBAL_INDIA_OFFICE
    - T2_FUNDED_INDIAN_STARTUP
    - T3_INDIAN_MIDMARKET
    - T4_SERVICES_STAFFING
    - UNKNOWN
`;

function fixture(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'targets-'));
  const path = join(dir, 'targets.yaml');
  writeFileSync(path, yaml, 'utf8');
  return path;
}

beforeEach(() => clearTargetsCache());

describe('loadTargets', () => {
  it('loads a valid file and lower-cases every term', () => {
    const targets = loadTargets(
      fixture(VALID.replace('[software engineer]', '[Software Engineer, SDE]')),
    );
    expect(targets.titles.include).toEqual(['software engineer', 'sde']);
  });

  it('caches by path, so a run reads the file once', () => {
    const path = fixture(VALID);
    expect(loadTargets(path)).toBe(loadTargets(path));
  });

  it('refuses an unknown key rather than ignoring it', () => {
    // The motivating typo. `dealbrakers` would leave dealbreakers empty, which
    // silently disables every one of them.
    expect(() =>
      loadTargets(fixture(VALID.replace('dealbreakers:', 'dealbrakers:'))),
    ).toThrow(TargetsError);
  });

  it('refuses an empty include list', () => {
    // Not treated as "match everything" and not as "match nothing" - both are
    // guesses about intent, and one of them applies to every job on the internet.
    expect(() =>
      loadTargets(
        fixture(VALID.replace('include: [software engineer]', 'include: []')),
      ),
    ).toThrow(TargetsError);
  });

  it('refuses an inverted experience window', () => {
    expect(() =>
      loadTargets(
        fixture(
          VALID.replace('maxYears: 6', 'maxYears: 0').replace(
            'minYears: 0',
            'minYears: 3',
          ),
        ),
      ),
    ).toThrow(TargetsError);
  });

  it('refuses a tierPreference that omits a tier', () => {
    expect(() =>
      loadTargets(fixture(VALID.replace('    - UNKNOWN\n', ''))),
    ).toThrow(/every CompanyTier exactly once/);
  });

  it('refuses a tierPreference that repeats one', () => {
    expect(() =>
      loadTargets(
        fixture(
          VALID.replace('    - UNKNOWN\n', '    - T1_GLOBAL_INDIA_OFFICE\n'),
        ),
      ),
    ).toThrow(TargetsError);
  });

  it('reports a missing file as a clean error', () => {
    expect(() => loadTargets('/nonexistent/targets.yaml')).toThrow(
      TargetsError,
    );
  });

  it('defaults allowRemoteOtherRegion to off when the file predates it', () => {
    // The fixture above does not mention the key, which is the whole point: the key
    // was added after the file was in use, and requiring it would have made a correct
    // targets.yaml fail to load on upgrade. Off is the behaviour that existed before
    // it - a remote role restricted to another region is not applicable.
    expect(loadTargets(fixture(VALID)).locations.allowRemoteOtherRegion).toBe(
      false,
    );
  });

  it('honours allowRemoteOtherRegion when the file sets it', () => {
    const path = fixture(
      VALID.replace(
        '  allowRemoteUnspecified: true',
        '  allowRemoteUnspecified: true\n  allowRemoteOtherRegion: true',
      ),
    );
    expect(loadTargets(path).locations.allowRemoteOtherRegion).toBe(true);
  });
});

describe('tierRank', () => {
  it('ranks T1 first and UNKNOWN last', () => {
    const targets = loadTargets(fixture(VALID));
    expect(tierRank(targets, CompanyTier.T1_GLOBAL_INDIA_OFFICE)).toBe(0);
    expect(tierRank(targets, CompanyTier.UNKNOWN)).toBe(4);
    expect(
      tierRank(targets, CompanyTier.T2_FUNDED_INDIAN_STARTUP),
    ).toBeLessThan(tierRank(targets, CompanyTier.T4_SERVICES_STAFFING));
  });
});

describe('the real config/targets.yaml', () => {
  it('loads', () => {
    const targets = loadTargets(REAL);
    expect(targets.titles.include.length).toBeGreaterThan(10);
    expect(targets.limits.maxApplicationsPerDay).toBe(15);
    // PLAN-v2 change 2: the floor is a soft preference, but it should still be set.
    expect(targets.pay.floorLPA).toBeGreaterThan(0);
  });

  it('keeps senior roles in scope', () => {
    // Excluding the senior band took the spike's working pool from 115 to 69. The
    // filter is title-keyword based and demonstrably cut reachable roles, so this
    // asserts the decision rather than leaving it to be re-litigated by accident.
    expect(loadTargets(REAL).seniority.allow).toContain('senior');
  });

  it('does not exclude a title it also includes', () => {
    // A term in both lists is always a rejection, because exclude wins. That is a
    // rule which reads as working and matches nothing.
    const t = loadTargets(REAL);
    for (const included of t.titles.include) {
      for (const excluded of t.titles.exclude) {
        expect(included).not.toBe(excluded);
      }
    }
  });
});
