/**
 * Finding the numbers in a sentence, and comparing two of them.
 *
 * This file is small and load-bearing. Phase 5's provenance guard rejects a
 * tailored bullet if it contains a number that is not in the source atom's
 * `metrics`, and BOTH sides of that comparison run through here - the metrics are
 * extracted with `numbersIn` at ingestion, and the guard extracts the rewritten
 * bullet's numbers with the same function. If the two used different rules, the
 * guard would reject honest rewrites (an unstated "10,000" written as "10K") or
 * pass invented ones, and either failure is invisible from the outside.
 *
 * The hard part is that a resume is full of digits that are not quantities:
 *
 *   HL7/FHIR              the 7 is part of a standard's name
 *   Log4j, S3, EC2, H100  digits inside a product name
 *   Node.js 20, Python 3  a version
 *   SDE-1, GPT-4, Llama-3 a hyphenated name or job level
 *
 * A `\d+` scan treats all of those as achievements, and every one it adds to
 * `metrics` is a number the guard will then permit in a tailored bullet. So the
 * rule is deliberately narrow: a digit run is a number only when a letter is not
 * touching it on either side, DIRECTLY OR THROUGH A HYPHEN. That drops HL7 and
 * S3, keeps 65%, 10,000+, 10K+ and 99.9%, and keeps 2024 - a year is a number
 * that genuinely appears in the text, and the guard's question is "did this
 * figure come from the atom", not "is this figure impressive".
 *
 * A SPACED hyphen is not covered, and that asymmetry is deliberate. "Reduced p99
 * latency - 40%" is how a resume introduces a metric, and refusing to read the
 * 40% there would be the expensive kind of mistake: the figure would be missing
 * from the atom's metrics, so a rewrite that restated it honestly would be
 * rejected. "Engineer - 1" written that way therefore does still register as a
 * bare 1, which only ever widens what the guard permits for that one atom, and
 * the candidate sees it in the metrics list at the confirmation gate.
 */

/**
 * A number as it appears, plus the value and unit needed to compare it.
 *
 * `surface` is kept because the printout at the confirmation gate should show the
 * candidate what their own resume says, not a normalised rendering of it.
 */
export interface FoundNumber {
  /** Exactly the characters matched, e.g. `"10,000+"`, `"99.9%"`, `"40+"`. */
  surface: string;
  /** Magnitude with any K/M/B suffix applied. `"10K"` -> 10000. */
  value: number;
  /** `'%'`, `'x'`, or `''`. A percentage and a bare count are not the same claim. */
  unit: '%' | 'x' | '';
  /** True for `"40+"` / `"10,000+"` - "at least", which a rewrite may not drop. */
  atLeast: boolean;
}

/**
 * Magnitude suffixes, lowercased.
 *
 * `k`/`m`/`b` only. Not `t` (trillion), which in practice is a unit letter -
 * "3T" is a disk size, and treating it as a suffix would swallow the letter.
 */
const SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

/**
 * The one pattern.
 *
 *   (?<![A-Za-z0-9.])   nothing lettery before it, and no digit or dot either -
 *                       the dot stops "99.9" from also yielding a bare ".9", and
 *                       stops "v1.2.3" from producing three numbers.
 *   (?<![A-Za-z]-)      and not a letter joined by a hyphen either, which is what
 *                       rejects the 1 in SDE-1 and the 4 in GPT-4. MEASURED, not
 *                       hypothetical: a tailored headline copied the candidate's
 *                       real job title "Hyscaler SDE-1" and the guard threw the
 *                       whole variant away over the 1. Digit-hyphen-digit is
 *                       untouched, so the "2024" in "2023-2024" still reads.
 *   \d[\d,]*(?:\.\d+)?  digits with thousands separators, optional decimal.
 *   (?:\s?[KkMmBb])?    an optional magnitude suffix, with or without a space.
 *   \+?                 the "at least" marker.
 *   \s?(?:%|x\b)?       percent or a multiplier, optionally spaced.
 *   (?![A-Za-z0-9])     and nothing lettery after - which is what rejects the
 *                       7 in HL7 and the 3 in S3.
 *
 * The suffix and unit groups sit INSIDE the pattern rather than being matched in
 * a second pass, because `(?![A-Za-z0-9])` has to be evaluated after them: "10K"
 * ends in a letter, and a lookahead applied to "10" alone would reject it.
 */
const NUMBER =
  /(?<![A-Za-z0-9.])(?<![A-Za-z]-)(\d[\d,]*(?:\.\d+)?)(\s?[KkMmBb])?(\+)?(\s?%|\s?x(?![A-Za-z]))?(?![A-Za-z0-9])/g;

/**
 * Every number in a piece of text, in order, deduped by surface form.
 *
 * Deduped because "improved 40% and 40% again" is one distinct figure as far as
 * the guard is concerned, and a metrics array with repeats is noise at the
 * confirmation gate.
 */
export function numbersIn(text: string): FoundNumber[] {
  const out: FoundNumber[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(NUMBER)) {
    const [surface, digits, suffix, plus, unitRaw] = match;

    const base = Number(digits.replace(/,/g, ''));
    if (!Number.isFinite(base)) continue;

    const multiplier = suffix ? SUFFIX[suffix.trim().toLowerCase()] : 1;
    const unitText = unitRaw?.trim().toLowerCase();
    const unit: FoundNumber['unit'] =
      unitText === '%' ? '%' : unitText === 'x' ? 'x' : '';

    const trimmed = surface.trim();
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);

    out.push({
      surface: trimmed,
      value: base * multiplier,
      unit,
      atLeast: plus === '+',
    });
  }

  return out;
}

/** The surface forms only - what gets stored in `ProfileAtom.metrics`. */
export function metricsIn(text: string): string[] {
  return numbersIn(text).map((n) => n.surface);
}

/**
 * Whether `claim` is a number the atom actually supports.
 *
 * Value and unit must both agree, so "40%" does not license "40x" and does not
 * license a bare "40". `atLeast` is checked in one direction only: an atom
 * saying "10,000+" supports a rewrite that says "10,000", because dropping the
 * plus UNDERSTATES the achievement. The reverse - the atom says "10,000" and the
 * rewrite says "10,000+" - is a stronger claim than the source, so it fails.
 *
 * Exported here rather than living in the guard so that the confirmation gate and
 * the guard cannot drift apart.
 */
export function supportsNumber(
  atomNumbers: readonly FoundNumber[],
  claim: FoundNumber,
): boolean {
  return atomNumbers.some(
    (source) =>
      source.value === claim.value &&
      source.unit === claim.unit &&
      (source.atLeast || !claim.atLeast),
  );
}
