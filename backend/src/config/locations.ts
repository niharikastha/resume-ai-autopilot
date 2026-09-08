/**
 * Turning a candidate's stated preference into the location rule stage 1 applies.
 *
 * A PURE FUNCTION, AND DELIBERATELY NOT A SERVICE. MatchingService, the match CLI and
 * the preferences screen all need the same answer, and two of those three run in
 * containers assembled by hand (see cli/match.ts). A function with no dependencies is
 * one import in each of them instead of a provider three modules have to remember.
 *
 * ABSENT MEANS "USE THE FILE". `locationsFor(null, targets)` returns the YAML's own
 * rule untouched, so a candidate who has never opened the screen is matched exactly as
 * they were before this existed. That is what makes the feature additive rather than a
 * silent change to everybody's funnel.
 *
 * See JobPreference in schema.prisma for why the preference belongs to a person.
 */
import type { Targets } from './targets';
import { allIndiaTerms, termsForCities } from './india-cities';

/** The columns of JobPreference this reads. */
export interface StatedLocations {
  cities: string[];
  anywhereInIndia: boolean;
  remoteIndia: boolean;
  remoteUnspecified: boolean;
  remoteOutsideIndia: boolean;
}

/**
 * The effective location rule.
 *
 * `allow` MAY COME BACK EMPTY, and that is a meaningful answer rather than a bug: a
 * candidate who ticked no city and left "anywhere in India" off has said they only
 * want remote work, and an empty allow list is exactly the rule that admits remote
 * postings and rejects every posting that names a place. The YAML schema requires at
 * least one term because a FILE with an empty list is far more likely to be a typo
 * than an intention; a preference row is not, because the screen refuses to save a
 * combination that would match nothing at all.
 */
export function locationsFor(
  stated: StatedLocations | null,
  targets: Targets,
): Targets['locations'] {
  if (!stated) return targets.locations;

  return {
    allow: stated.anywhereInIndia
      ? allIndiaTerms()
      : termsForCities(stated.cities),
    allowRemoteIndia: stated.remoteIndia,
    allowRemoteUnspecified: stated.remoteUnspecified,
    allowRemoteOtherRegion: stated.remoteOutsideIndia,
  };
}

/**
 * `targets` with this candidate's location rule in place of the file's.
 *
 * A NEW OBJECT, never a mutation. `loadTargets` caches and hands the same object to
 * every caller in the process, so assigning to `targets.locations` would give the next
 * candidate matched by that worker the previous candidate's cities - a bug that only
 * appears with two accounts and cannot be reproduced by running one.
 */
export function withStatedLocations(
  targets: Targets,
  stated: StatedLocations | null,
): Targets {
  return { ...targets, locations: locationsFor(stated, targets) };
}

/**
 * Whether a preference would admit nothing at all.
 *
 * The one combination the screen must refuse: no city, not anywhere-in-India, and no
 * kind of remote. It is saveable in the sense that every field is valid on its own,
 * and it silently empties the candidate's pipeline - the funnel would report "0
 * survivors" every morning with no rule visibly wrong.
 */
export function matchesNothing(stated: StatedLocations): boolean {
  return (
    !stated.anywhereInIndia &&
    stated.cities.length === 0 &&
    !stated.remoteIndia &&
    !stated.remoteUnspecified &&
    !stated.remoteOutsideIndia
  );
}
