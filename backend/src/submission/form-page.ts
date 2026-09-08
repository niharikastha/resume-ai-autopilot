/**
 * The only view of a browser page that phase 6 gives anything.
 *
 * WHY A FACADE INSTEAD OF PLAYWRIGHT'S `Page`. PLAN-v2 phase 6 requires that
 * adapters have "NO submit codepath at all - structural, not a flag". A flag is a
 * boolean someone can flip, a config someone can override, a branch a future edit
 * can take by accident. Handing an adapter the real `Page` makes the guarantee a
 * promise about what the code happens to call today, and `page.click('button')` is
 * one keystroke away from being an application sent without a human reading it.
 *
 * So the guarantee is expressed in the TYPE. There is no method on this interface
 * that activates a submit control: no `click`, no `press`, no `evaluate`, no
 * `keyboard`, no route to the raw page. An adapter cannot submit a form for the same
 * reason it cannot open a socket - the capability was never passed to it. Adding one
 * would mean editing this file, which is a change a reviewer sees rather than a line
 * buried in a per-ATS field map.
 *
 * `reveal` is the one method that activates anything, because Ashby and
 * SmartRecruiters build their dropdowns out of divs and a field that never opens
 * cannot be filled. It is guarded at runtime as well as by intent - see the
 * implementation in playwright.page.ts - and it is the single place in this phase
 * worth re-reading when something goes wrong.
 */

/** What kind of control a field is, reduced to the cases a filler treats differently. */
export type FieldType =
  | 'text'
  | 'email'
  | 'tel'
  | 'url'
  | 'number'
  | 'date'
  | 'textarea'
  | 'select'
  | 'checkbox'
  | 'radio'
  | 'file'
  | 'other';

/**
 * One control on the form, as the facade reports it.
 *
 * `label` IS THE PRIMARY IDENTITY, not `name`. Greenhouse and Lever have stable
 * field names and the tier-1 adapters use them; Ashby, SmartRecruiters and every
 * in-house form generate them, so the only durable handle on "the phone number box"
 * is the words next to it. Both are reported and each adapter uses what its ATS
 * actually keeps stable.
 */
export interface FormField {
  /**
   * How to name this field back to the facade. Opaque, and only valid for the page
   * that produced it: it may be an index into that page's control list rather than a
   * CSS selector, precisely so an adapter cannot construct one for a control the
   * facade never reported.
   */
  readonly handle: string;
  readonly type: FieldType;
  /** The visible label, trimmed and collapsed. Empty when the form has none. */
  readonly label: string;
  /** The `name` attribute, when the form has one. */
  readonly name: string | null;
  /** From `required`, `aria-required`, or an asterisk in the label. */
  readonly required: boolean;
  /** Choices, for select and radio. Empty otherwise. */
  readonly options: readonly string[];
  /** Whatever is already in the control. Non-empty means the browser profile
   *  autofilled it, or a previous run of this adapter did. */
  readonly value: string;
}

/**
 * A page a form filler may fill and may not send.
 *
 * Every method is by `handle` - a value that came out of `fields()` on this same
 * page. Nothing takes a selector the caller invented.
 */
export interface FormPage {
  readonly url: string;

  /** Every control the filler could act on, in document order. */
  fields(): Promise<FormField[]>;

  /** Types into a text-like control. Clears first, so it is idempotent. */
  fill(handle: string, value: string): Promise<void>;

  /** Chooses an option. Throws if `value` is not one of the field's options, rather
   *  than silently leaving a required dropdown empty. */
  select(handle: string, value: string): Promise<void>;

  /** Ticks a checkbox or picks a radio. Never unticks - a form arriving with a box
   *  already ticked was ticked by the human or by their browser profile. */
  check(handle: string): Promise<void>;

  /** Attaches a file. `absolutePath` must exist; the caller has the tailored PDF. */
  attach(handle: string, absolutePath: string): Promise<void>;

  /**
   * Opens a collapsed widget so its fields exist in the DOM.
   *
   * THE ONE METHOD THAT ACTIVATES ANYTHING, and it refuses submit controls at
   * runtime - by element type and by accessible text. Read playwright.page.ts before
   * changing it.
   */
  reveal(handle: string): Promise<void>;

  /** Full-page screenshot, for the audit trail phase 6 requires. */
  screenshot(absolutePath: string): Promise<void>;
}
