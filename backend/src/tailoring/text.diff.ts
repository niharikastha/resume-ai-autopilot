/**
 * Word-level difference between two sentences.
 *
 * WHAT IT IS FOR. After a tailoring run the candidate is looking at a document and the
 * only honest question is "what is different from what I wrote". A before-and-after
 * pair does not answer it: two versions of the same bullet differ in four words out of
 * thirty, and finding those four by reading is exactly the work the screen should be
 * doing. So this returns the sentence once, with each run of words labelled kept,
 * added or removed, and the screen colours it.
 *
 * WORDS, NOT CHARACTERS. A character diff on prose produces shrapnel - it will happily
 * report that "optimised" and "improved" share an "o", "i" and "ed" - and a candidate
 * cannot read that. Words are also the unit the change is actually in: a model swaps
 * "built" for "architected", it does not edit letters.
 *
 * PURE, AND ITS OWN FILE, because it is the kind of function that is either right or
 * subtly wrong on the empty case, the identical case and the all-changed case, and
 * those are worth a check that does not need a database or an LLM to run.
 */

export type DiffChange = 'same' | 'added' | 'removed';

export interface DiffSegment {
  /** Words joined by single spaces. */
  text: string;
  change: DiffChange;
}

export interface WordDiff {
  segments: DiffSegment[];
  /** Words in `after` that are not in the common subsequence. */
  added: number;
  /** Words in `before` that are not in the common subsequence. */
  removed: number;
}

/** Words, with runs of whitespace collapsed. Empty input gives an empty list. */
function words(text: string): string[] {
  const trimmed = text.trim();
  return trimmed.length === 0 ? [] : trimmed.split(/\s+/);
}

/**
 * Compared case-insensitively, ignoring the punctuation AROUND a word.
 *
 * "delivery." and "Delivery" are the same word in a sentence whose shape changed, and
 * reporting them as one removal plus one addition would bury the real edit under the
 * comma that moved. The word REPORTED is always the original spelling - only the
 * comparison is loose.
 *
 * ONLY THE EDGES. Punctuation inside a word is part of it: "Node.js", "read-through"
 * and "CI/CD" are single tokens and stripping their middles would make them compare
 * equal to things they are not. `%`, `+` and `#` survive at the end because "40%",
 * "C++" and "C#" are words whose last character carries the meaning.
 */
function key(word: string): string {
  return word
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}%+#]+$/u, '');
}

/**
 * The diff.
 *
 * A longest-common-subsequence table, which is O(n*m) in words. A resume bullet is
 * thirty words, so the table is nine hundred small integers - the cost is not worth an
 * approximation that could mislabel a line.
 */
export function diffWords(before: string, after: string): WordDiff {
  const a = words(before);
  const b = words(after);

  // Length of the LCS of a[i..] and b[j..]. One row longer and wider than the inputs
  // so the base cases are reads rather than branches.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] =
        key(a[i]) === key(b[j])
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const segments: DiffSegment[] = [];
  let added = 0;
  let removed = 0;

  // Appends, merging into the previous segment when the label is the same, so the
  // screen gets "three removed words" as one span rather than three.
  const push = (word: string, change: DiffChange): void => {
    const last = segments[segments.length - 1];
    if (last && last.change === change) last.text += ` ${word}`;
    else segments.push({ text: word, change });
  };

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (key(a[i]) === key(b[j])) {
      // The word from AFTER, which is the text that is actually on the page. They
      // compare equal and may be spelled differently - see `key`.
      push(b[j], 'same');
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push(a[i], 'removed');
      removed++;
      i++;
    } else {
      push(b[j], 'added');
      added++;
      j++;
    }
  }
  while (i < a.length) {
    push(a[i], 'removed');
    removed++;
    i++;
  }
  while (j < b.length) {
    push(b[j], 'added');
    added++;
    j++;
  }

  return { segments, added, removed };
}
