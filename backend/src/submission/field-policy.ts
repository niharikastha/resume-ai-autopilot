/**
 * What a form field is asking, and whether this system is allowed to answer it.
 *
 * THE THREE CLASSES PLAN-v2 PHASE 6 NEVER AUTO-FILLS, and why each one is worse than
 * a blank box:
 *
 *   demographic  EEO and self-identification. Left blank, always, with no way to
 *                configure otherwise. These answers belong to the candidate and to
 *                nobody else, they are not needed to apply, and a system that filled
 *                them from a stored value would be answering a question about race or
 *                disability on someone's behalf. The correct default is the one the
 *                forms themselves offer: decline to self-identify.
 *
 *   legal        Work authorization, visa sponsorship, notice period, current and
 *                expected salary. Answered ONLY from a value the candidate typed in
 *                once and can see - the ApplicationAnswers row. NEVER inferred from
 *                the resume, never asked of the LLM, never defaulted. Each of these
 *                is a statement to an employer that the candidate is accountable for,
 *                and a wrong one is worse than an empty field: "no sponsorship
 *                required" filled in for someone who needs it is a lie in a hiring
 *                process, and a guessed expected CTC anchors a negotiation.
 *
 *   long-form    "Why do you want to work here", in a textarea. Flagged rather than
 *                filled. Not for safety - because a generated paragraph is the thing
 *                a recruiter notices, and the candidate is sitting in front of the
 *                browser anyway.
 *
 * Everything else is `ordinary`: name, email, phone, links, the resume file. Facts
 * already on the resume, typed identically every time, and the whole reason this
 * phase exists.
 *
 * MATCHING IS ON THE LABEL, AT WORD BOUNDARIES. `\b` and not `includes`, for the
 * reason stage 1 learned it: "gender" inside "agenda" is not a demographic question,
 * but "Gender" next to a dropdown is - and the cost of the substring version falls
 * entirely on the side of filling a box that should have stayed empty.
 *
 * The `(?:s|es)?` on the demographic group is the same inflection allowance
 * stage1.screen.ts carries, and it is here because it was MISSING and a test caught
 * it: `\bpronoun\b` does not match "What are your pronouns?", which is a real
 * Greenhouse field, and the failure mode was this system typing a name into it.
 */

/** Which of the candidate's stored values a field wants. */
export type AnswerKey =
  | 'fullName'
  | 'firstName'
  | 'lastName'
  | 'email'
  | 'phone'
  | 'location'
  | 'linkedIn'
  | 'github'
  | 'portfolio'
  | 'resume'
  | 'coverLetter'
  | 'workAuthorization'
  | 'needsSponsorship'
  | 'noticePeriodDays'
  | 'currentCtcLpa'
  | 'expectedCtcLpa'
  | 'willingToRelocate'
  | 'earliestStartDate';

export type FieldClass = 'ordinary' | 'demographic' | 'legal' | 'long-form';

/**
 * EEO and self-identification vocabulary.
 *
 * Deliberately WIDE. A false positive here costs an empty optional box on a form the
 * human is about to look at; a false negative means this system answered a question
 * about someone's race or disability. Those are not comparable, so the list errs
 * toward silence - `veteran`, `disability` and `ethnicity` also catch the "are you a
 * protected veteran" and "voluntary self-identification of disability" wrappers that
 * US-registered boards attach to Indian postings.
 */
const DEMOGRAPHIC =
  /\b(?:gender|sex|male|female|non-?binary|transgender|race|racial|ethnic|ethnicity|hispanic|latino|latinx|african|asian|caucasian|white|black|native|indigenous|pacific islander|veteran|military|disab(?:led|ility|ilities)|impairment|sexual orientation|lgbtq?\+?|pronoun|marital|religion|religious|caste|age|date of birth|dob|self-?identif(?:y|ication)|eeo|eeoc|ofccp|demographic|diversity)(?:s|es)?\b/i;

/**
 * Questions answerable only from an explicit stored answer.
 *
 * Narrower than DEMOGRAPHIC on purpose: a false positive here does not leave the
 * field blank, it routes the answer through the candidate's own stored value instead
 * of through the profile - which is the safer of the two paths anyway.
 */
const LEGAL =
  /\b(visa|sponsor(?:ship|ed|ing)?|work authoriz|work permit|authoriz(?:ed|ation) to work|legally (?:authoriz|entitl|eligib)|right to work|citizen(?:ship)?|h-?1-?b|opt|ead|green card|notice period|current (?:ctc|salary|compensation|pay)|expected (?:ctc|salary|compensation|pay)|salary expectation|compensation expectation|desired salary|relocat(?:e|ion|ing)|earliest start|start date|available to start|availability|joining date)\b/i;

/** Where the tailored PDF goes. */
const RESUME = /\b(resume|résumé|cv|curriculum vitae|upload)\b/i;

const COVER_LETTER =
  /\b(cover letter|covering letter|letter of interest|motivation)\b/i;

