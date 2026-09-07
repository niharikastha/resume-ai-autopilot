/**
 * The provenance guard. Phase 5's load-bearing part.
 *
 * The tailoring task's schema stops the model from having a PLACE to put a
 * fabrication - a rewrite is `{ atomId, text }`, so there is no field in which a
 * free-standing invented bullet could arrive. That is layer 1, and it does not hold
 * on its own: nothing in the schema stops the model from fabricating INSIDE a `text`
 * field that cites a perfectly real atom. Claiming 85% where the atom says 65%.
 * Adding Kafka to a bullet about a queue because the posting asked for Kafka.
 * Moving a bullet from one employer to a more impressive one.
 *
 * This file is the layer that catches that, and it FAILS CLOSED: any violation
 * discards the whole variant and the caller falls back to the base resume. Fails
 * closed rather than fails-partial on purpose. Dropping just the offending bullet
 * would leave a resume the candidate has not read, assembled by a process that has
 * just demonstrated it will invent things - and a resume with one silently removed
 * bullet is not obviously wrong to anyone looking at it, which is exactly the kind
 * of failure that survives to the interview.
 *
 * PURE, and takes the atoms as an argument rather than reading them itself, so that
 * every rule can be tested against a hand-built fabrication. The guard is the one
 * component here whose bugs are invisible in production: a guard that has stopped
 * checking looks precisely like a model that has stopped fabricating.
 *
 * WHAT IT DOES NOT CATCH, stated plainly because a guard that is trusted past its
 * range is worse than no guard:
 *
 *   - An invented technology the tech dictionary does not know. `techIn` finds
 *     dictionary names, so a fabricated "Docling" passes. This is the acceptable
 *     half of the trade: the realistic failure is a model helpfully adding a
 *     WELL-KNOWN tool the posting listed, and those are exactly what the
 *     dictionary contains.
 *   - Unquantified overstatement. "Led the migration" where the atom says
 *     "contributed to the migration" contains no number, no new tech and no
 *     employer, and no mechanical check can see it. That is what the human
 *     confirmation gate is for, and it is why `provenanceReport` is retained on
 *     PASS as well as on failure - the report is what a person reads.
 */
import { numbersIn, supportsNumber } from '../profile/numbers';
import { canonicalise, techIn } from '../profile/tech';
import type { TailorOutput } from '../llm/tasks/tailor-resume.task';

/**
 * Where in the output a violation was found.
 *
 * Recorded because the three sites have different likelihoods and a rising rate in
 * one of them says something different: `coverLetter` is the freest prose the model
 * writes and is where drift shows up first, while a `rewrite` violation is the model
 * ignoring an explicit rule about a specific atom.
 */
export type ViolationSite = 'selection' | 'rewrite' | 'headline' | 'coverLetter';

export type ViolationKind =
  /** Cites an atom id that is not in this profile. */
  | 'unknown-atom'
  /** A rewrite for an atom the model did not select - an internally inconsistent answer. */
  | 'rewrite-not-selected'
  /** Two rewrites for the same atom, so which one is the resume is undefined. */
  | 'duplicate-rewrite'
  /** A number that the cited atom's metrics do not support. */
  | 'invented-number'
  /** A technology outside the profile's tags plus the enabled SkillsReserve. */
  | 'invented-tech'
  /** A bullet attributed to an employer other than the atom's own. */
  | 'moved-employer'
  /** Nothing selected at all, so there is no resume to render. */
  | 'empty-selection';

export interface Violation {
  kind: ViolationKind;
  site: ViolationSite;
  /** The atom the offending text claimed to come from, when there is one. */
  atomId?: string;
  /** The offending fragment - the number, the tech name, the id. */
  found?: string;
  /** One sentence a human can act on. This ends up in the digest. */
  detail: string;
}

/**
 * What the guard looked at.
 *
 * Kept because the violation count alone cannot distinguish "the model behaved" from
 * "the guard checked nothing". A report of zero violations over zero numbers is not
 * evidence of anything, and without these counts the two are the same row in the
 * database.
 */
export interface GuardCounts {
  selected: number;
  rewrites: number;
  numbersChecked: number;
  techTokensChecked: number;
}

export interface ProvenanceReport {
  passed: boolean;
  violations: Violation[];
  counts: GuardCounts;
}

/** The subset of ProfileAtom the guard needs. */
export interface GuardAtom {
  id: string;
  text: string;
  tech: string[];
  metrics: string[];
  employer?: string | null;
  dateRange?: string | null;
}

export interface GuardInput {
  atoms: readonly GuardAtom[];
  /** Profile tech tags plus the candidate's ENABLED SkillsReserve entries. */
  allowedTech: readonly string[];
  output: TailorOutput;
}

/** Canonical-and-lowercased, because the allowed set is compared as strings. */
function techKey(name: string): string {
  return canonicalise(name.trim()).toLowerCase();
}

