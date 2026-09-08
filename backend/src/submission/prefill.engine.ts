/**
 * The one filling loop. Every adapter runs this; none of them re-implements it.
 *
 * WHY IT IS SHARED RATHER THAN PER-ATS. The rules that matter here are not about
 * Greenhouse or Lever, they are about which questions this system is allowed to
 * answer - and those are identical on every board. Four adapters each with their own
 * copy of the EEO check is four places for it to be subtly different, and the one
 * that is wrong is the one nobody reads. What differs per ATS is which field NAMES
 * are stable, and that is a data table an adapter hands in.
 *
 * ORDER OF DECISION for each field, and each step exists because the one after it
 * would get the answer wrong:
 *
 *   1. The adapter's name map. `first_name` on Greenhouse is `first_name` on every
 *      board on the platform; the label above it is whatever the customer typed.
 *   2. `classify()` on the label. The safety rules live here - demographic questions
 *      are refused before anything else looks at them.
 *   3. A stored custom answer for this exact question, if the candidate has typed one
 *      before. Reached for any field no key claimed - INCLUDING a legal question,
 *      which is correct: a customAnswers entry is a sentence the candidate wrote for
 *      that exact question, which is the same standard the ApplicationAnswers columns
 *      meet. It is NOT reached for a demographic or long-form field, because those
 *      return before it.
 *   4. Nothing. The field stays as the form left it.
 *
 * A FIELD THAT IS ALREADY NON-EMPTY IS LEFT ALONE and counted as filled. The browser
 * runs on a persistent profile, so Chrome's own autofill and the candidate's previous
 * pass through this form both put real values in these boxes - overwriting them with
 * the profile's version would undo a correction the human made by hand.
 */
import {
  answerFor,
  customAnswerFor,
  optionFor,
  type AnswerSet,
  type AnswerValue,
} from './answers';
import { classify, type AnswerKey, type FieldClass } from './field-policy';
import type {
  FilledField,
  NameMap,
  PreparedApplication,
  PrefillResult,
} from './ats.adapter';
import type { FormField, FormPage } from './form-page';

/** Text-like controls, where `fill` is the right verb. */
const TYPED = new Set([
  'text',
  'email',
  'tel',
  'url',
  'number',
  'date',
  'textarea',
  'other',
]);

export interface PrefillOptions {
  /** The names this ATS keeps stable. Consulted first. */
  nameMap?: NameMap;
  /**
   * A second opinion on fields no rule claimed - the generic adapter's LLM pass.
   *
   * ONLY EVER CALLED WITH FIELDS `classify()` RETURNED `ordinary` AND NO KEY FOR, so
   * an LLM cannot route an answer into a demographic or legal field however it is
   * prompted. It sees labels, decides which stored key each wants, and the value that
   * gets typed still comes from the answer set.
   */
  resolve?: (fields: FormField[]) => Promise<Map<string, AnswerKey | null>>;
  /** Where to write the audit screenshot. Skipped when absent. */
  screenshotPath?: string;
}

export async function runPrefill(
  page: FormPage,
  app: PreparedApplication,
  options: PrefillOptions = {},
): Promise<PrefillResult> {
  const fields = await page.fields();
  const filled: FilledField[] = [];
  const needsHuman: string[] = [];

  // Decide every key before filling anything, because `resolve` is one batched call
  // and a per-field await would make it one call per field.
  const decisions = await decide(fields, options);

  for (const field of fields) {
    const decision = decisions.get(field.handle);
    // Unreachable: `decide` returns one entry per field. Kept because a missing entry
    // would otherwise fill the field from `undefined`.
    if (!decision) continue;

    filled.push(await apply(page, field, decision, app.answers));
  }

  for (const field of filled) {
    const line = humanNeeds(field);
    if (line && !needsHuman.includes(line)) needsHuman.push(line);
  }

  const required = filled.filter((f) => f.required);

  let screenshotPath: string | null = null;
  if (options.screenshotPath) {
    try {
      await page.screenshot(options.screenshotPath);
      screenshotPath = options.screenshotPath;
    } catch {
      // The screenshot is the audit trail, not the work. A form that is filled and a
      // screenshot that failed is a good outcome with a missing photograph, and
      // throwing here would discard the filling that already happened.
      screenshotPath = null;
    }
  }

  return {
    requiredTotal: required.length,
    requiredFilled: required.filter((f) => f.outcome === 'filled').length,
    fields: filled,
    needsHuman,
    screenshotPath,
  };
}

