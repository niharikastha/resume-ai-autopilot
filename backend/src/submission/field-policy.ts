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
 *                filled, UNLESS the candidate has stored an answer to that exact
 *                question - see prefill.engine, which reaches the answers library for
 *                these. Nothing is generated for them: a paragraph written by a model is
 *                the thing a recruiter notices, and the candidate is sitting in front of
 *                the browser anyway.
 *
 *   consent      "I confirm I have read the above", "I agree to the privacy policy".
 *                Never ticked, from any source. A tick here is a declaration, and a
 *                declaration made by a program is one nobody made.
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

export type FieldClass =
  | 'ordinary'
  | 'demographic'
  | 'legal'
  | 'long-form'
  | 'consent';

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
  /\b(visa|sponsor(?:ship|ed|ing)?|work authoriz|work permit|authoriz(?:ed|ation) to work|legally (?:authoriz|entitl|eligib)|right to work|citizen(?:ship)?|h-?1-?b|opt|ead|green card|notice period|period of notice|(?:current|present|latest|existing) (?:annual )?(?:ctc|salary|compensation|pay|package|fixed)|(?:expected|desired|preferred) (?:annual )?(?:ctc|salary|compensation|pay|package)|(?:salary|compensation|ctc) expectation|in-?hand|relocat(?:e|ion|ing)|earliest start|start date|available to start|available from|availability|joining date|date of joining|how soon can you join|when can you (?:join|start))\b/i;

/**
 * A box that is a signature: "I confirm", "I agree to the privacy policy".
 *
 * A CLASS OF ITS OWN, AND NEVER TICKED, for two reasons that are both worse than a
 * blank box. The obvious one is that ticking it is the candidate attesting to something
 * - and a tick placed by a program is an attestation nobody made.
 *
 * The second one is why this pattern is checked BEFORE the legal one. "I certify that I
 * am legally authorised to work in the United States" matches LEGAL, which routes it to
 * the stored workAuthorization - a sentence like "Indian citizen" - and a text answer
 * arriving at a checkbox used to TICK it. So the stored answer to a question about India
 * would have signed a declaration about America. Classed here, it is left alone and
 * flagged, and prefill.engine refuses text-into-checkbox as well; either would be
 * enough, and a false attestation on a real application is worth both.
 *
 * `\bi (?:agree|confirm...)\b` rather than the bare verbs, because "Agreed rate" and
 * "Confirm email address" are ordinary fields and the first person is what makes this
 * one a declaration.
 */
const CONSENT =
  /\b(i (?:confirm|agree|accept|certify|acknowledge|consent|understand|declare|attest|have read)|terms (?:and conditions|of (?:use|service))|privacy (?:policy|notice|statement)|consent to|data processing|gdpr|declaration|not a robot)\b/i;

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

/**
 * How a legal label maps onto the ApplicationAnswers row.
 *
 * EVERY PATTERN HERE MUST ALSO MATCH `LEGAL`, which is the gate this is only reached
 * through. A phrasing added here and not there does nothing at all, silently - the
 * field falls past the legal branch and ends up "no stored answer matches", which is
 * the complaint this list exists to answer.
 *
 * WIDENED TO THE WORDING INDIAN FORMS ACTUALLY USE. "Current CTC" is the textbook
 * phrasing and the boards write "Present CTC", "Current Fixed CTC", "CTC expectation",
 * "How soon can you join?" and "Date of joining". Each of those was a box left empty
 * next to a stored answer that would have filled it.
 */
const LEGAL_KEYS: readonly [AnswerKey, RegExp][] = [
  ['needsSponsorship', /\b(sponsor(?:ship|ed|ing)?|visa)\b/i],
  [
    'workAuthorization',
    /\b(work authoriz|work permit|authoriz(?:ed|ation) to work|legally (?:authoriz|entitl|eligib)|right to work|citizen(?:ship)?)\b/i,
  ],
  ['noticePeriodDays', /\b(notice period|period of notice)\b/i],
  [
    'currentCtcLpa',
    /\b(?:current|present|latest|existing) (?:annual )?(?:ctc|salary|compensation|pay|package|fixed)\b/i,
  ],
  [
    'expectedCtcLpa',
    /\b((?:expected|desired|preferred) (?:annual )?(?:ctc|salary|compensation|pay|package)|(?:salary|compensation|ctc) expectation)\b/i,
  ],
  ['willingToRelocate', /\brelocat(?:e|ion|ing)\b/i],
  [
    'earliestStartDate',
    /\b(earliest start|start date|available to start|available from|availability|joining date|date of joining|how soon can you join|when can you (?:join|start))\b/i,
  ],
];

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

  // BEFORE THE LEGAL BRANCH. A declaration that mentions work authorisation is a
  // signature, not a question - see CONSENT. Restricted to the controls a declaration
  // is actually made with, so a text box asking "which terms of service have you worked
  // on" stays ordinary.
  if (
    (type === 'checkbox' || type === 'radio' || type === 'other') &&
    CONSENT.test(text)
  ) {
    return {
      fieldClass: 'consent',
      key: null,
      reason: 'a declaration only you can make, so it is never ticked for you',
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

  // Any textarea that got this far wants prose.
  //
  // WAS: a textarea whose label ran to four words or more. The count was standing in
  // for "this is a question rather than a field", and it is not needed - a textarea
  // reaching this line has already failed the resume, cover-letter, legal and ordinary
  // patterns, and the only thing left for it to be is writing. The threshold's one real
  // effect was on the short labels: "Additional Information" is two words, so the box
  // every Ashby form ends with was reported as "no stored answer matches" - which reads
  // as a missing setting rather than as a paragraph nobody can write for you.
  if (type === 'textarea') {
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