/**
 * Spells "65 percent" as "65%" before the numbers are extracted.
 *
 * A resume writes "65%" and a model writing prose often writes "65 percent", and
 * without this the two are a value with unit `%` and a bare value with no unit -
 * which `supportsNumber` correctly refuses to match. That would discard an entirely
 * honest rewrite, and a guard's false positives are not free: every one of them is an
 * application that goes out on the base resume for no reason.
 *
 * Applied to BOTH sides inside checkNumbers, so it cannot introduce an asymmetry.
 *
 * Only `percent`. Deliberately not "3 times" -> "3x", which looks like the same
 * normalisation and is not: "deployed 3 times a week" is not a threefold anything,
 * and rewriting it to `3x` would make the guard ACCEPT a claim it should question.
 * A normalisation that widens what is permitted has to be more obviously correct
 * than this one is.
 */
function normalizeUnits(text: string): string {
  return text.replace(/\s*(?:percent|pct)\b/gi, '%');
}

/**
 * Checks one piece of text for numbers not supported by a set of atoms.
 *
 * Takes a SET of atoms rather than one, because the two callers differ: a rewrite is
 * checked against the single atom it cites, while the headline and cover letter are
 * checked against the union of everything selected - they are not attributed to one
 * atom, so the only honest question is whether the figure appears anywhere in the
 * material this resume is built from.
 */
function checkNumbers(
  text: string,
  sources: readonly GuardAtom[],
  site: ViolationSite,
  atomId: string | undefined,
  violations: Violation[],
): number {
  // Both sides through numbersIn, which is the whole reason that function is shared
  // rather than reimplemented here - see the header of profile/numbers.ts. If the
  // metrics were extracted by one set of rules and checked by another, the guard
  // would reject honest rewrites and pass invented ones.
  const supported = sources.flatMap((atom) =>
    atom.metrics.flatMap((metric) => numbersIn(normalizeUnits(metric))),
  );

  const claims = numbersIn(normalizeUnits(text));
  for (const claim of claims) {
    if (supportsNumber(supported, claim)) continue;
    violations.push({
      kind: 'invented-number',
      site,
      ...(atomId ? { atomId } : {}),
      found: claim.surface,
      detail:
        `"${claim.surface}" is not a figure the source material states. ` +
        (supported.length > 0
          ? `Available: ${supported.map((n) => n.surface).join(', ')}.`
          : 'The source atom has no metrics at all.'),
    });
  }

  return claims.length;
}

/** Checks one piece of text for technologies outside the allowed union. */
function checkTech(
  text: string,
  allowed: ReadonlySet<string>,
  site: ViolationSite,
  atomId: string | undefined,
  violations: Violation[],
): number {
  const named = techIn(text);
  for (const tech of named) {
    if (allowed.has(techKey(tech))) continue;
    violations.push({
      kind: 'invented-tech',
      site,
      ...(atomId ? { atomId } : {}),
      found: tech,
      detail:
        `"${tech}" is not in the candidate's technology list. If they really have ` +
        'used it, add it to SkillsReserve and enable it; otherwise this is a ' +
        'fabricated skill.',
    });
  }
  return named.length;
}

/**
 * Validates a tailoring output against the profile it claims to be drawn from.
 *
 * Returns a report rather than throwing. The caller needs the report on the success
 * path too - it is persisted to `ResumeVariant.provenanceReport` whether the variant
 * passed or not, because the guard's failure RATE over time is the signal that the
 * prompt has drifted, and a rate is not computable from failures alone.
 */
