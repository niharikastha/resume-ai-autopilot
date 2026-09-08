/**
 * The "where you will work" screen, both halves of it.
 *
 * WHAT IS WORTH TESTING HERE. Not that an upsert upserts. Three things:
 *
 *   1. A CANDIDATE WHO HAS NEVER SAVED SEES WHAT IS ACTUALLY IN FORCE. The screen
 *      opens on the file's rule translated into checkboxes, not on empty boxes. Empty
 *      boxes would invite a save that narrows the pipeline to almost nothing, and the
 *      candidate would have no way to know they had done it.
 *   2. THE REQUEST CANNOT WIDEN THE MATCHER'S VOCABULARY. Cities are ids from a fixed
 *      catalogue, so a body cannot inject a term into the word list the screen runs on.
 *   3. THE ONE PIPELINE-EMPTYING COMBINATION IS REFUSED AT THE DOOR. No city, no
 *      anywhere-in-India and no remote is valid field by field and admits nothing, and
 *      "0 new matches" every morning is indistinguishable from a quiet job market.
 *
 * WHAT IS FAKED. Prisma is a hand-written stub whose `count` interprets the small
 * subset of the where-clause the service actually builds, so the preview number is a
 * real consequence of the rule rather than a returned constant. `config/targets.yaml`
 * is the REAL file: the point of the fromTargets test is that the screen agrees with
 * the file that is shipped, and a fixture would assert against the fixture.
 */
import { BadRequestException } from '@nestjs/common';
import { RemoteType } from '@prisma/client';
import type { SessionUser } from '../auth/auth.constants';
import { INDIA_CITIES } from '../config/india-cities';
import type { StatedLocations } from '../config/locations';
import { clearTargetsCache, loadTargets } from '../config/targets';
import type { PrismaService } from '../prisma/prisma.service';
import { PreferencesController } from './preferences.controller';
import { PreferencesService } from './preferences.service';

const USER = '11111111-1111-4111-8111-111111111111';

interface FakePosting {
  location: string | null;
  remoteType: RemoteType;
  closedAt: Date | null;
}

/** The postings the count runs over. Deliberately tiny and hand-checkable. */
const POSTINGS: FakePosting[] = [
  {
    location: 'Bengaluru, India',
    remoteType: RemoteType.ONSITE,
    closedAt: null,
  },
  {
    location: 'Pune, Maharashtra',
    remoteType: RemoteType.HYBRID,
    closedAt: null,
  },
  { location: 'Gurugram', remoteType: RemoteType.ONSITE, closedAt: null },
  {
    location: 'Coimbatore, IND',
    remoteType: RemoteType.ONSITE,
    closedAt: null,
  },
  {
    location: 'Remote - India',
    remoteType: RemoteType.REMOTE_INDIA,
    closedAt: null,
  },
  { location: 'Remote', remoteType: RemoteType.REMOTE_GLOBAL, closedAt: null },
  {
    location: 'Remote - United States',
    remoteType: RemoteType.REMOTE_OTHER_REGION,
    closedAt: null,
  },
  // Closed, and in a city that would otherwise match. Nothing should ever count it.
  {
    location: 'Chennai, India',
    remoteType: RemoteType.ONSITE,
    closedAt: new Date('2026-01-01'),
  },
];

interface CountArgs {
  where: {
    closedAt: null;
    OR: (
      | { remoteType: { in: RemoteType[] } }
      | { location: { contains: string; mode: 'insensitive' } }
    )[];
  };
}

/**
 * Just enough Prisma. `count` reads the OR the service builds and applies it, so a
 * mapping that dropped a term shows up here as a smaller number.
 */
function fakePrisma(row: (StatedLocations & { userId: string }) | null) {
  let stored = row;
  const upserts: unknown[] = [];

  return {
    upserts,
    get stored() {
      return stored;
    },
    service: {
      jobPreference: {
        findUnique: ({ where }: { where: { userId: string } }) =>
          Promise.resolve(
            stored && stored.userId === where.userId ? stored : null,
          ),
        upsert: (args: {
          where: { userId: string };
          create: StatedLocations & { userId: string };
        }) => {
          upserts.push(args);
          stored = args.create;
          return Promise.resolve(stored);
        },
      },
      jobPosting: {
        count: ({ where }: CountArgs) =>
          Promise.resolve(
            POSTINGS.filter(
              (posting) =>
                posting.closedAt === null &&
                where.OR.some((clause) =>
                  'remoteType' in clause
                    ? clause.remoteType.in.includes(posting.remoteType)
                    : (posting.location ?? '')
                        .toLowerCase()
                        .includes(clause.location.contains.toLowerCase()),
                ),
            ).length,
          ),
      },
    } as unknown as PrismaService,
  };
}

