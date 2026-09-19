/**
 * The adapter contract.
 *
 * PLAN-v2 phase 6, verbatim: "Adapters have NO submit codepath at all - structural,
 * not a flag." The structure is the `FormPage` type in form-page.ts - an adapter is
 * handed a page it cannot submit, so the absence of a submit codepath is not a claim
 * about this file's contents, it is a property of what an adapter is able to express.
 *
 * WHAT AN ADAPTER IS FOR. Not the filling - that is one shared engine, because the
 * rules about which questions may be answered are the same on every board and must
 * not be re-implemented four times with a different mistake in each. An adapter
 * supplies the two things that genuinely differ per ATS: which URLs it owns, and the
 * field NAMES that board keeps stable. Everything else is labels, and labels are the
 * engine's job.
 */
import type { AtsType } from '@prisma/client';
import type { AnswerKey, FieldClass } from './field-policy';
import type { AnswerSet } from './answers';
import type { FormPage } from './form-page';

/** One application, prepared by tailoring and waiting for a human to send it. */
export interface PreparedApplication {
  applicationId: string;
  jobId: string;
  /** Where the form is. `JobPosting.applyUrl`. */
  applyUrl: string;
  title: string;
  company: string;
  /** Everything that may be typed. */
  answers: AnswerSet;
  /**
   * Where to write the audit screenshot, decided by the caller rather than by the
   * adapter - the path encodes the application id and the run, which an adapter has
   * no business naming. Null skips it.
   */
  screenshotPath: string | null;
}

/** What happened to one field. */
export interface FilledField {
  label: string;
  handle: string;
  required: boolean;
  outcome: 'filled' | 'blank' | 'skipped' | 'failed';
  /** The key that answered it, when one did. */
  key: AnswerKey | null;
  /**
   * What kind of question it was judged to be.
   *
   * Stored alongside the outcome because "left blank" has several meanings and they
   * call for different things: an EEO box is finished, a declaration wants one click,
   * and a question with no stored answer wants an answer. The answers screen reads
   * this to offer back the third kind and only the third kind.
   */
  fieldClass: FieldClass;
  /** Why it ended that way, in the words the run log prints. */
  reason: string;
  /**
   * What was typed. OMITTED FOR ANYTHING SENSITIVE - the salary and authorization
   * answers are not written into a log that gets pasted into a bug report. The label
   * and the outcome are enough to see whether the form is ready.
   */
  value?: string;
}

export interface PrefillResult {
  /** Fields the form marked required, and how many of them are now non-empty. This
   *  ratio is `Application.prefillCoverage` - PLAN.txt verification item 4, the
   *  number that says how much manual effort an application still costs. */
  requiredTotal: number;
  requiredFilled: number;
  fields: FilledField[];
  /** Questions a human has to answer: long-form prose, legal questions with no stored
   *  answer, and anything required that could not be filled. */
  needsHuman: string[];
  /** Full-page screenshot, for the audit trail. */
  screenshotPath: string | null;
}

export interface AtsAdapter {
  readonly atsType: AtsType;

  /**
   * Whether this adapter actually fills a form, or declines and hands the URL to a
   * human.
   *
   * DECLARED HERE SO A SCREEN CAN ASK BEFORE THE BROWSER OPENS. `prefill` answers the
   * same question, but only after a run - and a list of postings has to be able to say
   * "this one you fill yourself" while it is still a list. Without it the app offers
   * every row identically and the difference only shows up as an application sitting at
   * 0% coverage, which reads as a failure rather than as the policy it is.
   *
   * Set on the ADAPTER rather than kept as a list of AtsType values somewhere else,
   * because the decision follows the form and the URL is what says which form: a
   * posting whose stored atsType is GREENHOUSE and whose link redirects to Workday is
   * a by-hand application, whatever the connector recorded.
   */
  readonly automated: boolean;

  /** Whether this adapter owns the URL. Matched on the host, never on the posting's
   *  recorded atsType - a posting reached through a redirect lands somewhere the
   *  connector did not predict. */
  canHandle(url: string): boolean;

  /**
   * Fills every field it can. NEVER clicks submit - see form-page.ts for why it
   * cannot.
   */
  prefill(page: FormPage, app: PreparedApplication): Promise<PrefillResult>;
}

/**
 * The field names one ATS keeps stable, mapped to what they want.
 *
 * Checked BEFORE the label rules and, when it hits, trusted over them. That ordering
 * is the whole value of a tier-1 adapter: Greenhouse's `first_name` is `first_name` on
 * every board on the platform, whereas the label above it is whatever the customer
 * typed - "Legal first name", "Prénom", or on one real board, nothing at all.
 *
 * A name mapped to `null` is one to LEAVE ALONE even though its label looks
 * answerable, which is how the EEO blocks that share a naming convention are excluded
 * as a group rather than one phrasing at a time.
 */
export type NameMap = Readonly<Record<string, AnswerKey | null>>;

/** How coverage is reported when a form has no required fields at all. */
export function coverage(result: {
  requiredTotal: number;
  requiredFilled: number;
}): number {
  // 1, not 0. A form with nothing required is fully prepared, and reporting 0 would
  // make the fleet-wide average read as a failure on the easiest forms there are.
  if (result.requiredTotal === 0) return 1;
  return result.requiredFilled / result.requiredTotal;
}