export function checkProvenance(input: GuardInput): ProvenanceReport {
  const { atoms, output } = input;
  const violations: Violation[] = [];

  const byId = new Map(atoms.map((atom) => [atom.id, atom]));
  const allowed = new Set(input.allowedTech.map(techKey));

  // Employers as they are spelled in the profile. Used for the cross-attribution
  // check below, which is the "employer names byte-identical to source" rule in the
  // only form that can actually be checked: the RENDERER never takes an employer
  // from the model - it reads ProfileAtom.employer - so a changed spelling cannot
  // reach the page. What can reach the page is a bullet whose text names a
  // DIFFERENT one of the candidate's employers than the atom it came from.
  // Deduped: a candidate has several atoms per employer, and without the Set one
  // reattributed bullet reported one violation per atom at that employer - three
  // identical lines in the digest for a single mistake.
  const employers = [
    ...new Set(
      atoms
        .map((atom) => atom.employer?.trim())
        .filter((name): name is string => Boolean(name)),
    ),
  ];

  if (output.selectedAtomIds.length === 0) {
    violations.push({
      kind: 'empty-selection',
      site: 'selection',
      detail: 'No atoms were selected, so there is no resume to render.',
    });
  }

  const selected: GuardAtom[] = [];
  const seenSelected = new Set<string>();
  for (const id of output.selectedAtomIds) {
    const atom = byId.get(id);
    if (!atom) {
      violations.push({
        kind: 'unknown-atom',
        site: 'selection',
        found: id,
        detail: `Selected atom ${id} does not exist in this profile.`,
      });
      continue;
    }
    // A repeated id is not a violation, it is a duplicate the renderer must not
    // print twice. Deduped here so `selected` is what actually goes on the page.
    if (seenSelected.has(id)) continue;
    seenSelected.add(id);
    selected.push(atom);
  }

  let numbersChecked = 0;
  let techTokensChecked = 0;

  const seenRewrites = new Set<string>();
  for (const rewrite of output.rewrites) {
    const atom = byId.get(rewrite.atomId);
    if (!atom) {
      violations.push({
        kind: 'unknown-atom',
        site: 'rewrite',
        found: rewrite.atomId,
        detail: `Rewrite cites atom ${rewrite.atomId}, which does not exist in this profile.`,
      });
      continue;
    }

    if (!seenSelected.has(rewrite.atomId)) {
      violations.push({
        kind: 'rewrite-not-selected',
        site: 'rewrite',
        atomId: rewrite.atomId,
        detail:
          `Atom ${rewrite.atomId} was rewritten but not selected, so the answer ` +
          'does not say whether this text belongs on the resume.',
      });
    }

    if (seenRewrites.has(rewrite.atomId)) {
      violations.push({
        kind: 'duplicate-rewrite',
        site: 'rewrite',
        atomId: rewrite.atomId,
        detail: `Atom ${rewrite.atomId} was rewritten twice; which version is the resume is undefined.`,
      });
    }
    seenRewrites.add(rewrite.atomId);

    // Scoped to the ONE atom it cites. This is the strictest check in the file and
    // the reason the output schema forces a citation at all: "which numbers is this
    // sentence allowed to contain" has a single, checkable answer.
    numbersChecked += checkNumbers(
      rewrite.text,
      [atom],
      'rewrite',
      atom.id,
      violations,
    );

    // Tech is checked against the WHOLE allowed union, not the atom's own tags, per
    // the plan. Per-atom would over-reject: tags come from the sentence that
    // happened to be written, so an atom about "the ingestion pipeline" often has no
    // Redis tag even though the candidate's SKILLS section lists Redis and the work
    // genuinely used it. The union is the claim being defended - "this candidate has
    // worked with these things" - and that is a per-candidate fact, not a
    // per-sentence one.
    techTokensChecked += checkTech(
      rewrite.text,
      allowed,
      'rewrite',
      atom.id,
      violations,
    );

    const own = atom.employer?.trim().toLowerCase();
    for (const employer of employers) {
      if (employer.toLowerCase() === own) continue;
      if (!rewrite.text.toLowerCase().includes(employer.toLowerCase())) continue;
      violations.push({
        kind: 'moved-employer',
        site: 'rewrite',
        atomId: atom.id,
        found: employer,
        detail:
          `This bullet came from ${atom.employer ?? 'an atom with no employer'} but ` +
          `its text names ${employer}. Work cannot be reattributed.`,
      });
    }
  }

  // Headline and cover letter: checked against everything SELECTED rather than
  // everything in the profile. A cover letter citing a figure from an atom this
  // resume left out is still drawn from the candidate's real history, but it is
  // describing work the reader cannot see - and more to the point, allowing the
  // whole profile here would make the union so wide that the number rule stops
  // discriminating.
  for (const [site, text] of [
    ['headline', output.headline],
    ['coverLetter', output.coverLetter],
  ] as const) {
    if (!text) continue;
    numbersChecked += checkNumbers(text, selected, site, undefined, violations);
    techTokensChecked += checkTech(text, allowed, site, undefined, violations);
  }

  return {
    passed: violations.length === 0,
    violations,
    counts: {
      selected: selected.length,
      rewrites: output.rewrites.length,
      numbersChecked,
      techTokensChecked,
    },
  };
}

/**
 * A one-line summary for a log or a digest row.
 *
 * Grouped by kind rather than listed, because fifteen `invented-number` violations
 * from one bad cover letter is one problem and reading fifteen lines to find that
 * out is how the digest stops being read.
 */
export function summarize(report: ProvenanceReport): string {
  if (report.passed) {
    return (
      `provenance OK (${report.counts.selected} atoms, ` +
      `${report.counts.rewrites} rewrites, ${report.counts.numbersChecked} numbers ` +
      `and ${report.counts.techTokensChecked} tech tokens checked)`
    );
  }

  const byKind = new Map<ViolationKind, number>();
  for (const violation of report.violations) {
    byKind.set(violation.kind, (byKind.get(violation.kind) ?? 0) + 1);
  }

  return (
    `provenance FAILED: ` +
    [...byKind.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([kind, count]) => `${kind} x${count}`)
      .join(', ')
  );
}
