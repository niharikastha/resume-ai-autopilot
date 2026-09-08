/**
 * Reading and writing where a candidate is willing to work.
 *
 * THE SCREEN IS THE POINT OF THIS FILE. The location rule used to live in
 * config/targets.yaml, which meant the answer to "would you move to Chennai" was a
 * file on a server - and the four cities it happened to contain were silently
 * rejecting 31 real Indian postings. A preference nobody can see is a preference
 * nobody can correct.
 *
 * IT ALSO REPORTS THE COST OF THE CHOICE. `preview` counts the open postings each
 * setting admits, because "anywhere in India" and "Bengaluru only" are indistinguishable
 * as switches and are not remotely the same pipeline. The count is what makes the
 * screen answerable rather than a guess with checkboxes.
 */
import { Injectable, Logger } from '@nestjs/common';
import { RemoteType } from '@prisma/client';
import { INDIA_CITIES, type IndiaCity } from '../config/india-cities';
import { locationsFor, type StatedLocations } from '../config/locations';
import { loadTargets } from '../config/targets';
import { PrismaService } from '../prisma/prisma.service';

/** The screen's whole state in one response. */
export interface PreferencesView {
  /** What is in force. Derived from the file when the candidate has stated nothing. */
  locations: StatedLocations;
  /** False while the file's defaults are in force, so the UI can say so. */
  stated: boolean;
  /** The checkbox list, from the one catalogue. */
  catalogue: readonly IndiaCity[];
  /** City ids in the "big metros" preset, so the button is not a second list. */
  metroCityIds: readonly string[];
  /** How many open postings this preference admits right now. */
  matchingNow: number;
}

@Injectable()
export class PreferencesService {
  private readonly logger = new Logger(PreferencesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async view(userId: string): Promise<PreferencesView> {
    const row = await this.prisma.jobPreference.findUnique({
      where: { userId },
    });

    const locations = row ? statedOf(row) : fromTargets();

    return {
      locations,
      stated: row !== null,
      catalogue: INDIA_CITIES,
      metroCityIds: INDIA_CITIES.filter((city) => city.metro).map(
        (city) => city.id,
      ),
      matchingNow: await this.countMatching(locations),
    };
  }

  /**
   * Saves it. Upsert, because the first save is a create and the screen cannot know
   * which it is - and asking it to would make "have I saved before" a thing the UI
   * has to track correctly.
   */
  async save(
    userId: string,
    stated: StatedLocations,
  ): Promise<PreferencesView> {
    await this.prisma.jobPreference.upsert({
      where: { userId },
      create: { userId, ...stated },
      update: stated,
    });
    this.logger.log(
      `${userId} set locations: ${stated.anywhereInIndia ? 'anywhere in India' : `${stated.cities.length} city(ies)`}, ` +
        `remote india=${stated.remoteIndia}, unspecified=${stated.remoteUnspecified}, ` +
        `outside india=${stated.remoteOutsideIndia}`,
    );
    return this.view(userId);
  }

  /**
   * How many open postings a preference would admit, counted as a preview.
   *
   * DELIBERATELY THE LOCATION RULE ALONE, not the whole funnel. The number's job is
   * to make two settings comparable - "anywhere in India" against "Bengaluru only" -
   * and running the title, keyword and freshness rules as well would fold in
   * rejections that have nothing to do with the choice being made. So this over-counts
   * on purpose, and the UI says "postings in these places", not "matches".
   *
   * Done in SQL rather than by loading every posting and screening it: the pool is
   * ~16,000 rows, and this runs on every keystroke-free save and on page load.
   */
  private async countMatching(stated: StatedLocations): Promise<number> {
    const targets = loadTargets();
    const rule = locationsFor(stated, targets);

    const remoteTypes: RemoteType[] = [];
    if (rule.allowRemoteIndia) remoteTypes.push(RemoteType.REMOTE_INDIA);
    if (rule.allowRemoteUnspecified) remoteTypes.push(RemoteType.REMOTE_GLOBAL);
    if (rule.allowRemoteOtherRegion) {
      remoteTypes.push(RemoteType.REMOTE_OTHER_REGION);
    }

    // `contains` and not a word-boundary regex, unlike the real screen. Postgres has
    // no cheap word-boundary index and this is an estimate by construction; the terms
    // that would differ are the short ones ('ind'), and they only ever make this
    // count too high - which is the safe direction for a number labelled "in these
    // places".
    return this.prisma.jobPosting.count({
      where: {
        closedAt: null,
        OR: [
          ...(remoteTypes.length > 0
            ? [{ remoteType: { in: remoteTypes } }]
            : []),
          ...rule.allow.map((term) => ({
            location: { contains: term, mode: 'insensitive' as const },
          })),
        ],
      },
    });
  }
}

/** The columns, without the row's bookkeeping. */
function statedOf(row: StatedLocations): StatedLocations {
  return {
    cities: row.cities,
    anywhereInIndia: row.anywhereInIndia,
    remoteIndia: row.remoteIndia,
    remoteUnspecified: row.remoteUnspecified,
    remoteOutsideIndia: row.remoteOutsideIndia,
  };
}

/**
 * The file's rule, expressed in the screen's vocabulary.
 *
 * Shown to a candidate who has never saved anything, so the screen opens on what is
 * actually in force rather than on empty boxes that would offer to narrow their
 * pipeline to nothing. The cities are matched back by TERM, because the file lists
 * words and the screen speaks in city ids - a term the catalogue does not know (the
 * file's bare `india`) is what sets `anywhereInIndia`.
 */
function fromTargets(): StatedLocations {
  const targets = loadTargets();
  const allow = targets.locations.allow;

  return {
    cities: INDIA_CITIES.filter((city) =>
      city.terms.some((term) => allow.includes(term)),
    ).map((city) => city.id),
    anywhereInIndia: allow.includes('india'),
    remoteIndia: targets.locations.allowRemoteIndia,
    remoteUnspecified: targets.locations.allowRemoteUnspecified,
    remoteOutsideIndia: targets.locations.allowRemoteOtherRegion,
  };
}
