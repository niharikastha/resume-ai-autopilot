/**
 * Stage 1, tested against the real config/targets.yaml.
 *
 * DELIBERATELY NOT AGAINST A FIXTURE. A synthetic targets object would test that the
 * code implements the rules; loading the real file tests that the rules as WRITTEN do
 * what the person editing the YAML thought. Those are different tests and the second
 * one is the one that catches the actual bugs here - `sde` dragging in SDET roles,
 * `intern` matching "internal", a location list that has no entry for the city half
 * the postings are in.
 *
 * The cost is that editing config/targets.yaml can fail tests. That is the intended
 * behaviour: this file is the record of what the current list is believed to do, so a
 * change that breaks it is a change whose consequence should be looked at.
 */
import { RemoteType } from '@prisma/client';
import { clearTargetsCache, loadTargets, Targets } from '../config/targets';
import {
  RejectReason,
  ScreenablePosting,
  screen,
  screenAll,
} from './stage1.screen';

let targets: Targets;

beforeAll(() => {
  clearTargetsCache();
  targets = loadTargets();
});

/** Fresh enough to pass, deterministic so the freshness test is not a time bomb. */
const NOW = new Date('2026-09-07T00:00:00.000Z');
const RECENT = new Date('2026-09-01T00:00:00.000Z');

const ctx = { now: NOW, appliedJobIds: new Set<string>() };

/**
 * A posting that passes everything, so each test can break exactly one thing.
 *
 * The description contains a real mustHaveAny keyword, because a fixture that failed
 * the keyword rule would make every other test pass for the wrong reason.
 */
function posting(
  overrides: Partial<ScreenablePosting> = {},
): ScreenablePosting {
  const title = overrides.title ?? 'Backend Engineer';
  return {
    id: 'job-1',
    title,
    normalizedTitle: title.toLowerCase(),
    descriptionText:
      'We are hiring a backend engineer to build services in Python and ' +
      'Postgres. 2-4 years of experience.',
    location: 'Bengaluru, India',
    remoteType: RemoteType.ONSITE,
    seniority: 'mid',
    yoeMin: null,
    yoeMax: null,
    postedAt: RECENT,
    closedAt: null,
    ...overrides,
  };
}

/** Asserts a rejection and returns the reason, so tests read as one line. */
function reasonFor(p: ScreenablePosting, c = ctx): RejectReason | 'PASSED' {
  const verdict = screen(p, targets, c);
  return verdict.pass ? 'PASSED' : verdict.reason;
}

describe('the baseline', () => {
  it('passes a posting that matches everything', () => {
    // If this fails, every other test in this file is meaningless - they all assert
    // that one specific change flips a pass into a rejection.
    expect(screen(posting(), targets, ctx)).toEqual({ pass: true });
  });
});

describe('facts, checked before judgements', () => {
  it('rejects a closed posting', () => {
    expect(reasonFor(posting({ closedAt: NOW }))).toBe('closed');
  });

  it('rejects a posting this user already applied to', () => {
    expect(
      reasonFor(posting(), { now: NOW, appliedJobIds: new Set(['job-1']) }),
    ).toBe('already-applied');
  });

  it('does not reject a posting someone else applied to', () => {
    // The set is per user. Getting this wrong would make the second user's funnel
    // shrink as the first user's applications accumulated.
    expect(
      reasonFor(posting(), { now: NOW, appliedJobIds: new Set(['job-2']) }),
    ).toBe('PASSED');
  });

  it('rejects a posting with no description text', () => {
    expect(reasonFor(posting({ descriptionText: '   ' }))).toBe(
      'no-description',
    );
  });
});