interface Decision {
  fieldClass: FieldClass;
  key: AnswerKey | null;
  reason: string;
  /** A stored answer to this exact question, found by label. */
  custom?: string;
}

/**
 * What each field wants, for the whole form at once.
 *
 * The name map is checked first and wins. Note that a name mapped to `null` is a
 * DELIBERATE EXCLUSION rather than an absent entry: Greenhouse's EEO block shares a
 * naming convention, and excluding it as a group is more robust than matching each
 * phrasing of "are you a protected veteran".
 */
async function decide(
  fields: FormField[],
  options: PrefillOptions,
): Promise<Map<string, Decision>> {
  const nameMap = options.nameMap ?? {};
  const decisions = new Map<string, Decision>();

  for (const field of fields) {
    const mapped =
      field.name !== null ? lookup(nameMap, field.name) : undefined;
    if (mapped !== undefined) {
      decisions.set(field.handle, {
        // A mapped field is still run past `classify` for its CLASS, because the
        // legal questions have to stay legal: a name map that pointed
        // `expected_salary` at `expectedCtcLpa` must not thereby turn it into an
        // ordinary field that gets filled from somewhere else later.
        fieldClass:
          mapped === null
            ? 'ordinary'
            : classify(field.label, field.type).fieldClass,
        key: mapped,
        reason:
          mapped === null
            ? 'excluded by this ATS adapter'
            : `mapped from the field name "${field.name}"`,
      });
      continue;
    }

    decisions.set(field.handle, classify(field.label, field.type));
  }

  if (!options.resolve) return decisions;

  // Only the leftovers, and only the safe ones. A field `classify` called demographic
  // or legal is not offered to the LLM at all.
  const unclaimed = fields.filter((field) => {
    const decision = decisions.get(field.handle);
    return (
      decision !== undefined &&
      decision.fieldClass === 'ordinary' &&
      decision.key === null &&
      field.label.trim().length > 0
    );
  });

  if (unclaimed.length === 0) return decisions;

  let resolved: Map<string, AnswerKey | null>;
  try {
    resolved = await options.resolve(unclaimed);
  } catch {
    // A failed LLM call costs the long tail of a form, not the form. The tier-1
    // fields are already decided above.
    return decisions;
  }

  for (const field of unclaimed) {
    const key = resolved.get(field.handle);
    if (!key) continue;
    // Re-checked rather than trusted. `resolve` was handed only ordinary fields, but
    // this is the one place a model's output reaches a decision about what to type,
    // and the check costs one regex.
    const recheck = classify(field.label, field.type);
    if (recheck.fieldClass !== 'ordinary') continue;
    decisions.set(field.handle, {
      fieldClass: 'ordinary',
      key,
      reason: `matched to ${key} by the generic filler`,
    });
  }

  return decisions;
}

/** Case-insensitive, because a form's own markup is inconsistent about it. */
function lookup(map: NameMap, name: string): AnswerKey | null | undefined {
  if (name in map) return map[name];
  const lower = name.toLowerCase();
  const hit = Object.keys(map).find((key) => key.toLowerCase() === lower);
  return hit === undefined ? undefined : map[hit];
}

