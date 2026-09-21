/**
 * Deciding whether an employer's name is one the candidate has ruled out.
 *
 * A PURE FUNCTION, AND DELIBERATELY NOT A SERVICE, for the same reason
 * config/locations.ts is one: four surfaces need this answer and two of them run in
 * containers assembled by hand (cli/match.ts, cli/submit.ts). A function with no
 * dependencies is one import in each of them rather than a provider that four modules
 * have to remember to wire - and the wiring is what would eventually drift, leaving one
 * surface applying the rule and another ignoring it.
 *
 * WHY MATCHING IS NOT STRING EQUALITY. The candidate types "Hyscaler". The names that
 * arrive from job boards are "HyScaler", "Hyscaler Solutions Pvt. Ltd.", "HyScaler
 * Technologies Private Limited" - and whichever of those is in the table today is not
 * the one that will be there after the employer rebrands. Equality would make the rule
 * silently stop working, which is the worst possible failure for a blocklist: it does
 * not error, it just applies to the job.
 *
 * WHY NOT `includes` EITHER. The other direction fails worse. `ola` is a plausible
 * blocklist entry and a substring of Motorola, Coca-Cola and Solarisbank; `hcl` is a
 * substring of nothing useful but `ibm` is inside "Fibmesh". A blocklist that quietly
 * removes the wrong employer's jobs is invisible - a screened-out posting leaves no row
 * behind, exactly as stage 1's own docstring says.
 *
 * SO: TOKEN-SEQUENCE CONTAINMENT. Both sides are reduced to a list of words, and the
 * entry matches when its words appear consecutively in the company's words. "hyscaler"
 * matches "HyScaler Technologies" because `[hyscaler]` is a run inside
 * `[hyscaler, technologies]`; "ola" does not match Motorola because `[ola]` is not a
 * run inside `[motorola]`. That is a word-boundary test, which is the same rule
 * stage1.screen.ts settled on for its title lists after `intern` was found rejecting
 * "Internal Systems".
 */

/**
 * Words that say what kind of legal entity a company is, not which one.
 *
 * Stripped from both sides, so "Hyscaler" entered by hand matches "Hyscaler Solutions
 * Pvt. Ltd." from a board, and so entering the long form matches the short one. These
 * are the only words removed - nothing here is ever part of what distinguishes one
 * employer from another, whereas "technologies", "labs" and "systems" routinely are
 * ("Bosch" and "Bosch Global Software Technologies" are different employers with
 * different boards, and collapsing them would block the wrong one).
 *
 * `inc`, `co` and `sa` are the risky entries - real short names could be spelled that
 * way - and they are safe here only because a name is never reduced to nothing: see
 * `normalizeCompany`.
 */
const LEGAL_FORMS = new Set([
  'pvt',
  'pvt.',
  'private',
  'ltd',
  'ltd.',
  'limited',
  'llp',
  'llc',
  'inc',
  'inc.',
  'incorporated',
  'corp',
  'corp.',
  'corporation',
  'co',
  'co.',
  'company',
  'gmbh',
  'ag',
  'nv',
  'bv',
  'plc',
  'sa',
  'srl',
  'pte',
  'oy',
  'ab',
  'as',
  'kk',
]);

/**
 * A company name reduced to the words that identify it, space-separated.
 *
 * `&` becomes `and` before punctuation is dropped, because "Johnson & Johnson" and
 * "Johnson and Johnson" are one employer and stripping the ampersand outright would
 * leave "johnson johnson" to be matched against "johnson and johnson" - two token lists
 * that no longer contain one another.
 *
 * THE LEGAL-FORM STRIP IS SKIPPED IF IT WOULD EMPTY THE NAME. There are real employers
 * called "Inc." and "Co", and a company whose whole name is a legal form must still be
 * blockable; more importantly an empty pattern would be a run inside EVERY name, so a
 * single such entry would block the entire job market. That is the failure this guard
 * exists for, not the naming edge case.
 */
export function normalizeCompany(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/&/g, ' and ')
    // Keep letters, digits and spaces. Dots, commas and hyphens are punctuation in
    // company names ("Pvt. Ltd.", "Zeta-Suite"), never meaning.
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word.length > 0);

  const identifying = words.filter((word) => !LEGAL_FORMS.has(word));
  return (identifying.length > 0 ? identifying : words).join(' ');
}

/** One row of the candidate's list, as much of it as matching needs. */
export interface BlockedPattern {
  /** `normalizeCompany(label)`, as stored on BlockedCompany.pattern. */
  pattern: string;
  /** What they typed. Used only to name the rule that fired, in logs and in skips. */
  label: string;
}

/**
 * The first rule that rules this employer out, or undefined if none does.
 *
 * Returns the RULE rather than a boolean so every caller can name it: stage 1 puts it
 * in the rejection histogram's example, the apply plan puts it in the sentence
 * explaining the skip. "Blocked" on its own is the kind of message that sends somebody
 * looking through a database for which of eleven entries did it.
 *
 * A NULL NAME IS NEVER BLOCKED. A posting whose company was never resolved has no name
 * to have ruled out; it is dropped later by the apply path for that same reason, with a
 * message about tracking rather than about a preference the candidate never expressed.
 */
export function blockedBy(
  companyName: string | null | undefined,
  blocked: readonly BlockedPattern[],
): BlockedPattern | undefined {
  if (!companyName || blocked.length === 0) return undefined;

  const words = normalizeCompany(companyName).split(' ');
  return blocked.find((rule) => containsRun(words, rule.pattern.split(' ')));
}

/**
 * Whether `needle`'s words appear consecutively in `haystack`'s.
 *
 * Written out rather than done by joining both sides and calling `includes`, because
 * that trick matches on word FRAGMENTS at the seams: `'ola'` is a substring of
 * `'motorola one'` however many spaces are added around it. Comparing word by word is
 * the whole point of normalising to words first.
 */
function containsRun(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;

  for (let at = 0; at <= haystack.length - needle.length; at++) {
    if (needle.every((word, offset) => haystack[at + offset] === word)) {
      return true;
    }
  }
  return false;
}

/**
 * Which of these companies the candidate has ruled out.
 *
 * FOR THE SURFACES THAT FILTER IN SQL. The suggestion list and the digest query
 * `match_scores` by `companyId`, and token matching cannot be expressed in a WHERE
 * clause - so those resolve the words to ids once and pass an `IN` list. The company
 * table is in the low hundreds of rows, which is why resolving it eagerly is cheaper
 * than the alternative of loading every score and filtering in memory.
 *
 * Kept next to `blockedBy` so the two cannot disagree: one reads the same function the
 * other does.
 */
export function blockedCompanyIds(
  companies: readonly { id: string; name: string }[],
  blocked: readonly BlockedPattern[],
): string[] {
  if (blocked.length === 0) return [];
  return companies
    .filter((company) => blockedBy(company.name, blocked) !== undefined)
    .map((company) => company.id);
}
