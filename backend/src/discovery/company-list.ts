/**
 * Reading config/companies.yaml - the seed list the whole project rests on.
 *
 * PLAN-v2 change 1 is blunt about why this file matters: four connectors already
 * cover the market, the spike's 22 productive boards yielded ~5 reachable roles
 * each, and so the output target of 8-12 applications a day is a function of HOW
 * MANY COMPANIES ARE ON THE LIST and almost nothing else. Connector code is done.
 * The list is the bottleneck.
 *
 * The file is grouped by tier rather than being a flat array with a `tier:` field on
 * every entry, for two reasons. It is a third of the lines, which matters at 400+
 * companies. And tier is a JUDGEMENT rather than an observation - grouping puts every
 * company that has been called T1 next to its peers, where a misfiled one is
 * obvious, instead of scattering the decision down 1,400 lines where it is not.
 *
 * Nothing here contacts the network or the database. Parsing and validating the list
 * is separable from acting on it, so a malformed file is a clean error before any
 * outbound request rather than a sweep that dies halfway through.
 */
import { AtsType, CompanyTier } from '@prisma/client';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * A slug, in the form the ATSes use.
 *
 * Lower case, alphanumeric and hyphens. Enforced rather than normalised: a slug is a
 * guess at a URL path segment, and silently lower-casing `PayTM` hides the fact that
 * whoever wrote it was thinking about the company's branding rather than its board.
 */
const slug = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    'must be lower case letters, digits and hyphens - it is a URL path segment, not a brand name',
  )
  .max(60);

/**
 * One entry.
 *
 * A bare `slug: Display Name` string is the normal form - 95% of the file - and the
 * object form exists for the two things that cannot be guessed: a board whose
 * identifier differs from the slug, and an entry that should not be probed at all.
 */
const entry = z.union([
  z.string().min(1).max(120),
  z
    .object({
      name: z.string().min(1).max(120),
      /** The ATS, when it is already known. Requires `token`. */
      ats: z.enum(AtsType).optional(),
      /** The board identifier on that ATS, when it differs from the slug. */
      token: z.string().min(1).max(120).optional(),
      /** Why this entry is unusual. For the reader, never parsed. */
      note: z.string().max(300).optional(),
    })
    .refine((v) => (v.ats === undefined) === (v.token === undefined), {
      message:
        'ats and token go together: an ATS without a token is not a board that can ' +
        'be fetched, and a token without an ATS does not say which API to send it to',
    }),
]);

const TIER_KEYS = {
  t1_global_india_office: CompanyTier.T1_GLOBAL_INDIA_OFFICE,
  t2_funded_indian_startup: CompanyTier.T2_FUNDED_INDIAN_STARTUP,
  t3_indian_midmarket: CompanyTier.T3_INDIAN_MIDMARKET,
  t4_services_staffing: CompanyTier.T4_SERVICES_STAFFING,
} as const;

const companyListFile = z
  .object({
    t1_global_india_office: z.record(slug, entry).default({}),
    t2_funded_indian_startup: z.record(slug, entry).default({}),
    t3_indian_midmarket: z.record(slug, entry).default({}),
    t4_services_staffing: z.record(slug, entry).default({}),
  })
  // Unknown top-level keys are rejected rather than ignored. A typo'd tier heading
  // would otherwise drop a whole category silently, and "150 companies vanished" is
  // not a failure anyone notices by reading a summary line.
  .strict();

/** One company, ready to probe or adopt. */
export interface CompanyListEntry {
  slug: string;
  name: string;
  tier: CompanyTier;
  /** Set together, and only when the board is already known. */
  atsType?: AtsType;
  token?: string;
  isAgency: boolean;
}

export class CompanyListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompanyListError';
  }
}

/** Where the list lives, relative to the repo root. */
export const COMPANY_LIST_PATH = 'config/companies.yaml';

/**
 * Loads and validates the list.
 *
 * A slug appearing under two tiers is a hard error, not a last-one-wins: the two
 * entries are two different claims about the same company's pay band, and picking
 * one at random is how a T4 staffing agency ends up ranked as a T1.
 */
export function loadCompanyList(path?: string): CompanyListEntry[] {
  const file = path ?? resolve(process.cwd(), '..', COMPANY_LIST_PATH);

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new CompanyListError(
      `could not read ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = companyListFile.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new CompanyListError(
      `${file} is not a valid company list:\n` +
        parsed.error.issues
          .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('\n'),
    );
  }

  const entries: CompanyListEntry[] = [];
  const seen = new Map<string, CompanyTier>();

  for (const [key, tier] of Object.entries(TIER_KEYS)) {
    const group = parsed.data[key as keyof typeof TIER_KEYS];

    for (const [companySlug, value] of Object.entries(group)) {
      const previous = seen.get(companySlug);
      if (previous) {
        throw new CompanyListError(
          `${companySlug} is listed under both ${previous} and ${tier}. Tier is the ` +
            'primary pay signal, so the two entries are contradictory claims about ' +
            'what the company pays - pick one.',
        );
      }
      seen.set(companySlug, tier);

      const detail = typeof value === 'string' ? { name: value } : value;
      entries.push({
        slug: companySlug,
        name: detail.name,
        tier,
        atsType: 'ats' in detail ? detail.ats : undefined,
        token: 'token' in detail ? detail.token : undefined,
        // Agencies are exactly T4. The flag is redundant with the tier today and
        // kept separate because it means something different: tier is about pay,
        // isAgency is about whether the "employer" is the employer at all.
        isAgency: tier === CompanyTier.T4_SERVICES_STAFFING,
      });
    }
  }

  return entries;
}

/** Counts per tier, for the summary a sweep prints before it starts. */
export function tierCounts(
  entries: CompanyListEntry[],
): Record<CompanyTier, number> {
  const counts = {
    [CompanyTier.T1_GLOBAL_INDIA_OFFICE]: 0,
    [CompanyTier.T2_FUNDED_INDIAN_STARTUP]: 0,
    [CompanyTier.T3_INDIAN_MIDMARKET]: 0,
    [CompanyTier.T4_SERVICES_STAFFING]: 0,
    [CompanyTier.UNKNOWN]: 0,
  };
  for (const e of entries) counts[e.tier]++;
  return counts;
}