/** Fills one field, or records why it was left alone. */
async function apply(
  page: FormPage,
  field: FormField,
  decision: Decision,
  answers: AnswerSet,
): Promise<FilledField> {
  const base = {
    label: field.label || field.name || '(unlabelled)',
    handle: field.handle,
    required: field.required,
    key: decision.key,
  };

  if (decision.fieldClass === 'demographic') {
    return { ...base, outcome: 'skipped', reason: decision.reason };
  }
  if (decision.fieldClass === 'long-form') {
    return { ...base, outcome: 'skipped', reason: decision.reason };
  }

  // File inputs report no value, so "already filled" cannot be detected for them and
  // re-attaching is harmless.
  if (field.type !== 'file' && field.value.trim().length > 0) {
    return {
      ...base,
      outcome: 'filled',
      reason: 'already had a value, left as it was',
    };
  }

  // The stored column first, then an answer typed for this exact question.
  //
  // BOTH, AND IN THAT ORDER, because a key being recognised is not the same as it
  // being answered. "What is your notice period at your current employer?" maps to
  // `noticePeriodDays`; a candidate who left that column empty and wrote "2 months,
  // negotiable" into customAnswers has answered the question, and the first version of
  // this line stopped at the empty column and left the box blank.
  const value =
    (decision.key ? answerFor(decision.key, answers) : null) ??
    storedCustom(field, answers);

  if (!value) {
    return {
      ...base,
      outcome: 'blank',
      reason: decision.key
        ? `nothing stored for ${decision.key}`
        : decision.reason,
    };
  }

  try {
    const typed = await write(page, field, value);
    if (typed === null) {
      return {
        ...base,
        outcome: 'blank',
        reason: `no option on this field matches the stored answer`,
      };
    }
    return {
      ...base,
      outcome: 'filled',
      reason: decision.reason,
      // Legal answers are not echoed into a log. Everything here is already on the
      // resume; a salary figure is not.
      ...(decision.fieldClass === 'legal' ? {} : { value: typed }),
    };
  } catch (err) {
    return {
      ...base,
      outcome: 'failed',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function storedCustom(
  field: FormField,
  answers: AnswerSet,
): AnswerValue | null {
  const stored = customAnswerFor(field.label, answers.stated);
  return stored === null ? null : { kind: 'text', value: stored };
}

/**
 * Types one value into one control.
 *
 * Returns what was written, or null when the control offers no option that matches -
 * which is a blank field and not an error. A sponsorship dropdown whose wording this
 * cannot read is left on its placeholder for the human, rather than set to whichever
 * option happened to be first.
 */
async function write(
  page: FormPage,
  field: FormField,
  value: AnswerValue,
): Promise<string | null> {
  if (field.type === 'file') {
    if (value.kind !== 'file') return null;
    await page.attach(field.handle, value.path);
    return value.path;
  }
  if (value.kind === 'file') return null;

  if (field.type === 'checkbox') {
    // Only ever ticked, never unticked. `false` on a checkbox is what an untouched
    // form already says.
    if (value.kind === 'boolean' && !value.value) return null;
    await page.check(field.handle);
    return 'checked';
  }

  if (field.type === 'select' || field.type === 'radio') {
    const option =
      value.kind === 'boolean'
        ? optionFor(value.value, field.options)
        : matchOption(value.value, field.options);
    if (option === null) return null;
    await page.select(field.handle, option);
    return option;
  }

  if (!TYPED.has(field.type)) return null;

  const written =
    value.kind === 'boolean' ? (value.value ? 'Yes' : 'No') : value.value;
  await page.fill(field.handle, written);
  return written;
}

/**
 * The option a text answer means.
 *
 * Exact first, then a contains match in either direction - "India" has to reach
 * "India (Remote)" and "Bengaluru, Karnataka, India" has to reach "India". No fuzzier
 * than that: a dropdown of countries contains several that share a prefix, and
 * choosing the wrong one is a wrong statement rather than a blank.
 */
function matchOption(value: string, options: readonly string[]): string | null {
  const wanted = value.trim().toLowerCase();
  if (wanted.length === 0) return null;

  const exact = options.find((o) => o.trim().toLowerCase() === wanted);
  if (exact) return exact;

  const contains = options.filter((o) => {
    const option = o.trim().toLowerCase();
    return (
      option.length > 0 && (option.includes(wanted) || wanted.includes(option))
    );
  });
  // Only when it is unambiguous. Two matching options means this cannot tell which,
  // and a human can.
  return contains.length === 1 ? contains[0] : null;
}

/** The line the run log prints for a field a human has to finish. */
function humanNeeds(field: FilledField): string | null {
  if (field.outcome === 'filled') return null;

  if (field.reason.startsWith('demographic')) {
    // Only when the form refuses to submit without it. An optional EEO block left
    // blank is the intended outcome, not an outstanding task.
    return field.required
      ? `${field.label} - required, and left blank because it is a demographic question`
      : null;
  }

  if (field.outcome === 'failed') {
    return `${field.label} - could not be filled: ${field.reason}`;
  }

  if (field.reason.startsWith('free-text')) {
    return `${field.label} - free text, for you to write`;
  }

  // A legal question with nothing stored, whether or not the form requires it. These
  // are flagged even when optional: an employer reading a blank "expected CTC" draws
  // a conclusion, and the candidate should know it was left blank.
  if (
    /^(nothing stored for|answered only from the stored|legal or compensation)/.test(
      field.reason,
    )
  ) {
    return `${field.label} - needs your answer${field.required ? ' (required)' : ''}`;
  }

  return field.required ? `${field.label} - required, still empty` : null;
}
