/**
 * Deriving the fields that are computed from a posting rather than reported by it:
 * the dedup key, remote eligibility, and a coarse seniority guess.
 *
 * SHARED ON PURPOSE, with prisma/seed.ts. These started out inside the seed, and
 * copying them into the connectors would have been the natural thing to do - and
 * would have been a bug. `normalizedTitle` is a DEDUP KEY: `applications` is
 * UNIQUE(userId, companyId, normalizedTitle), and `job_postings` is looked up by
 * it. Two implementations that disagree by one character - a stripped hyphen, a
 * collapsed space - mean the seed and the connector consider the same job to be
 * two different jobs, and the duplicate-application guard stops guarding. One
 * function, imported by both, is what makes that impossible rather than unlikely.
 */
import { RemoteType } from '@prisma/client';

/**
 * The Indian locations worth recognising, as whole words.
 *
 * `\b` matters: without it "pune" matches inside "Puneet" and "delhi" inside
 * "New Delhi Township, Ohio". Both are real string-matching failures, and the
 * cost of getting them wrong is a job in the wrong country entering the pool.
 */
const IN_LOCATION =
  /\b(india|bengaluru|bangalore|hyderabad|pune|mumbai|new delhi|delhi|gurgaon|gurugram|noida|chennai|kolkata|bhubaneswar|ahmedabad|jaipur|indore|kochi|coimbatore|trivandrum|thiruvananthapuram)\b/i;

const OTHER_REGION =
  /\b(us|usa|united states|canada|emea|uk|united kingdom|europe|latam|brazil|germany|singapore|australia|japan|apac)\b/i;

const SENIOR =
  /\b(senior|sr\.?|staff|principal|lead|director|head of|chief|iii|iv|v)\b/i;
const JUNIOR = /\b(junior|jr\.?|associate|graduate|entry|intern|i{1,2})\b/i;

/**
 * The dedup key: lower-cased, punctuation-stripped, whitespace-collapsed.
 *
 * `\p{L}\p{N}` rather than `a-z0-9`. The ASCII class stripped every character of a
 * Japanese title, leaving '' - and an empty normalizedTitle is not cosmetic: every
 * posting that normalizes to '' collides with every other one at that company, so
 * the second application is refused as a duplicate of a role it has nothing to do
 * with. Two such rows existed in the live table until a migration backfilled them.
 *
 * The `u` flag is required for `\p{...}` to mean anything; without it the pattern
 * is a literal `p` followed by a brace group.
 */
export function normalizeTitle(title: string): string {
  const normalized = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // A title made only of punctuation still normalizes to nothing. Falling back to
  // the raw title keeps this function's promise - never empty for a non-empty
  // input - which is what the NOT-empty CHECK constraint relies on.
  return normalized || title.toLowerCase().trim();
}

/**
 * Remote ELIGIBILITY, not merely the remote flag.
 *
 * "Remote - India" is applicable and "Remote - US" is not, and collapsing both to
 * REMOTE would fill the pool with jobs that cannot be taken. That distinction is
 * the entire reason this enum has five members instead of two.
 *
 * `explicitlyRemote` is for the connectors whose API states remoteness as a field
 * (Ashby's `isRemote`, Lever's `workplaceType`) rather than leaving it in the
 * location string. A job tagged remote by the ATS but located "Bengaluru" is
 * REMOTE_INDIA; read from the string alone it would look ONSITE.
 */
export function remoteType(
  location: string,
  explicitlyRemote?: boolean,
  workplaceType?: string | null,
): RemoteType {
  const l = location.toLowerCase();
  const wt = (workplaceType ?? '').toLowerCase();

  const isHybrid = /\bhybrid\b/.test(l) || wt === 'hybrid';
  const isRemote =
    /\bremote\b/.test(l) || wt === 'remote' || explicitlyRemote === true;
  const inIndia = IN_LOCATION.test(location);

  // Hybrid first: "Hybrid - Remote/Bengaluru" is a hybrid role, and testing remote
  // first would classify it as fully remote and overstate its flexibility.
  if (isHybrid) return RemoteType.HYBRID;
  if (isRemote && inIndia) return RemoteType.REMOTE_INDIA;
  if (isRemote && OTHER_REGION.test(l)) return RemoteType.REMOTE_OTHER_REGION;
  if (isRemote) return RemoteType.REMOTE_GLOBAL;
  if (inIndia) return RemoteType.ONSITE;

  // Not India, not remote. UNKNOWN rather than ONSITE: we know where it is not, and
  // recording a confident ONSITE for a job in Berlin would let it read as
  // addressable later.
  return RemoteType.UNKNOWN;
}

/**
 * A coarse seniority bucket from the title.
 *
 * Deliberately three values and deliberately a guess. The real seniority signal is
 * in the description's years-of-experience line, which phase 2's LLM pass reads;
 * this exists so the pool can be ranked before that runs, and so a "Principal
 * Engineer" is not surfaced to a candidate with three years of experience.
 */
export function seniority(title: string): string {
  if (SENIOR.test(title)) return 'senior';
  if (JUNIOR.test(title)) return 'junior';
  return 'mid';
}

/** True if this location is somewhere the candidate could actually work. */
export function isAddressableLocation(location: string): boolean {
  const type = remoteType(location);
  return (
    type === RemoteType.ONSITE ||
    type === RemoteType.HYBRID ||
    type === RemoteType.REMOTE_INDIA ||
    type === RemoteType.REMOTE_GLOBAL
  );
}
