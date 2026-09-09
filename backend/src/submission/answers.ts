/**
 * Everything this system knows how to type into a form, and nothing else.
 *
 * TWO SOURCES, KEPT SEPARATE ON PURPOSE:
 *
 *   the profile           name, email, phone, location, links. Parsed from the
 *                         resume, so they are already being sent to the employer in
 *                         the attachment - typing them into a box states nothing new.
 *
 *   ApplicationAnswers    work authorization, sponsorship, notice period, current and
 *                         expected CTC, relocation, start date. Typed once by the
 *                         candidate, stored, and used verbatim.
 *
 * PLAN-v2 phase 6 calls for these to come from an explicit `config/legal.yaml`. The
 * ApplicationAnswers table is that file, moved: same property of being an explicit
 * statement the candidate wrote down rather than something derived, and per-user,
 * which a file in the repository cannot be. What the plan is actually asking for is
 * that these values are never inferred, and a row nobody has filled in reads as
 * `null` here and leaves the field blank - see `blank` counts in PrefillResult.
 *
 * NOTHING IN THIS FILE ASKS AN LLM ANYTHING. The generic filler does use the LLM, but
 * only to decide which of these keys a strange label is asking for; the value that
 * gets typed always comes from here.
 */
import type { ApplicationAnswers, Prisma } from '@prisma/client';
import type { AnswerKey } from './field-policy';

/**
 * One resolved answer.
 *
 * Booleans stay booleans rather than being flattened to "Yes" here, because the word
 * a form wants depends on the form: a select offers "Yes"/"No", a radio group offers
 * "I require sponsorship"/"I do not require sponsorship", and a checkbox offers
 * nothing at all. Deciding that needs the field's options, which only the filler has.
 */
export type AnswerValue =
  | { kind: 'text'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'file'; path: string };

/** The candidate's facts, as the profile holds them. */
export interface ProfileFacts {
  fullName: string;
  email: string;
  phone: string | null;
  location: string | null;
  linkedIn: string | null;
  github: string | null;
  portfolio: string | null;
}

/**
 * The candidate's own statements. Every field optional and every absent one meaning
 * "left blank", never "assume the common case".
 */
export interface StatedAnswers {
  workAuthorization: string | null;
  needsSponsorship: boolean | null;
  noticePeriodDays: number | null;
  currentCtcLpa: string | null;
  expectedCtcLpa: string | null;
  willingToRelocate: boolean | null;
  earliestStartDate: Date | null;
  /** Recurring screening questions the candidate has answered by hand once, keyed by
   *  the question text. Matched case-insensitively on a normalized label. */
  customAnswers: Record<string, string>;
}

export interface AnswerSet {
  profile: ProfileFacts;
  stated: StatedAnswers;
  /** The tailored PDF, absolute. Null when tailoring produced no pdf - LibreOffice
   *  missing - in which case the docx is used instead. */
  resumePath: string | null;
  /** Written by tailoring and already past the provenance guard. */
  coverLetter: string | null;
}

/** An empty set of statements, for a candidate who has filled nothing in. */
export const NO_STATED_ANSWERS: StatedAnswers = {
  workAuthorization: null,
  needsSponsorship: null,
  noticePeriodDays: null,
  currentCtcLpa: null,
  expectedCtcLpa: null,
  willingToRelocate: null,
  earliestStartDate: null,
  customAnswers: {},
};

/**
 * The stored statements, or the absence of them.
 *
 * Decimal to string rather than to number, deliberately. These are money, and they get
 * typed into a real employer's salary box: a float round-trip is how a figure the
 * candidate entered as 12.1 arrives as 12.099999999999999. Decimal.toString drops a
 * trailing zero (12.10 reads back as 12.1), which is the same number; a float would
 * not be.
 *
 * Here rather than in the submission service because the answers SCREEN reads the
 * same row and has to show what will actually be typed. Two conversions would be two
 * chances for the form to display a figure the filler does not use.
 */
export function toStatedAnswers(row: ApplicationAnswers | null): StatedAnswers {
  if (!row) return NO_STATED_ANSWERS;
  return {
    workAuthorization: row.workAuthorization,
    needsSponsorship: row.needsSponsorship,
    noticePeriodDays: row.noticePeriodDays,
    currentCtcLpa: row.currentCtcLpa?.toString() ?? null,
    expectedCtcLpa: row.expectedCtcLpa?.toString() ?? null,
    willingToRelocate: row.willingToRelocate,
    earliestStartDate: row.earliestStartDate,
    customAnswers: toCustomAnswers(row.customAnswers),
  };
}

/**
 * `customAnswers` is a Json column, so it is whatever was written into it.
 *
 * Narrowed rather than cast: a nested object in there would otherwise become the
 * string "[object Object]" typed into a real employer's form.
 */
export function toCustomAnswers(
  value: Prisma.JsonValue | null,
): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return {};
  const out: Record<string, string> = {};
  for (const [question, answer] of Object.entries(value)) {
    if (typeof answer === 'string' && answer.trim().length > 0) {
      out[question] = answer;
    }
  }
  return out;
}

/** The answers essentially every Indian application form asks for. */
export type RequiredAnswerKey =
  | 'workAuthorization'
  | 'needsSponsorship'
  | 'noticePeriodDays'
  | 'expectedCtcLpa';

/**
 * The words the form uses, not the column names.
 *
 * The person reading this is being asked to go and fill something in, on a phone, at
 * 09:00. "needsSponsorship" is not what the box is called.
 */
