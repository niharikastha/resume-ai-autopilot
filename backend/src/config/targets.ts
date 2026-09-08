/**
 * Reading config/targets.yaml - the rules stage 1 of the funnel applies.
 *
 * Validated with Zod for the same reason every other boundary in this project is:
 * a typo in a YAML key is otherwise `undefined`, and `undefined` in a filter reads
 * as "no rule" rather than as an error. A misspelled `dealbrakers:` would silently
 * disable every dealbreaker, and nothing downstream could tell - a rejected posting
 * leaves no trace, so a filter that has stopped filtering looks exactly like a clean
 * run with a generous pool.
 *
 * So the schema is `.strict()` at every level and the defaults are deliberately
 * ABSENT rather than permissive: a missing `titles.include` is an error, not an
 * empty list that matches nothing (which would reject everything) and not a wildcard
 * (which would apply to everything).
 *
 * Loaded once and cached. The file is read at the start of a matching run, not per
 * posting, and a change to it takes effect on the next run rather than mid-pass -
 * a funnel whose rules changed halfway through is not a funnel whose survivor counts
 * mean anything.
 */
import { CompanyTier } from '@prisma/client';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/** Where the file lives, relative to the repo root. */
export const TARGETS_PATH = 'config/targets.yaml';

/**
 * A list of match terms, requiring at least `atLeast` of them.
 *
 * Lower-cased on load, because every comparison downstream is against a normalized
 * (lower case) title or a lower-cased description. Doing it here means the file can
 * be written however reads best and a stray capital cannot produce a term that never
 * matches anything.
 *
 * A builder rather than one shared schema because the length rule has to be applied
 * to the array BEFORE the lower-casing transform - a transform's output is a pipe,
 * and a pipe has no `.min()`. Getting that order wrong is a compile error rather than
 * a silent hole, which is the only reason this reads as awkwardly as it does.
 */
function terms(atLeast: number, why?: string) {
  return z
    .array(z.string().trim().min(1).max(120))
    .min(atLeast, why)
    .transform((list) => list.map((t) => t.toLowerCase()));
}

const targetsFile = z
  .object({
    titles: z
      .object({
        include: terms(1, 'at least one include term, or nothing can match'),
        exclude: terms(0).default([]),
      })
      .strict(),

    seniority: z
      .object({
        allow: z
          .array(z.enum(['junior', 'mid', 'senior', 'staff', 'unknown']))
          .min(1),
      })
      .strict(),

    experience: z
      .object({
        minYears: z.number().int().min(0).max(50),
        maxYears: z.number().int().min(0).max(50),
        candidateYears: z.number().min(0).max(50),
      })
      .strict()
      .refine((v) => v.maxYears >= v.minYears, {
        message: 'maxYears must not be below minYears',
      }),

    locations: z
      .object({
        allow: terms(1),
        allowRemoteIndia: z.boolean(),
        allowRemoteUnspecified: z.boolean(),
        // Defaulted rather than required, unlike every other key in this file. It
        // was added after the file was already in use, and the safe reading of its
        // absence is the behaviour that existed before it: a remote role in another
        // region is not applicable. Requiring it would have made an existing,
        // correct targets.yaml fail to load on upgrade.
        allowRemoteOtherRegion: z.boolean().default(false),
      })
      .strict(),

    keywords: z
      .object({
        mustHaveAny: terms(1),
        dealbreakers: terms(0).default([]),
      })
      .strict(),

    freshness: z
      .object({
        maxAgeDays: z.number().int().min(1).max(365),
        allowUnknownAge: z.boolean(),
      })
      .strict(),

    limits: z
      .object({
        maxApplicationsPerDay: z.number().int().min(1).max(100),
        perCompanyCooldownDays: z.number().int().min(0).max(365),
      })
      .strict(),

    pay: z
      .object({
        floorLPA: z.number().min(0).max(500),
        // Every tier must appear exactly once. A partial list would leave some
        // tier with no defined rank, and "unranked" in a sort is an arbitrary
        // position rather than a last one.
        tierPreference: z
          .array(z.enum(CompanyTier))
          .refine(
            (list) =>
              new Set(list).size === list.length &&
              list.length === Object.values(CompanyTier).length,
            {
              message:
                'tierPreference must list every CompanyTier exactly once, so ' +
                'every company has a defined rank',
            },
          ),
      })
      .strict(),
  })
  .strict();

export type Targets = z.infer<typeof targetsFile>;

export class TargetsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetsError';
  }
}

let cached: { path: string; targets: Targets } | undefined;

/** Loads, validates and caches the targets file. */
export function loadTargets(path?: string): Targets {
  const file = path ?? resolve(process.cwd(), '..', TARGETS_PATH);
  if (cached?.path === file) return cached.targets;

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new TargetsError(
      `could not read ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = targetsFile.safeParse(raw);
  if (!parsed.success) {
    throw new TargetsError(
      `${file} is not a valid targets file:\n` +
        parsed.error.issues
          .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('\n'),
    );
  }

  cached = { path: file, targets: parsed.data };
  return parsed.data;
}

/** Drops the cache. For tests, and for a long-lived worker that should re-read. */
export function clearTargetsCache(): void {
  cached = undefined;
}

/**
 * Rank of a tier in the preference order. Lower sorts first.
 *
 * A tier the file somehow omits sorts last rather than first, which is the failure
 * that loses nothing - the schema already refuses such a file, so this is the second
 * line of defence rather than the first.
 */
export function tierRank(targets: Targets, tier: CompanyTier): number {
  const at = targets.pay.tierPreference.indexOf(tier);
  return at === -1 ? targets.pay.tierPreference.length : at;
}