function stated(over: Partial<StatedLocations> = {}): StatedLocations {
  return {
    cities: [],
    anywhereInIndia: false,
    remoteIndia: false,
    remoteUnspecified: false,
    remoteOutsideIndia: false,
    ...over,
  };
}

beforeEach(() => {
  clearTargetsCache();
});

describe('PreferencesService.view', () => {
  it('shows the file rule as checkboxes when the candidate has stated nothing', async () => {
    const prisma = fakePrisma(null);
    const view = await new PreferencesService(prisma.service).view(USER);
    const file = loadTargets().locations;

    expect(view.stated).toBe(false);
    expect(view.locations.remoteIndia).toBe(file.allowRemoteIndia);
    expect(view.locations.remoteUnspecified).toBe(file.allowRemoteUnspecified);
    expect(view.locations.remoteOutsideIndia).toBe(file.allowRemoteOtherRegion);
    // Every city id it reports back must be one the checkbox list can render, or the
    // screen would open on a setting it cannot show.
    for (const id of view.locations.cities) {
      expect(INDIA_CITIES.some((city) => city.id === id)).toBe(true);
    }
  });

  it('reports a saved preference as stated', async () => {
    const prisma = fakePrisma({
      userId: USER,
      ...stated({ cities: ['pune'], remoteIndia: true }),
    });

    const view = await new PreferencesService(prisma.service).view(USER);

    expect(view.stated).toBe(true);
    expect(view.locations.cities).toEqual(['pune']);
    expect(view.locations.anywhereInIndia).toBe(false);
  });

  it('hands the screen the catalogue and the metro preset, so neither is a second list', async () => {
    const view = await new PreferencesService(fakePrisma(null).service).view(
      USER,
    );

    expect(view.catalogue).toBe(INDIA_CITIES);
    expect(view.metroCityIds).toEqual(
      INDIA_CITIES.filter((city) => city.metro).map((city) => city.id),
    );
  });
});

describe('the preview count', () => {
  async function countFor(over: Partial<StatedLocations>): Promise<number> {
    const prisma = fakePrisma({ userId: USER, ...stated(over) });
    return (await new PreferencesService(prisma.service).view(USER))
      .matchingNow;
  }

  it('counts one city and nothing else', async () => {
    expect(await countFor({ cities: ['pune'] })).toBe(1);
  });

  it('counts every spelling of a city that has several', async () => {
    // "Gurugram" with no country named is a Delhi-NCR posting, and it is only counted
    // if the id expanded into that spelling.
    expect(await countFor({ cities: ['delhi-ncr'] })).toBe(1);
  });

  it('counts far more for anywhere-in-India than for one city', async () => {
    const wide = await countFor({ anywhereInIndia: true });
    const narrow = await countFor({ cities: ['pune'] });

    // The number's only job: making two settings comparable. Bengaluru, Pune,
    // Gurugram, Coimbatore and Remote - India all name somewhere in India.
    expect(wide).toBe(5);
    expect(wide).toBeGreaterThan(narrow);
  });

  it('counts remote-outside-India only when that switch is on', async () => {
    expect(
      await countFor({ remoteOutsideIndia: false, cities: ['pune'] }),
    ).toBe(1);
    expect(await countFor({ remoteOutsideIndia: true, cities: ['pune'] })).toBe(
      2,
    );
  });

  it('counts remote with no country stated separately from remote in India', async () => {
    expect(await countFor({ remoteIndia: true })).toBe(1);
    expect(await countFor({ remoteUnspecified: true })).toBe(1);
    expect(await countFor({ remoteIndia: true, remoteUnspecified: true })).toBe(
      2,
    );
  });

  it('never counts a closed posting', async () => {
    // Chennai is in the pool and is closed. If it ever appears the screen would be
    // promising a pipeline built out of jobs nobody can apply to.
    expect(await countFor({ cities: ['chennai'] })).toBe(0);
  });
});

