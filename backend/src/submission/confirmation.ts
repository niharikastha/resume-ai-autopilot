/**
 * Did the employer say they got it?
 *
 * PLAN-v2 phase 6, in the safety rails: "result recorded ONLY on detected
 * confirmation, never optimistically". The reason is what an unfounded SUBMITTED row
 * does downstream - the unique index on (userId, companyId, normalizedTitle) means
 * this system will never offer that role again, so a row that claims an application
 * was sent when the human closed the tab instead is a job silently removed from the
 * search. The failure has to fall the other way: a real submission this cannot detect
 * stays PREPARED, the candidate sees it in the next run, and the duplicate is caught
 * by the same index at the database.
 *
 * A PURE FUNCTION OVER THE PAGE'S TEXT, so it is testable against the real phrases
 * the boards use rather than only against a live browser.
 */

/**
 * What a confirmation page says.
 *
 * Collected from the wording the tier-1 and tier-2 boards actually use. Each pattern
 * requires a VERB OF RECEIPT - "received", "submitted", "thank you for applying" -
 * because the application form itself contains the words "application" and the company
 * name, and a looser test would match the form the moment it loaded.
 */
const CONFIRMED: readonly RegExp[] = [
  /\byour application (?:has been |was )?(?:successfully )?(?:received|submitted|sent)\b/i,
  /\bapplication (?:successfully )?(?:received|submitted|complete[d]?)\b/i,
  /\bthank(?:s| you)[^.!?]{0,40}\bfor (?:applying|your application|your interest in applying)\b/i,
  /\bwe(?:'ve| have) (?:received|got) your application\b/i,
  /\byou(?:'ve| have) (?:successfully )?applied\b/i,
  /\bapplication submitted\b/i,
];

/**
 * Phrases that look like a confirmation and are not.
 *
 * Checked first. "Review your application before submitting" contains "your
 * application" and "submit", and it is the page immediately BEFORE the one this is
 * looking for - the most expensive false positive available.
 */
const NOT_YET: readonly RegExp[] = [
  /\breview your application\b/i,
  /\bbefore (?:you )?submit(?:ting)?\b/i,
  /\bready to submit\b/i,
  /\bplease (?:complete|fill|correct|fix)\b/i,
  /\bis required\b/i,
];

/**
 * The sentence that says the application arrived, or null.
 *
 * Returns the sentence rather than a boolean so it can be stored in
 * `Application.confirmationText` - which is the evidence for the SUBMITTED row, and
 * the thing to read when a company later says they never received anything.
 */
export function detectConfirmation(pageText: string): string | null {
  // SPLIT BEFORE COLLAPSING WHITESPACE, and the order is the whole reason this is
  // worth a comment. `innerText` separates one element from the next with a newline
  // and most page text has no terminal punctuation at all - a heading, a job title, a
  // paragraph. Collapsing first (which this did, and a test caught) glues the heading
  // and the company name onto the confirmation sentence, so the stored evidence
  // becomes "Acme Corp Backend Engineer Your application has been received."
  const sentences = pageText
    .split(/[\n•]+|(?<=[.!?])\s+/)
    .map((piece) => piece.replace(/\s+/g, ' ').trim())
    .filter((piece) => piece.length > 0);

  // Sentence-wise, so one stale validation message elsewhere on a real confirmation
  // page cannot veto the whole thing, and so the stored evidence is one sentence
  // rather than the entire document.
  for (const sentence of sentences) {
    if (NOT_YET.some((pattern) => pattern.test(sentence))) continue;
    if (CONFIRMED.some((pattern) => pattern.test(sentence))) {
      // Capped: some boards render the confirmation inside a wall of legal text with no
      // sentence breaks, and the column is evidence, not an archive.
      return sentence.slice(0, 400);
    }
  }

  return null;
}