describe('title rules', () => {
  it('rejects a title with no include term', () => {
    expect(reasonFor(posting({ title: 'Chartered Accountant' }))).toBe(
      'title-not-included',
    );
  });

  it('lets exclude win over include', () => {
    // The rule the whole exclude list depends on. "Backend Engineering Manager"
    // matches the `backend engineer` include AND the `manager` exclude, and the
    // exclusion has to be the one that decides.
    const verdict = screen(
      posting({ title: 'Backend Engineering Manager' }),
      targets,
      ctx,
    );
    expect(verdict).toMatchObject({ pass: false, reason: 'title-excluded' });
  });

  it('excludes Staff titles without excluding member of technical staff', () => {
    // This test is why config/targets.yaml enumerates "staff backend", "staff ai"
    // and so on instead of one bare `staff`. Both halves have to hold at once: a
    // Staff role is out of reach at two years, and MTS is the title the right jobs
    // are actually posted under at funded Indian startups.
    expect(reasonFor(posting({ title: 'Staff Backend Engineer' }))).toBe(
      'title-excluded',
    );
    expect(reasonFor(posting({ title: 'Staff AI Engineer' }))).toBe(
      'title-excluded',
    );
    expect(reasonFor(posting({ title: 'Member of Technical Staff' }))).toBe(
      'PASSED',
    );
  });

  it('keeps SDE and drops SDET', () => {
    // The worked example from config/targets.yaml. `sde` is an include term and it
    // is spelled inside `sdet`, so this used to hold only because exclude is
    // evaluated first; now the word boundary separates them too, and both
    // mechanisms have to keep agreeing.
    expect(reasonFor(posting({ title: 'SDE II' }))).toBe('PASSED');
    expect(reasonFor(posting({ title: 'SDET II' }))).toBe('title-excluded');
  });

  it('does not read a config term as a fragment of a longer word', () => {
    // MEASURED against the real corpus. `intern` matched "Internal", so a live
    // Bengaluru backend role was thrown out as an internship - and a rejected
    // posting produces no output, so nothing surfaced it.
    expect(
      reasonFor(posting({ title: 'Software Engineer, Internal Systems' })),
    ).toBe('PASSED');
    // The term still has to do its actual job.
    expect(reasonFor(posting({ title: 'Software Engineer, Intern' }))).toBe(
      'title-excluded',
    );
    expect(
      reasonFor(posting({ title: 'Software Engineering Internship' })),
    ).toBe('title-excluded');
  });

  it('still matches a plural or a gerund, because the lists are singular', () => {
    // The reason the boundary rule allows s/es/ing and is not a bare \b...\b.
    // "Software Engineering" is how a large fraction of real titles are written,
    // and `software engineer` has to keep reaching it.
    expect(
      reasonFor(posting({ title: 'Software Engineering, Payments' })),
    ).toBe('PASSED');
    expect(reasonFor(posting({ title: 'Engineering Managers, Core' }))).toBe(
      'title-excluded',
    );
  });

  it('names the term that excluded it', () => {
    const verdict = screen(
      posting({ title: 'Engineering Manager' }),
      targets,
      ctx,
    );
    expect(verdict).toMatchObject({ pass: false });
    if (verdict.pass) throw new Error('unreachable');
    // Without this, finding the offending line in a 60-entry YAML list is a manual
    // bisect.
    expect(verdict.matched).toBeTruthy();
  });

  it('matches through punctuation the title normalizer strips', () => {
    // "Node.js Developer" normalizes to "node js developer", and the include list
    // was written for the normalized form. A rule matched against the raw title
    // would miss this, and Node roles are a meaningful slice of the Indian market.
    expect(reasonFor(posting({ title: 'Node.js Developer' }))).toBe('PASSED');
  });

  it('re-normalizes rather than trusting the stored normalizedTitle', () => {
    // A row written before a normalizeTitle fix carries a stale value. The screen
    // must not inherit that bug, so a deliberately wrong stored value changes
    // nothing.
    expect(
      reasonFor(
        posting({ title: 'Backend Engineer', normalizedTitle: 'nonsense' }),
      ),
    ).toBe('PASSED');
  });
});

