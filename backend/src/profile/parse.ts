/**
 * Turning resume text into atoms.
 *
 * An "atom" is one indivisible claim about the candidate - a bullet, a skills
 * line, a job held, a degree earned. Everything downstream is built on these:
 * matching embeds them, tailoring may draw from NOTHING ELSE, and the provenance
 * guard checks rewritten text against them. So the rule this whole file obeys is
 * that `text` is VERBATIM from the resume. Not summarised, not tidied, not
 * rephrased. Structure is inferred; prose is copied.
 *
 * That is also why this is a deterministic parser rather than a call to an LLM,
 * which is what PLAN-v2 phase 3 step 1 describes. Two reasons, and the second is
 * the real one:
 *
 *   1. No LLM key is configured yet (phase 2 is not built), and a parser that
 *      cannot run is not a parser.
 *   2. A model asked to "extract the bullets" will silently improve one. It will
 *      fix a typo, expand an abbreviation, round 8.61 to 8.6. Each edit is an
 *      improvement and each one breaks the guarantee that an atom is the
 *      candidate's own words - which is the guarantee the provenance guard is
 *      built on. Segmentation is a job for `indexOf`, not for inference.
 *
 * When phase 2 lands, the useful thing to give the LLM is the part this file is
 * genuinely weak at: tagging tech and metrics on an atom whose text is already
 * fixed, and rescuing a layout this parser reports low confidence on. Both are
 * additive, and neither may rewrite `text`.
 *
 * Nothing here is trusted on its own. `parseResume` returns warnings, the CLI
 * prints every atom, and nothing reaches the database until a human passes the
 * confirmation gate.
 */
import { AtomKind } from '@prisma/client';
import { IN_LOCATION } from '../discovery/normalize';
import { metricsIn } from './numbers';
import { splitTechList, techIn } from './tech';

/**
 * The parts of a piece a resume rarely states and this parser never guesses.
 *
 * ALWAYS EMPTY COMING OUT OF `parseResume`, and that is not a gap to be closed
 * later. A pdf line reading "B.Tech, Computer Science, 8.6" could be split into a
 * degree, a subject and a CGPA out of ten by a regex that is right about this
 * resume and wrong about the next one, and a wrong CGPA is a false claim on a real
 * application. So these are only ever filled in by a person typing into the upload
 * form, where being unsure means leaving the box empty.
 *
 * They travel with the atom rather than replacing anything: `text` is still the
 * line that prints and still the words that get embedded. These are what that line
 * was assembled from, kept so the form can show the same boxes again.
 */
export interface AtomDetails {
  /** A project's repository, live site or write-up. */
  link?: string | null;
  /** What a role paid, as typed. Never printed on a resume - see schema.prisma. */
  ctc?: string | null;
  /** "B.Tech", "MBA", or whatever was typed under "Other". */
  degree?: string | null;
  fieldOfStudy?: string | null;
  /** The figure as typed, e.g. "8.6" or "82.4". A string, so 8.6 stays 8.6. */
  score?: string | null;
  /** What the figure is out of. "100" means it is a percentage. */
  scoreOutOf?: string | null;
}

/** One atom, before it has an id or an embedding. */
export interface ParsedAtom {
  kind: AtomKind;
  /** The candidate's own words, verbatim. */
  text: string;
  tech: string[];
  metrics: string[];
  /** The employer, or for a project section, the project's name. */
  employer?: string;
  dateRange?: string;
  /** Typed in by hand, never read out of the file. See AtomDetails. */
  details?: AtomDetails;
}

