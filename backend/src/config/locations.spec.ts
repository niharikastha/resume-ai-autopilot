/**
 * The preference-to-filter mapping.
 *
 * WHY THIS IS TESTED AT ALL. Every failure here is silent in the worst way: a mapping
 * that drops a term rejects every job in that city and produces a shorter shortlist
 * that looks like a quiet week. There is no error, no log line and nothing on the
 * screen to read - which is exactly the failure the preference screen was built to
 * end, so it cannot be reintroduced underneath it.
 */
import {
  INDIA_CITIES,
  METRO_CITY_IDS,
  allIndiaTerms,
  termsForCities,
} from './india-cities';
import {
  locationsFor,
  matchesNothing,
  withStatedLocations,
  type StatedLocations,
} from './locations';
import type { Targets } from './targets';

const FILE_RULE: Targets['locations'] = {
  allow: ['bhubaneswar', 'bengaluru', 'india'],
  allowRemoteIndia: true,
  allowRemoteUnspecified: true,
  allowRemoteOtherRegion: false,
};

/** Only the fields the mapping reads, so a schema change does not touch every test. */
const targets = { locations: FILE_RULE } as Targets;

function stated(over: Partial<StatedLocations> = {}): StatedLocations {
  return {
    cities: [],
    anywhereInIndia: false,
    remoteIndia: true,
    remoteUnspecified: true,
    remoteOutsideIndia: false,
    ...over,
  };
}

describe('locationsFor', () => {
  it('returns the file untouched when the candidate has stated nothing', () => {
    // The property that makes the whole feature additive: an account that has never
    // opened the screen must match exactly as it did before the screen existed.
    expect(locationsFor(null, targets)).toBe(FILE_RULE);
  });

  it('expands a chosen city into every spelling a posting might use', () => {
    const rule = locationsFor(stated({ cities: ['delhi-ncr'] }), targets);

    // One click, six employer spellings. This is the whole reason the stored value is
    // an id rather than the words.
    expect(rule.allow).toContain('gurugram');
    expect(rule.allow).toContain('gurgaon');
    expect(rule.allow).toContain('noida');
    expect(rule.allow).toContain('new delhi');
    expect(rule.allow).not.toContain('bengaluru');
  });

  it('ignores a city id it does not recognise', () => {
    // Rather than throwing. A stale id in an old row is one city missing from a
    // filter; a throw is a candidate whose matching run dies every morning.
    const rule = locationsFor(
      stated({ cities: ['bengaluru', 'atlantis'] }),
      targets,
    );

    expect(rule.allow).toContain('bengaluru');
    expect(rule.allow).not.toContain('atlantis');
  });

  it('ignores the city list when anywhere-in-India is on', () => {
    const rule = locationsFor(
      stated({ cities: ['bengaluru'], anywhereInIndia: true }),
      targets,
    );

    expect(rule.allow).toEqual(allIndiaTerms());
    // The country words AND the cities: "Gurugram" is a complete location string on
    // several boards, and it names somewhere in India whether or not it says so.
    expect(rule.allow).toContain('india');
    expect(rule.allow).toContain('ind');
    expect(rule.allow).toContain('coimbatore');
  });

  it('carries the three remote answers through as they were given', () => {
    const rule = locationsFor(
      stated({
        cities: ['pune'],
        remoteIndia: false,
        remoteUnspecified: false,
        remoteOutsideIndia: true,
      }),
      targets,
    );

    expect(rule.allowRemoteIndia).toBe(false);
    expect(rule.allowRemoteUnspecified).toBe(false);
    expect(rule.allowRemoteOtherRegion).toBe(true);
  });

  it('allows an empty allow list, which is what "remote only" means', () => {
    const rule = locationsFor(stated({ remoteIndia: true }), targets);

    // Not a bug and not a fallback to the file: no city ticked and remote accepted is
    // a candidate who only wants remote work, and an empty allow list is exactly the
    // rule that admits remote postings and rejects every posting naming a place.
    expect(rule.allow).toEqual([]);
    expect(rule.allowRemoteIndia).toBe(true);
  });
});

describe('withStatedLocations', () => {
  it('never mutates the cached targets object', () => {
    // loadTargets caches and hands the SAME object to every caller in the process, so
    // a mutation here would give the next candidate this candidate's cities - a bug
    // that needs two accounts to appear and cannot be reproduced by running one.
    const before = { ...FILE_RULE };

    const result = withStatedLocations(targets, stated({ cities: ['mumbai'] }));

    expect(targets.locations).toEqual(before);
    expect(result).not.toBe(targets);
    expect(result.locations.allow).toContain('mumbai');
  });

  it('passes the file through when nothing is stated', () => {
    expect(withStatedLocations(targets, null).locations).toBe(FILE_RULE);
  });
});

describe('matchesNothing', () => {
  it('is true only for the combination that admits no posting at all', () => {
    expect(
      matchesNothing(stated({ remoteIndia: false, remoteUnspecified: false })),
    ).toBe(true);
  });

  it('is false as soon as one door is open', () => {
    expect(
      matchesNothing(
        stated({
          cities: ['pune'],
          remoteIndia: false,
          remoteUnspecified: false,
        }),
      ),
    ).toBe(false);
    expect(
      matchesNothing(
        stated({
          anywhereInIndia: true,
          remoteIndia: false,
          remoteUnspecified: false,
        }),
      ),
    ).toBe(false);
    expect(
      matchesNothing(
        stated({
          remoteIndia: false,
          remoteUnspecified: false,
          remoteOutsideIndia: true,
        }),
      ),
    ).toBe(false);
    expect(matchesNothing(stated())).toBe(false);
  });
});

describe('the catalogue', () => {
  it('has no duplicate ids', () => {
    const ids = INDIA_CITIES.map((city) => city.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('lists every term in lower case, because the matcher never lower-cases them', () => {
    for (const city of INDIA_CITIES) {
      for (const term of city.terms) {
        expect(term).toBe(term.toLowerCase());
      }
    }
  });

  it('names something in its own match terms', () => {
    // The trap this catches: a checkbox that says "Kochi" while its terms list only
    // "cochin" is a choice that never matches the obvious spelling. Tested as "the
    // label contains one of the terms" rather than "the terms contain the label",
    // because "Delhi NCR" is a region and the term is `delhi`.
    for (const city of INDIA_CITIES) {
      const label = city.label.toLowerCase();
      expect(city.terms.some((term) => label.includes(term))).toBe(true);
    }
  });

  it('has a metro preset that is a subset of the catalogue', () => {
    expect(METRO_CITY_IDS.length).toBeGreaterThan(0);
    for (const id of METRO_CITY_IDS) {
      expect(INDIA_CITIES.some((city) => city.id === id)).toBe(true);
    }
  });

  it('turns the metro preset into terms for all of them', () => {
    const terms = termsForCities(METRO_CITY_IDS);

    expect(terms).toContain('bengaluru');
    expect(terms).toContain('chennai');
    expect(terms).toContain('gurugram');
    expect(terms).toContain('kolkata');
  });
});