describe('the experience window', () => {
  it('passes a posting that states no requirement', () => {
    // Which is most of them. If this rejected, the funnel would lose the majority
    // of its input to a rule that never fired intentionally.
    expect(reasonFor(posting({ yoeMin: null, yoeMax: null }))).toBe('PASSED');
  });

  it('rejects a posting demanding more than maxYears', () => {
    expect(
      reasonFor(posting({ yoeMin: targets.experience.maxYears + 3 })),
    ).toBe('experience-window');
  });

  it('accepts a posting demanding exactly maxYears', () => {
    // The boundary. `>` not `>=`, because a 6-year minimum against a 6-year ceiling
    // is a match, not a miss.
    expect(reasonFor(posting({ yoeMin: targets.experience.maxYears }))).toBe(
      'PASSED',
    );
  });

  it('rejects a posting capped below minYears', () => {
    // Only fires when minYears > 0. With the shipped config minYears is 0, so this
    // asserts the branch is correct rather than that it currently rejects anything.
    const strict = {
      ...targets,
      experience: { ...targets.experience, minYears: 3 },
    };
    const verdict = screen(posting({ yoeMax: 1 }), strict, ctx);
    expect(verdict).toMatchObject({ pass: false, reason: 'experience-window' });
  });
});

describe('location and remote eligibility', () => {
  it('accepts an allowed Indian city', () => {
    expect(reasonFor(posting({ location: 'Pune, Maharashtra, India' }))).toBe(
      'PASSED',
    );
  });

  it('rejects an onsite posting outside the allow list', () => {
    expect(reasonFor(posting({ location: 'Berlin, Germany' }))).toBe(
      'location',
    );
  });

  it('does not accept Indiana as India', () => {
    // The same fragment bug as `intern`, in the direction that costs an
    // application rather than hides one: this used to PASS, and the funnel would
    // have spent an Opus tailoring call on a job in the American Midwest.
    expect(reasonFor(posting({ location: 'Indianapolis, Indiana' }))).toBe(
      'location',
    );
    expect(reasonFor(posting({ location: 'Remote - India' }))).toBe('PASSED');
  });

  it('rejects remote roles restricted to another region', () => {
    // The measured failure from the phase 1 spike: 509 postings tagged remote that
    // an India-based candidate cannot take. "Remote - US" is a job in the US.
    expect(
      reasonFor(
        posting({
          location: 'Remote - United States',
          remoteType: RemoteType.REMOTE_OTHER_REGION,
        }),
      ),
    ).toBe('remote-not-applicable');
  });

  it('accepts remote-in-India regardless of the city list', () => {
    // A remote posting has no city to match, so gating it on locations.allow would
    // reject every one of them.
    expect(
      reasonFor(
        posting({
          location: 'Remote, India',
          remoteType: RemoteType.REMOTE_INDIA,
        }),
      ),
    ).toBe('PASSED');
  });

  it('honours allowRemoteIndia when it is turned off', () => {
    const onsiteOnly = {
      ...targets,
      locations: { ...targets.locations, allowRemoteIndia: false },
    };
    expect(
      screen(
        posting({
          location: 'Remote, India',
          remoteType: RemoteType.REMOTE_INDIA,
        }),
        onsiteOnly,
        ctx,
      ),
    ).toMatchObject({ pass: false, reason: 'remote-not-applicable' });
  });

  it('treats an unspecified-region remote posting as governed by its own flag', () => {
    // Most Indian postings that say only "Remote" land on REMOTE_GLOBAL. They are
    // usually eligible and occasionally not, which is exactly why this is a config
    // flag rather than a hard-coded decision.
    const p = posting({
      location: 'Remote',
      remoteType: RemoteType.REMOTE_GLOBAL,
    });
    expect(reasonFor(p)).toBe('PASSED');

    const strict = {
      ...targets,
      locations: { ...targets.locations, allowRemoteUnspecified: false },
    };
    expect(screen(p, strict, ctx)).toMatchObject({
      pass: false,
      reason: 'remote-not-applicable',
    });
  });

  it('rejects an unspecified-region remote posting that names a foreign place', () => {
    // THE BUG THIS FIXES. REMOTE_GLOBAL means "remote, and no region remoteType()
    // recognised", which is not the same as no region being named: OTHER_REGION is a
    // list of country and bloc words, so it misses a city or a smaller country. Every
    // string below is a real one from the live table, and every one of them passed.
    // 74 scored postings were foreign jobs in this bucket, four shortlisted GOOD, one
    // of them the top-ranked row of the day.
    for (const location of [
      'Remote Poland',
      'New York, NY',
      'Hungary - Budapest',
      'Remote - California',
      'London',
      'Toronto',
      'Paris, France',
      'Portugal - Remote',
      '-REMOTE, BULGARIA-',
      'Remote-NORAM',
      'CA Remote Ontario',
      'Remote-Friendly (Travel-Required) | San Francisco, CA | Seattle, WA',
    ]) {
      expect(
        reasonFor(posting({ location, remoteType: RemoteType.REMOTE_GLOBAL })),
      ).toBe('location');
    }
  });

  it('still passes an unspecified-region posting that names nowhere, or India', () => {
    // The other side of the same rule, and the reason it is subtractive rather than a
    // list of places: these have to keep working, and "Remote" is 31 rows on its own.
    for (const location of [
      'Remote',
      'Remote Globally',
      'Remote - Anywhere',
      '100% Remote',
      'Work From Home',
      'Multiple Locations',
      '',
      // Named, and named somewhere the candidate can work. The check does not need to
      // know which places are wanted - locations.allow answers that.
      'Remote (India)',
      'Remote - Bengaluru',
    ]) {
      expect(
        reasonFor(posting({ location, remoteType: RemoteType.REMOTE_GLOBAL })),
      ).toBe('PASSED');
    }
  });

  it('applies allowRemoteUnspecified to a posting with no location at all', () => {
    const p = posting({ location: null, remoteType: RemoteType.UNKNOWN });
    expect(reasonFor(p)).toBe('PASSED');

    const strict = {
      ...targets,
      locations: { ...targets.locations, allowRemoteUnspecified: false },
    };
    expect(screen(p, strict, ctx)).toMatchObject({
      pass: false,
      reason: 'location',
    });
  });

  it('checks the city list for a hybrid role', () => {
    // Hybrid means being in the office some days, so the city matters MORE than for
    // onsite, not less.
    expect(
      reasonFor(
        posting({ location: 'Berlin, Germany', remoteType: RemoteType.HYBRID }),
      ),
    ).toBe('location');
    expect(
      reasonFor(
        posting({
          location: 'Bengaluru, India',
          remoteType: RemoteType.HYBRID,
        }),
      ),
    ).toBe('PASSED');
  });
});