/** Everything read out of one resume file. */
export interface ParsedProfile {
  fullName: string;
  email: string | null;
  phone: string | null;
  location: string | null;
  linkedIn: string | null;
  github: string | null;
  portfolio: string | null;
  /**
   * The tagline under the name, if there is one.
   *
   * Recognised so it is not mistaken for a bullet, and reported at the gate, but
   * NOT stored: there is no column for it, and a headline is a claim the tailored
   * resume writes fresh for each role rather than a fact to be preserved.
   */
  headline: string | null;
  atoms: ParsedAtom[];
  /** Things a human should look at. Never fatal on their own. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Line classification
// ---------------------------------------------------------------------------

/**
 * Bullet markers seen in the wild, written as code points.
 *
 * Escapes rather than the characters themselves. Three separate bugs in this
 * project came from invisible or lookalike characters sitting in source - a
 * non-breaking space and a zero-width space in the HTML pipeline, a NUL byte in
 * discovery - and U+25AA and U+25A0 are two different markers that render close
 * enough to be indistinguishable when you read the line back.
 *
 * `-` and `*` are included; `o` as a marker is NOT, because a line starting with
 * the word "on" would become a bullet.
 */
const BULLET_MARKER =
  /^\s*[\u2022\u25CF\u25AA\u25E6\u2023\u2043\u2219\u00B7\u25AB\u25A0\u2212\u2013*-]\s+/;

/**
 * A date range, in the forms resumes actually use.
 *
 * The separator set includes the en and em dash as escapes, because a resume
 * exported from a word processor has had its hyphen autocorrected.
 */
const DATE_RANGE = new RegExp(
  String.raw`((?:jan|feb|mar|apr|apl|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*'?\d{2,4}|\d{1,2}[/.]\d{4}|\d{4})` +
    String.raw`\s*(?:[-\u2013\u2014]|to|until)\s*` +
    String.raw`((?:jan|feb|mar|apr|apl|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*'?\d{2,4}|\d{1,2}[/.]\d{4}|\d{4}|present|current|now|date|ongoing)`,
  'i',
);

/** "Tech Stack:", "Technologies:", "Tools & Frameworks:" - a labelled tech list. */
const TECH_LABEL =
  /^\s*(tech(nical)?\s*stack|technologies|tech|tools|stack|frameworks|languages|environment)\s*(used)?\s*:/i;

/**
 * Section headings, matched by KEYWORD rather than by "is it upper case".
 *
 * The tempting rule - all-caps short line is a heading - misfires on a company
 * written HYSCALER or TCS, and the cost is not cosmetic: a false heading ends the
 * experience section, so every bullet after it loses its employer attribution and
 * the tailored resume can no longer say where the work was done. An unrecognised
 * all-caps line therefore stays inside whatever section it is in, which is the
 * failure that loses nothing.
 */
const SECTIONS: { kind: SectionKind; pattern: RegExp }[] = [
  { kind: 'skills', pattern: /\b(skills|competenc|technical\s+summary)\b/i },
  {
    kind: 'experience',
    pattern: /\b(experience|employment|work\s+history|professional)\b/i,
  },
  { kind: 'projects', pattern: /\b(projects?|portfolio|open\s*source)\b/i },
  {
    kind: 'education',
    pattern: /\b(education|academics?|qualifications?)\b/i,
  },
  {
    kind: 'other',
    pattern:
      /\b(leadership|certification|certificate|achievement|award|publication|volunteer|interest|hobb|activit|extra[-\s]?curricular|positions?\s+of\s+responsibility|languages|references|summary|objective|profile|about|coursework|training)\b/i,
  },
];

type SectionKind =
  'header' | 'skills' | 'experience' | 'projects' | 'education' | 'other';

type LineKind = 'blank' | 'heading' | 'bullet' | 'role' | 'tech' | 'plain';

interface Line {
  kind: LineKind;
  /** The line with its bullet marker removed and both ends trimmed. */
  text: string;
  /** Columns of leading whitespace. Wrapped bullets are indented past this. */
  indent: number;
  /** Only for `heading`. */
  section?: SectionKind;
  raw: string;
}

/**
 * Recognises a heading only if it is BOTH visually set apart and a known word.
 *
 * "Visually set apart" means all-caps, or title-case-and-short, or followed by a
 * rule of dashes/underscores. Requiring both tests is what stops a bullet that
 * happens to contain the word "projects" from ending the experience section.
 */
function asHeading(trimmed: string): SectionKind | undefined {
  if (trimmed.length === 0 || trimmed.length > 45) return undefined;
  // A heading is a label, not a sentence. Punctuation that ends a clause rules
  // it out, as does a date - "EXPERIENCE 2024" is a heading, but a line with a
  // full date range in it is a role.
  if (/[.;:,]$/.test(trimmed)) return undefined;
  if (DATE_RANGE.test(trimmed)) return undefined;

  const letters = trimmed.replace(/[^A-Za-z]/g, '');
  if (letters.length < 3) return undefined;
  const isUpper = letters === letters.toUpperCase();
  // Title Case with at most three words: "Work Experience", "Technical Skills".
  const isShortTitle = trimmed.split(/\s+/).length <= 3;
  if (!isUpper && !isShortTitle) return undefined;

  return SECTIONS.find((s) => s.pattern.test(trimmed))?.kind;
}

/** Splits the document into classified lines. */
function classify(text: string): Line[] {
  return (
    text
      // Normalise the line endings and the space-like characters poppler emits,
      // again as escapes: a non-breaking space is whitespace to a human and not
      // to `\s` in some engines, so an indent measured in them reads as zero.
      .replace(/\r\n?/g, '\n')
      .replace(/[\u00A0\u2007\u2009\u202F\u2002-\u200A]/g, ' ')
      .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')
      .split('\n')
      // A form feed is poppler's page break. Stripped rather than filtered on: on
      // a two-page resume it arrives ATTACHED to a real line, so dropping the
      // line would lose the first heading of page two.
      .map((rawWithFeed): Line => {
        const raw = rawWithFeed.replace(/\f/g, '');
        const trimmed = raw.trim();
        const indent = raw.length - raw.trimStart().length;

        if (trimmed.length === 0) {
          return { kind: 'blank', text: '', indent, raw };
        }

        // A rule of dashes under a heading, or a decorative separator.
        if (/^[-_=\u2013\u2014\s]{3,}$/.test(trimmed)) {
          return { kind: 'blank', text: '', indent, raw };
        }

        const section = asHeading(trimmed);
        if (section) {
          return { kind: 'heading', text: trimmed, indent, section, raw };
        }

        const bullet = BULLET_MARKER.exec(raw);
        if (bullet) {
          return {
            kind: 'bullet',
            text: raw.slice(bullet[0].length).trim(),
            indent,
            raw,
          };
        }

        if (TECH_LABEL.test(trimmed)) {
          return { kind: 'tech', text: trimmed, indent, raw };
        }

        if (DATE_RANGE.test(trimmed)) {
          return { kind: 'role', text: trimmed, indent, raw };
        }

        return { kind: 'plain', text: trimmed, indent, raw };
      })
  );
}

// ---------------------------------------------------------------------------
// The header block
// ---------------------------------------------------------------------------

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
/** Ten digits with optional country code and the separators people use. */
const PHONE = /(?:\+?\d{1,3}[\s-]?)?(?:\d[\s-]?){9,12}\d/;

/**
 * Reads the contact block, preferring the PDF's link annotations to the text.
 *
 * The annotation is the authoritative answer for LinkedIn and GitHub - the
 * visible text is usually a bare handle, and rebuilding `github.com/<handle>`
 * from it is a convention that breaks on a vanity domain or a handle that
 * differs between the two sites. So: annotations first, regex on the text only
 * as a fallback.
 */
function readHeader(
  lines: Line[],
  links: string[],
  warnings: string[],
): Omit<ParsedProfile, 'atoms' | 'warnings'> {
  const headerLines = lines.slice(
    0,
    lines.findIndex((l) => l.kind === 'heading') === -1
      ? lines.length
      : lines.findIndex((l) => l.kind === 'heading'),
  );
  const content = headerLines.filter((l) => l.kind !== 'blank');
  const headerText = content.map((l) => l.text).join('\n');

  const fullName = content[0]?.text.trim() ?? '';
  if (!fullName) warnings.push('no name found on the first line of the resume');
  if (fullName.length > 60) {
    warnings.push(
      `the name reads as "${fullName}" - the first line may be a summary rather than a name`,
    );
  }

  // The tagline: second line, and only if it looks like one. `|` separators, or
  // simply longer than a name and not a contact line.
  const second = content[1]?.text ?? '';
  const headline =
    second &&
    !EMAIL.test(second) &&
    (second.includes('|') || (second.length > 30 && !PHONE.test(second)))
      ? second
      : null;

  const link = (test: RegExp): string | null =>
    links.find((href) => test.test(href)) ?? null;

  const mailto = link(/^mailto:/i);
  const email =
    mailto?.replace(/^mailto:/i, '').trim() ??
    EMAIL.exec(headerText)?.[0] ??
    null;
  if (!email) {
    warnings.push(
      'no email address found - applications need one, so add it before confirming',
    );
  }

  const tel = link(/^tel:/i);
  const phone =
    tel?.replace(/^tel:/i, '').trim() ??
    // Searched per line, not across the whole block: a greedy digit run over a
    // joined string can span an email's digits and a postcode.
    content
      .map((l) => PHONE.exec(l.text)?.[0])
      .find(Boolean)
      ?.trim() ??
    null;

  const linkedIn = link(/linkedin\.com/i);
  const github = link(/github\.com/i);
  if (!linkedIn) warnings.push('no LinkedIn URL found');
  if (!github) warnings.push('no GitHub URL found');

  // A personal site is "an http link that is not one of the known networks".
  const portfolio =
    links.find(
      (href) =>
        /^https?:/i.test(href) &&
        !/(linkedin|github|twitter|x\.com|leetcode|hackerrank|medium|dev\.to|stackoverflow)\./i.test(
          href,
        ),
    ) ?? null;

  return {
    fullName,
    email,
    phone,
    location: readLocation(content),
    linkedIn,
    github,
    portfolio,
    headline,
  };
}

/**
 * The candidate's city.
 *
 * Reuses discovery's Indian-location list rather than keeping a second copy: the
 * point of `location` is that it is compared against a posting's location, and
 * two lists that drift apart would make a candidate in Bengaluru unmatchable
 * against a Bengaluru job. Falls back to the leftover column on the contact line
 * for anyone outside that list.
 */
function readLocation(content: Line[]): string | null {
  for (const line of content) {
    // `-layout` separates the header's columns with runs of spaces, so this is a
    // column split, not a word split.
    for (const cell of line.text.split(/\s{2,}/)) {
      const value = cell.trim();
      if (!value || EMAIL.test(value)) continue;
      if (IN_LOCATION.test(value)) return value;
    }
  }

  // Nothing recognised. Take a cell that is words-only and short - a city, not a
  // handle, a phone number or a URL.
  for (const line of content.slice(1)) {
    for (const cell of line.text.split(/\s{2,}/)) {
      const value = cell.trim();
      if (
        value.length >= 3 &&
        value.length <= 40 &&
        /^[A-Za-z][A-Za-z\s.,'-]+$/.test(value) &&
        !/^https?:/i.test(value) &&
        !value.includes('@')
      ) {
        return value;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bullets and their continuations
// ---------------------------------------------------------------------------

/**
 * Rejoins a bullet that wrapped onto the following lines.
 *
 * This is the single most important thing `-layout` buys us. A wrapped bullet's
 * continuation is indented to sit under the first line's text, so a following
 * `plain` line indented further than the marker belongs to the bullet. Get it
 * wrong and one achievement becomes two atoms, the second of which is a sentence
 * fragment - and a fragment embedded as a standalone claim is both a bad match
 * and, if tailoring ever quotes it, an incoherent bullet on a real resume.
 *
 * Returns the joined text and the index to continue from.
 */
function joinContinuations(
  lines: Line[],
  start: number,
): { text: string; next: number } {
  const first = lines[start];
  const parts = [first.text];
  let i = start + 1;

  for (; i < lines.length; i++) {
    const line = lines[i];
    // A blank line ends a bullet even if the next line is indented: publishers of
    // resumes use spacing between bullets, never inside one.
    if (line.kind !== 'plain') break;
    if (line.indent <= first.indent) break;
    parts.push(line.text);
  }

  return {
    // Joined with a space. A hyphen at the end of a continuation could be a
    // hyphenated word split across lines, but it is far more often a real hyphen
    // ("AI-powered"), and stitching those together would corrupt the text - which
    // is the one thing this file may not do.
    text: parts.join(' ').replace(/\s+/g, ' ').trim(),
    next: i,
  };
}

/** Splits a role line into its title and its dates. */
function splitRoleLine(text: string): { title: string; dateRange?: string } {
  const match = DATE_RANGE.exec(text);
  if (!match) return { title: text };
  const title = (
    text.slice(0, match.index) + text.slice(match.index + match[0].length)
  )
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s|,\u2013\u2014-]+$/, '')
    .trim();
  return { title, dateRange: match[0].replace(/\s+/g, ' ').trim() };
}

/** The next line that carries content, or undefined at the end. */
function nextContent(lines: Line[], from: number): Line | undefined {
  for (let i = from; i < lines.length; i++) {
    if (lines[i].kind !== 'blank') return lines[i];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The parse
// ---------------------------------------------------------------------------

/** Builds an atom, tagging tech and metrics from its own text. */
function atom(
  kind: AtomKind,
  text: string,
  extra: {
    tech?: string[];
    employer?: string;
    dateRange?: string;
    details?: AtomDetails;
  } = {},
): ParsedAtom {
  return {
    kind,
    text,
    // The explicit list keeps its position, the dictionary hits follow, and the
    // set removes the overlap. A "Tech Stack:" line naming Docling and a
    // dictionary hit on Node.js are both true and the guard needs the union.
    tech: [...new Set([...(extra.tech ?? []), ...techIn(text)])],
    // NO metrics on a ROLE atom. A job title carries digits that are not
    // achievements - "Software Developer Engineer - 1" is a level, "Engineer II"
    // is a grade - and `metrics` is not a display field: the provenance guard
    // uses it as the list of numbers a rewrite of this atom may contain. Letting
    // a seniority number in there licenses the model to put a bare "1" into a
    // bullet and have it pass. EDU keeps its metrics, because a CGPA is a real
    // figure a resume legitimately restates.
    metrics: kind === AtomKind.ROLE ? [] : metricsIn(text),
    employer: extra.employer,
    dateRange: extra.dateRange,
    details: extra.details,
  };
}

/**
 * Re-tag one atom whose text a human edited by hand in the web app.
 *
 * Exists so the tagging rules above have exactly one implementation. `tech` and
 * `metrics` are not decoration - the provenance guard treats them as the complete
 * list of technologies and figures a rewrite of this atom is allowed to contain -
 * so an edited bullet whose tags still describe its previous wording is a guard
 * checking against the wrong facts. Re-deriving them is not optional.
 *
 * A tag the words do not support is therefore NOT expressible here, and that is
 * the point: SkillsReserve is where a candidate declares a skill their resume
 * never mentions, with a note saying why.
 */
export function retagAtom(input: {
  kind: AtomKind;
  text: string;
  /** Explicit tags, as a "Tech Stack:" line would have supplied. */
  tech?: string[];
  employer?: string;
  dateRange?: string;
  /** Carried through untouched. Nothing here is derived from the text, so nothing
   *  here goes stale when the text is edited. */
  details?: AtomDetails;
}): ParsedAtom {
  return atom(input.kind, input.text, {
    tech: input.tech,
    employer: input.employer,
    dateRange: input.dateRange,
    details: input.details,
  });
}

/**
 * Parses resume text into a profile and its atoms.
 *
 * `links` come from the PDF's annotations - pass `[]` for plain text.
 */
export function parseResume(text: string, links: string[] = []): ParsedProfile {
  const warnings: string[] = [];
  const lines = classify(text);
  const header = readHeader(lines, links, warnings);
  const atoms: ParsedAtom[] = [];

  let section: SectionKind = 'header';
  /** The employer or project the following bullets belong to. */
  let employer: string | undefined;
  let dateRange: string | undefined;
  /**
   * The ROLE atom the following lines belong to.
   *
   * Held so a "Tech Stack:" line can be merged into it. That line usually sits
   * BELOW the title, so the atom already exists by the time the list is read.
   */
  let roleAtom: ParsedAtom | undefined;
  /** A plain line waiting to see whether it is an employer or a group label. */
  let pending: string | undefined;
  /**
   * Bullets in EXPERIENCE or PROJECTS with nothing to attribute them to.
   *
   * Counted here rather than in `finish` because a LEADERSHIP or CERTIFICATIONS
   * bullet legitimately has no employer, and a warning that fires on those is a
   * warning nobody reads.
   */
  let unattributed = 0;

  for (let i = 0; i < lines.length;) {
    const line = lines[i];

    if (line.kind === 'blank') {
      i++;
      continue;
    }

    if (line.kind === 'heading') {
      section = line.section as SectionKind;
      employer = undefined;
      dateRange = undefined;
      roleAtom = undefined;
      pending = undefined;
      i++;
      continue;
    }

    if (section === 'header') {
      // Still in the contact block; readHeader already has these.
      i++;
      continue;
    }

    if (line.kind === 'bullet') {
      const joined = joinContinuations(lines, i);
      i = joined.next;

      if (joined.text.length < 3) continue;

      if (section === 'skills') {
        // A skills bullet is a LIST, so its items are read out explicitly rather
        // than left to the dictionary. "AI / ML: LLM, RAG, Vector Databases"
        // becomes one atom whose text is that line and whose tech is those three.
        atoms.push(
          atom(AtomKind.SKILL, joined.text, {
            tech: splitTechList(joined.text),
          }),
        );
        continue;
      }

      // Tagged from ITS OWN TEXT only. The role's "Tech Stack:" line is
      // deliberately not copied down here: it lists everything the job touched,
      // so copying it would tag the video-conferencing bullet with pgvector and
      // LLM, and `tech` is what the provenance guard consults when deciding
      // whether a rewrite of THIS bullet may name a technology. The stack is not
      // lost - it is on the ROLE atom, so the union the guard builds is the same.
      atoms.push(atom(AtomKind.BULLET, joined.text, { employer, dateRange }));
      if (!employer && (section === 'experience' || section === 'projects')) {
        unattributed++;
      }
      continue;
    }

    if (line.kind === 'tech') {
      // Merged into the ROLE atom rather than becoming an atom of its own: "Tech
      // Stack: Node.js, React" is not a claim about what the candidate DID, it is
      // a property of the job they did it in.
      if (roleAtom) {
        roleAtom.tech = [
          ...new Set([...roleAtom.tech, ...splitTechList(line.text)]),
        ];
      }
      i++;
      continue;
    }

    if (line.kind === 'role') {
      const { title, dateRange: dates } = splitRoleLine(line.text);
      dateRange = dates;

      if (section === 'education') {
        // "Bachelor of Technology (IT) - 8.61 CGPA   Nov 2020 - May 2024", with
        // the institution on the line before it.
        atoms.push(
          atom(AtomKind.EDU, title, { employer: pending, dateRange: dates }),
        );
        employer = pending;
        pending = undefined;
        i++;
        continue;
      }

      // An employer on the same line as the title: "Hyscaler | SDE-1  Jan 2024 -".
      let holder = pending;
      let roleTitle = title;
      if (!holder && title.includes('|')) {
        const at = title.lastIndexOf('|');
        holder = title.slice(0, at).trim();
        roleTitle = title.slice(at + 1).trim();
      }

      if (!holder && section === 'experience') {
        warnings.push(
          `no employer found for the role "${roleTitle}" - bullets under it will ` +
            'have no company attached, so tailoring cannot say where the work was done',
        );
      }

      employer = holder ?? (section === 'projects' ? roleTitle : undefined);
      // A project's "employer" is the project itself. AtomKind has no PROJECT
      // member and adding one would be a migration for no gain: what tailoring
      // needs is an attribution string, and the project's name is that string.
      roleAtom = atom(AtomKind.ROLE, roleTitle, {
        employer,
        dateRange: dates,
      });
      atoms.push(roleAtom);
      pending = undefined;
      i++;
      continue;
    }

    // A plain line. What it is depends on what follows it.
    const following = nextContent(lines, i + 1);

    if (section === 'skills') {
      // An unbulleted skills line, which is how many resumes write the section.
      atoms.push(
        atom(AtomKind.SKILL, line.text, { tech: splitTechList(line.text) }),
      );
      i++;
      continue;
    }

    if (following?.kind === 'role') {
      // The employer/institution line above a dated title.
      pending = line.text;
      i++;
      continue;
    }

    if (section === 'projects' && following?.kind === 'bullet') {
      // An undated project header: "AI Knowledge Assistant (RAG-based)".
      employer = line.text;
      dateRange = undefined;
      roleAtom = atom(AtomKind.ROLE, line.text, { employer: line.text });
      atoms.push(roleAtom);
      i++;
      continue;
    }

    if (section === 'education') {
      // Reached only when the line is NOT followed by a dated degree line - that
      // case was handled above and set `pending`. So this is a standalone
      // education line: a school with no dates, a board exam, a percentage.
      atoms.push(atom(AtomKind.EDU, line.text, { employer: pending }));
      pending = undefined;
      i++;
      continue;
    }

    if (section === 'other' && following?.kind !== 'bullet') {
      // A standalone line in LEADERSHIP / CERTIFICATIONS is itself the claim.
      atoms.push(atom(AtomKind.BULLET, line.text, { employer }));
      i++;
      continue;
    }

    // Anything else inside a role is a group label - "AI & LLM Engineering" -
    // which organises the bullets below it and asserts nothing by itself. It is
    // deliberately NOT stored as `pending`: doing so would make the next role
    // line read the label as its employer.
    i++;
  }

  return { ...header, atoms: finish(atoms, warnings, unattributed), warnings };
}

/**
 * Deduplicates, and warns about the shapes that mean the parse went wrong.
 *
 * These checks exist because a layout this parser has not seen fails QUIETLY -
 * it produces atoms, just the wrong ones. A count and a couple of length checks
 * are what turn that into something the confirmation gate can show a human.
 */
function finish(
  atoms: ParsedAtom[],
  warnings: string[],
  unattributed: number,
): ParsedAtom[] {
  const seen = new Map<string, ParsedAtom>();
  for (const candidate of atoms) {
    const key = `${candidate.kind}:${candidate.text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.set(key, candidate);
  }
  const unique = [...seen.values()];
  if (unique.length < atoms.length) {
    warnings.push(
      `dropped ${atoms.length - unique.length} duplicate atom(s) - harmless if the ` +
        'resume repeats a line, worth a look if it does not',
    );
  }

  const bullets = unique.filter((a) => a.kind === AtomKind.BULLET);
  if (bullets.length === 0) {
    warnings.push(
      'no bullet atoms found. Tailoring has nothing to draw from - the resume ' +
        'layout is probably one this parser does not read. Try exporting a ' +
        'simpler PDF, or paste the text into a .txt file and ingest that.',
    );
  }
  if (unique.filter((a) => a.kind === AtomKind.SKILL).length === 0) {
    warnings.push(
      'no skills atoms found - check that the SKILLS heading parsed',
    );
  }

  const runOn = bullets.filter((a) => a.text.length > 400);
  if (runOn.length > 0) {
    warnings.push(
      `${runOn.length} bullet(s) are over 400 characters, which usually means two ` +
        `bullets were joined. First: "${runOn[0].text.slice(0, 80)}..."`,
    );
  }
  const fragments = bullets.filter((a) => a.text.length < 25);
  if (fragments.length > 0) {
    warnings.push(
      `${fragments.length} bullet(s) are under 25 characters, which usually means a ` +
        `wrapped line was split. First: "${fragments[0].text}"`,
    );
  }
  if (unattributed > 0) {
    warnings.push(
      `${unattributed} work/project bullet(s) have no employer attached, so a ` +
        'tailored resume cannot say where that work was done',
    );
  }

  return unique;
}