describe('PreferencesService.save', () => {
  it('writes the preference and answers with the new state', async () => {
    const prisma = fakePrisma(null);

    const view = await new PreferencesService(prisma.service).save(
      USER,
      stated({ cities: ['bengaluru'], remoteIndia: true }),
    );

    expect(prisma.upserts).toHaveLength(1);
    // The reply is the view, so the screen does not have to re-fetch to show the new
    // count - and cannot show a count from before the save.
    expect(view.stated).toBe(true);
    expect(view.locations.cities).toEqual(['bengaluru']);
    expect(view.matchingNow).toBe(2);
  });
});

describe('PreferencesController', () => {
  const user = { id: USER } as SessionUser;

  function controller(row: (StatedLocations & { userId: string }) | null) {
    const prisma = fakePrisma(row);
    return {
      prisma,
      controller: new PreferencesController(
        new PreferencesService(prisma.service),
      ),
    };
  }

  it('accepts a well-formed body and saves it', async () => {
    const { controller: routes, prisma } = controller(null);

    await routes.save(user, {
      cities: ['pune', 'chennai'],
      anywhereInIndia: false,
      remoteIndia: true,
      remoteUnspecified: false,
      remoteOutsideIndia: false,
    });

    expect(prisma.stored?.cities).toEqual(['pune', 'chennai']);
  });

  // The refusals below use `expect(() => ...).toThrow` and not `rejects`: the body is
  // validated before anything async happens, so a bad request throws on the way in
  // rather than returning a rejected promise.
  it('refuses a city it does not know', () => {
    const { controller: routes } = controller(null);

    expect(() =>
      routes.save(user, {
        cities: ['pune', 'atlantis'],
        anywhereInIndia: false,
        remoteIndia: true,
        remoteUnspecified: false,
        remoteOutsideIndia: false,
      }),
    ).toThrow(BadRequestException);
  });

  it('refuses the combination that would match nothing, and says why', () => {
    const { controller: routes } = controller(null);

    let thrown: unknown;
    try {
      // `void`, because on the happy path this returns a promise - but validation runs
      // first and synchronously, so the throw happens before there is one to await.
      void routes.save(user, {
        cities: [],
        anywhereInIndia: false,
        remoteIndia: false,
        remoteUnspecified: false,
        remoteOutsideIndia: false,
      });
    } catch (err) {
      thrown = err;
    }

    // Asserted on the RESPONSE and not on `err.message`, which is the generic "Bad
    // Request Exception". The screen shows what the server sends back, so the sentence
    // explaining how to fix it has to be in the body or the candidate sees "400".
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect(
      JSON.stringify((thrown as BadRequestException).getResponse()),
    ).toMatch(/match nothing/);
  });

  it('refuses a body with a key it does not recognise', () => {
    // Strict, so a renamed field is an error rather than a setting that silently does
    // not apply - the failure that looks like the save worked.
    const { controller: routes } = controller(null);

    expect(() =>
      routes.save(user, {
        cities: [],
        anywhereInIndia: true,
        remoteIndia: true,
        remoteUnspecified: true,
        remoteOutsideIndia: false,
        allowRemoteOtherRegion: true,
      }),
    ).toThrow(BadRequestException);
  });

  it('refuses a missing switch rather than assuming one', () => {
    const { controller: routes } = controller(null);

    expect(() =>
      routes.save(user, { cities: ['pune'], anywhereInIndia: false }),
    ).toThrow(BadRequestException);
  });

  it('collapses a repeated city instead of rejecting it', async () => {
    const { controller: routes, prisma } = controller(null);

    await routes.save(user, {
      cities: ['pune', 'pune'],
      anywhereInIndia: false,
      remoteIndia: false,
      remoteUnspecified: false,
      remoteOutsideIndia: false,
    });

    expect(prisma.stored?.cities).toEqual(['pune']);
  });

  it('reads back the signed-in user and no other', async () => {
    const { controller: routes } = controller({
      userId: 'somebody-else',
      ...stated({ cities: ['mumbai'], remoteIndia: true }),
    });

    const view = await routes.view(user);

    // No route takes a user id, so the worst a mixed-up session can do is show the
    // file's defaults rather than another candidate's cities.
    expect(view.stated).toBe(false);
    expect(view.locations.cities).not.toContain('mumbai');
  });
});