export const REQUIRED_ANSWER_LABEL: Record<RequiredAnswerKey, string> = {
  workAuthorization: 'work authorisation',
  needsSponsorship: 'whether you need sponsorship',
  noticePeriodDays: 'notice period',
  expectedCtcLpa: 'expected CTC',
};

/**
 * The answers an application cannot sensibly be prepared without.
 *
 * ONE RULE, IN ONE PLACE. The digest nags about these four, the dashboard raises its
 * blocker from the same list and the answers screen marks the same fields. Three
 * readings of "which answers are missing" is a screen that says you are finished while
 * the digest is still asking, which is how a candidate learns to ignore both.
 *
 * Deliberately these four and not all seven. Current CTC is blank for a first job and
 * relocation is blank for someone who will not, and nagging forever about a box that
 * does not apply teaches people to dismiss the warning that does.
 *
 * `=== null` and not falsy, for a reason: `false` is a real answer to "do you need
 * sponsorship", and 0 is a real notice period. Treating either as absent would ask the
 * candidate to fill in what they already filled in.
 */
export function missingRequiredAnswers(
  stated: StatedAnswers,
): RequiredAnswerKey[] {
  const missing: RequiredAnswerKey[] = [];
  if (!stated.workAuthorization?.trim()) missing.push('workAuthorization');
  if (stated.needsSponsorship === null) missing.push('needsSponsorship');
  if (stated.noticePeriodDays === null) missing.push('noticePeriodDays');
  if (stated.expectedCtcLpa === null) missing.push('expectedCtcLpa');
  return missing;
}

/**
 * The value for one key, or null to leave the field alone.
 *
 * SPLITTING A FULL NAME. First word and the rest, which is right for "Astha Niharika"
 * and wrong for a name with a compound surname the other way round - but a form with
 * separate boxes forces a split, and getting it wrong in the direction that keeps the
 * whole surname together is the recoverable one. The human sees both boxes.
 */
export function answerFor(key: AnswerKey, set: AnswerSet): AnswerValue | null {
  const { profile, stated } = set;

  switch (key) {
    case 'fullName':
      return text(profile.fullName);
    case 'firstName':
      return text(profile.fullName.trim().split(/\s+/)[0]);
    case 'lastName': {
      const parts = profile.fullName.trim().split(/\s+/);
      return parts.length > 1 ? text(parts.slice(1).join(' ')) : null;
    }
    case 'email':
      return text(profile.email);
    case 'phone':
      return text(profile.phone);
    case 'location':
      return text(profile.location);
    case 'linkedIn':
      return text(profile.linkedIn);
    case 'github':
      return text(profile.github);
    case 'portfolio':
      return text(profile.portfolio);

    case 'resume':
      return set.resumePath ? { kind: 'file', path: set.resumePath } : null;
    case 'coverLetter':
      return text(set.coverLetter);

    case 'workAuthorization':
      return text(stated.workAuthorization);
    case 'needsSponsorship':
      return bool(stated.needsSponsorship);
    case 'noticePeriodDays':
      return stated.noticePeriodDays === null
        ? null
        : text(String(stated.noticePeriodDays));
    case 'currentCtcLpa':
      return text(stated.currentCtcLpa);
    case 'expectedCtcLpa':
      return text(stated.expectedCtcLpa);
    case 'willingToRelocate':
      return bool(stated.willingToRelocate);
    case 'earliestStartDate':
      // ISO, because it is the one format every date input accepts and because a
      // localised one would be read as month-first by an American form.
      return stated.earliestStartDate
        ? text(stated.earliestStartDate.toISOString().slice(0, 10))
        : null;
  }
}

/**
 * A previously-typed answer to this exact question, if the candidate has stored one.
 *
 * Matched on a normalized label rather than the raw string, because the same question
 * arrives with different punctuation and a trailing asterisk on every board.
 */
export function customAnswerFor(
  label: string,
  stated: StatedAnswers,
): string | null {
  const wanted = normalizeQuestion(label);
  if (wanted.length === 0) return null;
  for (const [question, answer] of Object.entries(stated.customAnswers)) {
    if (normalizeQuestion(question) === wanted) {
      return answer.trim().length > 0 ? answer : null;
    }
  }
  return null;
}

export function normalizeQuestion(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Which of a field's options means yes, or means no.
 *
 * Returns null rather than guessing when nothing matches. A sponsorship dropdown
 * whose options this cannot read is a dropdown that stays on its placeholder, which
 * is what the human is there for; picking the first option because it is probably
 * "Yes" is how a system states the opposite of the truth about someone's visa.
 */
export function optionFor(
  value: boolean,
  options: readonly string[],
): string | null {
  const yes =
    /^(yes|y|true|i (?:do|am|will)\b(?!.*\bnot\b)|.*\bdo\b(?!.*\bnot\b).*)$/i;
  const no =
    /^(no|n|false|i (?:do not|don't|am not|will not)\b|.*\bdo not\b.*|.*\bdon't\b.*)$/i;

  // NEGATIVES FIRST. "I do not require sponsorship" satisfies a naive yes-pattern too,
  // and the two options in a real sponsorship dropdown differ by exactly that word.
  const negative = options.find((option) => no.test(option.trim()));
  const positive = options.find(
    (option) => option !== negative && yes.test(option.trim()),
  );

  const wanted = value ? positive : negative;
  return wanted ?? null;
}

function text(value: string | null | undefined): AnswerValue | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0
    ? { kind: 'text', value: trimmed }
    : null;
}

function bool(value: boolean | null): AnswerValue | null {
  return value === null ? null : { kind: 'boolean', value };
}
