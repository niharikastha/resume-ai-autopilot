/**
 * Turning an ATS description body into the plain text that scoring reads.
 *
 * This is not cosmetic work. `descriptionText` is the ONLY thing phase 2 shows the
 * LLM, and phase 4 embeds. Markup left in it wastes context on `<div>` and shifts
 * the embedding toward the boilerplate every posting shares instead of the
 * requirements that distinguish them. Paragraph and list structure left OUT of it
 * is worse: "Python Java Kubernetes 5 years" reads as one requirement rather than
 * four, so the breaks are preserved deliberately.
 *
 * No cheerio, no jsdom. These are three known JSON APIs producing tame markup -
 * headings, paragraphs, lists, links - not arbitrary web pages, and a parser
 * dependency for that is weight without a matching risk. If a fourth source ever
 * needs real DOM handling, that is the point to add one.
 */

/**
 * The named entities that actually appear in job descriptions, plus the five that
 * are structural. Not the full HTML5 table (2,231 names): the long tail is
 * typographic, the numeric branch below catches anything missing, and an unknown
 * entity surviving as `&hellip;` in the text costs nothing.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  hellip: '...',
  bull: '*',
  middot: '*',
  reg: '(R)',
  copy: '(c)',
  trade: '(TM)',
  deg: ' degrees',
  eacute: 'e',
  euro: 'EUR',
  pound: 'GBP',
  rupee: 'INR',
};

/**
 * Decodes HTML entities once.
 *
 * ONCE is the operative word, and `&amp;` is why. Decoding repeatedly until the
 * string stops changing would turn `&amp;lt;script&gt;` - a posting that is
 * literally *discussing* a script tag, which happens in web-developer job
 * descriptions - into a real tag on the second pass. A single pass is what the
 * spec describes and is not a loop an input can steer.
 */
export function decodeEntities(input: string): string {
  return input.replace(
    /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g,
    (whole, body: string) => {
      if (body.startsWith('#')) {
        const code =
          body[1] === 'x' || body[1] === 'X'
            ? parseInt(body.slice(2), 16)
            : parseInt(body.slice(1), 10);
        // Reject the ranges String.fromCodePoint throws on (>0x10FFFF) and the
        // surrogate halves, which are not characters on their own. Returning the
        // entity unchanged is the safe failure: it stays visible instead of
        // crashing a whole board's fetch over one malformed posting.
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff)
          return whole;
        if (code >= 0xd800 && code <= 0xdfff) return whole;
        return String.fromCodePoint(code);
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    },
  );
}

/**
 * Placeholders a template engine leaves behind when the page ships unrendered.
 *
 * `{{job.title}}` from Angular, Vue and Handlebars; `${job.title}` from a few others.
 * Their presence in the TEXT - not in a script body, which `htmlToText` already
 * removed - means the browser was expected to fill them in, and the server sent the
 * empty form rather than the filled one.
 */
const PLACEHOLDER = /\{\{[^}]{1,120}\}\}|\$\{[^}]{1,120}\}/g;

/**
 * Does this page's text look like a shell that JavaScript was supposed to fill?
 *
 * WHY THIS EXISTS. TCS's iBegin portal answers 200 with 63 KB of HTML that reduces to
 * 1,800 characters of text - comfortably past any "is the page empty" floor - and every
 * one of those characters is either legal boilerplate or a literal `{{job.dateApplyBy}}`.
 * A model reading it correctly reports no openings, and the caller then tells the
 * operator to check they pasted the job list rather than an "about us" page. They did
 * paste the job list. The page simply has no jobs in it until a browser runs its code.
 *
 * TWO SIGNALS, EITHER IS ENOUGH:
 *
 *   1. unfilled placeholders survive into the text. Nothing a human is meant to read
 *      contains `{{...}}`, so even a couple of them means the template is raw.
 *   2. the text is a tiny fraction of the HTML that carried it. A real listing page is
 *      mostly words; a framework shell is mostly markup and script.
 *
 * DELIBERATELY CHEAP AND DELIBERATELY BEFORE THE MODEL. This is a pure string test, and
 * running it first means a page that provably cannot contain openings does not cost an
 * Opus call to find that out.
 *
 * IT CANNOT CATCH EVERY CASE, and must not pretend to: a shell rendered from a JSON blob
 * in a `<script>` tag leaves no placeholders and plenty of text. A false negative just
 * means the model reads the page and finds nothing, which is the behaviour without this
 * function at all. A false POSITIVE would be worse - it would refuse a readable page - so
 * both thresholds are set well clear of anything a real listing page produces.
 */