/**
 * How a field is labelled when it wants one of the candidate's ordinary facts.
 *
 * ORDER MATTERS AND IS TESTED. `full name` has to be read before `name`, or "Full
 * name" becomes a first name; `email` has to be read before `phone`, because
 * "Email or phone" is a real label on consumer-grade forms and the email is the half
 * that must be right.
 */
const ORDINARY: readonly [AnswerKey, RegExp][] = [
  ['firstName', /\b(first name|given name|forename)\b/i],
  ['lastName', /\b(last name|surname|family name)\b/i],
  ['fullName', /\b(full name|your name|candidate name|name)\b/i],
  ['email', /\b(e-?mail|email address)\b/i],
  ['phone', /\b(phone|mobile|telephone|contact number|cell)\b/i],
  ['linkedIn', /\blinked ?in\b/i],
  ['github', /\b(git ?hub|gitlab)\b/i],
  ['portfolio', /\b(portfolio|website|personal site|blog|url|link)\b/i],
  ['location', /\b(location|city|current city|where.*based|address|town)\b/i],
];

/** How a legal label maps onto the ApplicationAnswers row. */
const LEGAL_KEYS: readonly [AnswerKey, RegExp][] = [
  ['needsSponsorship', /\b(sponsor(?:ship|ed|ing)?|visa)\b/i],
  [
    'workAuthorization',
    /\b(work authoriz|work permit|authoriz(?:ed|ation) to work|legally (?:authoriz|entitl|eligib)|right to work|citizen(?:ship)?)\b/i,
  ],
  ['noticePeriodDays', /\bnotice period\b/i],
  ['currentCtcLpa', /\bcurrent (?:ctc|salary|compensation|pay)\b/i],
  [
    'expectedCtcLpa',
    /\b(expected (?:ctc|salary|compensation|pay)|salary expectation|compensation expectation|desired salary)\b/i,
  ],
  ['willingToRelocate', /\brelocat(?:e|ion|ing)\b/i],
  [
    'earliestStartDate',
    /\b(earliest start|start date|available to start|availability|joining date)\b/i,
  ],
];

/**
 * A textarea whose answer is prose about this specific company.
 *
 * Only used to distinguish a long-form question from a long-form field that happens
 * to be the cover letter, which IS filled - the tailoring phase already wrote one and
 * ran it past the provenance guard.
 */
const LONG_FORM_MIN_LABEL_WORDS = 4;

export interface ClassifiedField {
  readonly fieldClass: FieldClass;
  /** Which stored value answers it, when one does. */
  readonly key: AnswerKey | null;
  /** Why, in the words a human reading the run log needs. */
  readonly reason: string;
}

/**
 * Classify one field by its label and control type.
 *
 * `type` participates because the same words mean different things in different
 * controls: "Cover letter" on a file input wants a file, and on a textarea wants
 * text, and a filler that got those the wrong way round would attach a PDF to a
 * paragraph box.
 */
export function classify(label: string, type: string): ClassifiedField {
  const text = label.replace(/\s+/g, ' ').trim();

  // FIRST, ALWAYS. A question can be both demographic and something else - "Veteran
  // status (for EEO reporting) - are you legally authorized to work?" exists on real
  // combined forms - and when it is both, blank is the answer.
  if (DEMOGRAPHIC.test(text)) {
    return {
      fieldClass: 'demographic',
      key: null,
      reason: 'demographic or EEO question, never auto-filled',
    };
  }

  if (type === 'file') {
    if (COVER_LETTER.test(text)) {
      return {
        fieldClass: 'ordinary',
        key: 'coverLetter',
        reason: 'cover letter upload',
      };
    }
    if (RESUME.test(text) || text.length === 0) {
      // An unlabelled file input on a job application is the resume. Every ATS in
      // tier 1 and 2 has exactly one, and leaving it empty fails the form.
      return { fieldClass: 'ordinary', key: 'resume', reason: 'resume upload' };
    }
    return {
      fieldClass: 'ordinary',
      key: null,
      reason: 'unrecognised file upload',
    };
  }

  if (LEGAL.test(text)) {
    const match = LEGAL_KEYS.find(([, pattern]) => pattern.test(text));
    return {
      fieldClass: 'legal',
      key: match?.[0] ?? null,
      reason: match
        ? `answered only from the stored ${match[0]}`
        : 'legal or compensation question with no stored answer',
    };
  }

  if (COVER_LETTER.test(text)) {
    return {
      fieldClass: 'ordinary',
      key: 'coverLetter',
      reason: 'cover letter',
    };
  }

  const ordinary = ORDINARY.find(([, pattern]) => pattern.test(text));
  if (ordinary) {
    return {
      fieldClass: 'ordinary',
      key: ordinary[0],
      reason: `the candidate's ${ordinary[0]}`,
    };
  }

  // A textarea with a sentence for a label is a question about this company.
  if (
    type === 'textarea' &&
    text.split(/\s+/).length >= LONG_FORM_MIN_LABEL_WORDS
  ) {
    return {
      fieldClass: 'long-form',
      key: null,
      reason: 'free-text question, flagged for the human to answer',
    };
  }

  return {
    fieldClass: 'ordinary',
    key: null,
    reason: 'no stored answer matches',
  };
}