describe('description rules', () => {
  it('rejects a description containing a dealbreaker', () => {
    const term = targets.keywords.dealbreakers[0];
    expect(
      reasonFor(
        posting({
          descriptionText: `Backend engineer with Python. ${term} required.`,
        }),
      ),
    ).toBe('dealbreaker');
  });

  it('rejects a description with none of the must-have keywords', () => {
    expect(
      reasonFor(
        posting({
          descriptionText:
            'You will own vendor relationships and quarterly budgets.',
        }),
      ),
    ).toBe('no-must-have-keyword');
  });

  it('does not let a matching TITLE satisfy the keyword rule', () => {
    // The rule that nearly became a no-op. `backend` is a must-have keyword and
    // `backend engineer` is an include term, so a keyword scan that saw the title
    // would pass every posting that got this far - a filter still in the config,
    // still documented, never rejecting anything. The title here matches an include
    // term and the body deliberately does not mention any keyword.
    expect(
      reasonFor(
        posting({
          title: 'Backend Engineer',
          descriptionText: 'You will own vendor relationships and budgets.',
        }),
      ),
    ).toBe('no-must-have-keyword');
  });

  it('lets the dealbreaker win over the must-have keyword', () => {
    // Both rules fire on the same body. Which one reports matters only for the
    // histogram, but the histogram is the tuning instrument, so it matters.
    const term = targets.keywords.dealbreakers[0];
    expect(
      reasonFor(posting({ descriptionText: `Python and Postgres. ${term}.` })),
    ).toBe('dealbreaker');
  });

  it('matches keywords case-insensitively', () => {
    expect(
      reasonFor(posting({ descriptionText: 'Build services in PYTHON.' })),
    ).toBe('PASSED');
  });
});