export function looksUnrendered(text: string, htmlLength: number): boolean {
  const placeholders = text.match(PLACEHOLDER)?.length ?? 0;
  // TCS's page leaves ten, so signal 1 is what catches it. Two rather than one, so a page
  // that genuinely prints a brace pair in prose is not condemned by it.
  if (placeholders >= 2) return true;

  // TCS measures 3.2% and so is NOT caught here - this second signal is for a shell that
  // ships no placeholders at all, and 1.5% is set below TCS deliberately: a page with
  // that little text per byte of markup has no listing in it whatever the reason. The
  // size floor keeps a genuinely small page out of it, where the ratio means nothing.
  return htmlLength > 20_000 && text.length / htmlLength < 0.015;
}

/** Elements after which a line break carries meaning. */
const BLOCK =
  'p|div|br|tr|h[1-6]|section|article|header|footer|ul|ol|dl|dt|dd|table|blockquote|pre|figure';

/**
 * HTML to readable plain text.
 *
 * Order is load-bearing throughout:
 *
 *  1. script/style/comment BODIES go first, while their tags still delimit them.
 *     Strip tags first and their contents become body text - a posting's tracking
 *     JavaScript would end up in the description the LLM reads.
 *  2. list items become "- " BEFORE tags are removed, since afterwards there is
 *     nothing left to tell an item from a paragraph.
 *  3. entities are decoded LAST. Decoding first would let a `&lt;b&gt;` that the
 *     employer wrote as visible text become a tag the stripper then eats, quietly
 *     deleting the words around it.
 */
export function htmlToText(html: string): string {
  if (!html) return '';

  let text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    // An unclosed <script> would otherwise leave its body behind. Anything after
    // an unterminated one is not description text anyway.
    .replace(/<(script|style|noscript)\b[\s\S]*$/gi, ' ');

  text = text
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/li\s*>/gi, '\n')
    .replace(new RegExp(`</?(?:${BLOCK})\\b[^>]*>`, 'gi'), '\n')
    // Every remaining tag, including malformed ones. `[^>]*` and not `.*` so an
    // unclosed `<` cannot swallow the rest of the document.
    .replace(/<[^>]*>/g, '');

  text = decodeEntities(text);

  return (
    text
      // Non-breaking and zero-width spaces, which &nbsp; and Unicode both supply.
      // Left in, they defeat the trim below and show up as ragged indentation.
      //
      // Written as escapes, not as the characters themselves: these are
      // invisible, and a literal zero-width space sitting in a character class
      // is something no reviewer can see and no editor shows you before you
      // delete it by accident.
      .replace(/[\u00a0\u200b-\u200d\ufeff]/g, ' ')
      .replace(/\r\n?/g, '\n')
      // Horizontal runs only - \n is excluded so the line structure survives.
      .replace(/[^\S\n]+/g, ' ')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      // Three or more blank lines add nothing but tokens. Two is a paragraph break.
      .replace(/\n{3,}/g, '\n\n')
      // A bullet whose text is wrapped in a block element of its own. Workday writes
      // `<li><p><span>Familiarity with Arista</span></p></li>`, so the <li> emits
      // "- " and the <p> inside it immediately emits a newline - leaving a lone "-"
      // on one line and its requirement on the next. EVERY bullet in EVERY Workday
      // posting reads that way, which detaches each requirement from the mark meant
      // to group it and undoes the reason list handling exists at all.
      .replace(/(^|\n)-\n+/g, '$1- ')
      // A list whose items got a break from both <li> and the block rule.
      .replace(/\n+- /g, '\n- ')
      .trim()
  );
}

/**
 * Greenhouse's `content` field, which arrives entity-escaped: the API returns
 * `&lt;p&gt;Hello&lt;/p&gt;`, not `<p>Hello</p>`.
 *
 * So it needs one decode to become HTML at all, and that decoded form is what gets
 * stored as `descriptionRaw` - keeping the escaped soup would leave every future
 * reader of that column to rediscover this. `htmlToText` then runs its own decode
 * pass over the text, which is correct rather than redundant: the two passes undo
 * two separate layers of escaping that Greenhouse genuinely applies.
 */
export function decodeGreenhouseContent(content: string): string {
  return decodeEntities(content ?? '');
}