describe('freshness', () => {
  it('rejects a posting older than maxAgeDays', () => {
    const old = new Date(
      NOW.getTime() - (targets.freshness.maxAgeDays + 5) * 86_400_000,
    );
    expect(reasonFor(posting({ postedAt: old }))).toBe('stale');
  });

  it('accepts a posting exactly at the age limit', () => {
    const edge = new Date(
      NOW.getTime() - targets.freshness.maxAgeDays * 86_400_000,
    );
    expect(reasonFor(posting({ postedAt: edge }))).toBe('PASSED');
  });

  it('passes an undated posting when allowUnknownAge is set', () => {
    // Several connectors report no date at all. Rejecting undated postings would
    // silently exclude entire boards - which is a rule you would never see fire.
    expect(reasonFor(posting({ postedAt: null }))).toBe('PASSED');

    const strict = {
      ...targets,
      freshness: { ...targets.freshness, allowUnknownAge: false },
    };
    expect(screen(posting({ postedAt: null }), strict, ctx)).toMatchObject({
      pass: false,
      reason: 'stale',
    });
  });

  it('uses the injected clock, not the wall clock', () => {
    // The assertion that this file will still pass in a year. The offset is derived
    // from the config rather than written as a date, like every other test in this
    // block: a literal 2027-01-01 was a fixed four months out, so raising
    // maxAgeDays from 45 to 180 turned this into a test that the clock is IGNORED.
    const later = {
      now: new Date(
        NOW.getTime() + (targets.freshness.maxAgeDays + 5) * 86_400_000,
      ),
      appliedJobIds: new Set<string>(),
    };
    expect(reasonFor(posting(), later)).toBe('stale');
  });
});

describe('seniority', () => {
  it('passes a null seniority', () => {
    expect(reasonFor(posting({ seniority: null }))).toBe('PASSED');
  });

  it('rejects a seniority the config excludes', () => {
    // Currently a no-op with the shipped allow list (junior, mid, senior - every
    // value `seniority()` can return). Tested against a narrowed list so that
    // narrowing the real one is known to take effect.
    const juniorOnly = {
      ...targets,
      seniority: { allow: ['junior' as const] },
    };
    expect(
      screen(posting({ seniority: 'senior' }), juniorOnly, ctx),
    ).toMatchObject({ pass: false, reason: 'seniority', matched: 'senior' });
  });
});

describe('screenAll', () => {
  it('counts rejections by reason and keeps one example of each', () => {
    const { survivors, rejected, examples } = screenAll(
      [
        posting({ id: 'a' }),
        posting({ id: 'b', title: 'Engineering Manager' }),
        posting({ id: 'c', title: 'Engineering Manager, Platform' }),
        posting({ id: 'd', location: 'Berlin, Germany' }),
      ],
      targets,
      ctx,
    );

    expect(survivors.map((s) => s.id)).toEqual(['a']);
    expect(rejected['title-excluded']).toBe(2);
    expect(rejected.location).toBe(1);
    // Absent, not zero - the histogram lists the rules that fired.
    expect(rejected.stale).toBeUndefined();
    expect(examples.get('title-excluded')).toContain('Engineering Manager');
  });

  it('preserves the caller row type on survivors', () => {
    // screenAll is generic so the service can select extra columns (companyId, the
    // embedding, the tier) and still have them on the way out. A non-generic
    // signature would force a re-query for data already in hand.
    const rows = [{ ...posting(), companyId: 'co-1' }];
    const { survivors } = screenAll(rows, targets, ctx);
    expect(survivors[0].companyId).toBe('co-1');
  });

  it('returns everything as a survivor when nothing objects', () => {
    const rows = [posting({ id: 'a' }), posting({ id: 'b' })];
    expect(screenAll(rows, targets, ctx).survivors).toHaveLength(2);
  });
});
