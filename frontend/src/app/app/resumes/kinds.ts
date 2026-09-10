import type { AtomKind } from '@/lib/api';

/**
 * The four kinds of piece, in reading order, named the way a person would name
 * them rather than the way the database does.
 *
 * BULLET/SKILL/ROLE/EDU are good column values and bad headings. "BULLET" in
 * particular tells a candidate nothing - what they are looking at is the list of
 * things they did, and that is what the heading should say.
 */
export const KIND_ORDER: AtomKind[] = ['ROLE', 'BULLET', 'SKILL', 'EDU'];

export const KIND_LABEL: Record<AtomKind, string> = {
  ROLE: 'Jobs and projects',
  BULLET: 'What you did',
  SKILL: 'Skills',
  EDU: 'Education',
};

export const KIND_ONE: Record<AtomKind, string> = {
  ROLE: 'job or project',
  BULLET: 'thing you did',
  SKILL: 'skill',
  EDU: 'qualification',
};

export const KIND_HINT: Record<AtomKind, string> = {
  ROLE: 'One per employer or project. What it paid stays private; a project link does not.',
  BULLET:
    'These are what a tailored resume is allowed to draw from. Nothing outside this list ever appears on an application.',
  SKILL: 'Read from your resume. Fix a misspelling here and matching follows.',
  EDU: 'One per qualification. Filled in as parts, so nothing has to be typed in a particular order.',
};

/**
 * What the description box is asking for, in each section.
 *
 * An example rather than an instruction. "Enter your achievement" tells a person
 * nothing they had not worked out; a bullet with a real number in it shows what this
 * box is for in the length of time it takes to read.
 *
 * Education has none because it has no description box - its line is built from the
 * degree, the subject and the score.
 */
export const KIND_TEXT_PLACEHOLDER: Record<AtomKind, string> = {
  ROLE: 'e.g. Backend Engineer, or the name of the project',
  BULLET:
    'e.g. Cut checkout page load from 4.2s to 1.1s by caching the catalogue',
  SKILL: 'e.g. PostgreSQL',
  EDU: '',
};

/**
 * A qualification a person can pick instead of typing.
 *
 * `match` is only used when reading an uploaded resume: the parse produces one line
 * per qualification, and recognising "B.Tech" in it puts the dropdown on the right
 * option instead of leaving every education row set to Other. It is deliberately
 * strict - a line it does not recognise stays under Other with the original wording
 * kept whole, which is wrong-looking but never wrong.
 *
 * Indian qualifications first because that is who this is for, and the two school
 * certificates are here because a lot of Indian application forms ask for them.
 */
export interface Degree {
  /** Stored and printed as written here. */
  value: string;
  group: string;
  match: RegExp;
}

export const DEGREE_OTHER = 'OTHER';

export const DEGREES: Degree[] = [
  { value: 'Class X (Secondary)', group: 'School', match: /\b(class\s*x|10th|secondary school|sslc|matriculation)\b/i },
  { value: 'Class XII (Senior Secondary)', group: 'School', match: /\b(class\s*xii|12th|senior secondary|intermediate|hsc|puc)\b/i },
  { value: 'Diploma', group: 'Diploma', match: /\bdiploma\b/i },
  { value: 'B.Tech', group: "Bachelor's", match: /\bb[.\s]*tech\b|bachelor.{0,4} of technology/i },
  { value: 'B.E.', group: "Bachelor's", match: /\bb[.\s]*e\b|bachelor.{0,4} of engineering/i },
  { value: 'B.Sc', group: "Bachelor's", match: /\bb[.\s]*sc\b|bachelor.{0,4} of science/i },
  { value: 'B.C.A', group: "Bachelor's", match: /\bbca\b|\bb[.\s]*c[.\s]*a\b/i },
  { value: 'B.Com', group: "Bachelor's", match: /\bb[.\s]*com\b|bachelor.{0,4} of commerce/i },
  { value: 'B.B.A', group: "Bachelor's", match: /\bbba\b/i },
  { value: 'B.A', group: "Bachelor's", match: /\bb[.\s]*a\b|bachelor.{0,4} of arts/i },
  { value: 'B.Arch', group: "Bachelor's", match: /\bb[.\s]*arch\b/i },
  { value: 'B.Des', group: "Bachelor's", match: /\bb[.\s]*des\b/i },
  { value: 'B.Pharm', group: "Bachelor's", match: /\bb[.\s]*pharm\b/i },
  { value: 'LL.B', group: "Bachelor's", match: /\bll[.\s]*b\b/i },
  { value: 'MBBS', group: "Bachelor's", match: /\bmbbs\b/i },
  { value: 'B.Ed', group: "Bachelor's", match: /\bb[.\s]*ed\b/i },
  { value: 'M.Tech', group: "Master's", match: /\bm[.\s]*tech\b|master.{0,4} of technology/i },
  { value: 'M.E.', group: "Master's", match: /\bm[.\s]*e\b|master.{0,4} of engineering/i },
  { value: 'M.Sc', group: "Master's", match: /\bm[.\s]*sc\b|master.{0,4} of science/i },
  { value: 'M.C.A', group: "Master's", match: /\bmca\b/i },
  { value: 'M.Com', group: "Master's", match: /\bm[.\s]*com\b/i },
  { value: 'M.B.A', group: "Master's", match: /\bmba\b|master.{0,4} of business/i },
  { value: 'M.A', group: "Master's", match: /\bm[.\s]*a\b|master.{0,4} of arts/i },
  { value: 'M.Arch', group: "Master's", match: /\bm[.\s]*arch\b/i },
  { value: 'M.Des', group: "Master's", match: /\bm[.\s]*des\b/i },
  { value: 'M.Pharm', group: "Master's", match: /\bm[.\s]*pharm\b/i },
  { value: 'LL.M', group: "Master's", match: /\bll[.\s]*m\b/i },
  { value: 'M.Ed', group: "Master's", match: /\bm[.\s]*ed\b/i },
  { value: 'MD', group: 'Doctorate', match: /\bm[.\s]*d\b/i },
  { value: 'Ph.D', group: 'Doctorate', match: /\bph[.\s]*d\b|doctorate/i },
  { value: 'Certification', group: 'Other', match: /\bcertificat|\bcourse\b|\bnanodegree\b/i },
];

/** The dropdown's groups, in the order they are shown. */
export const DEGREE_GROUPS = [...new Set(DEGREES.map((d) => d.group))];

/**
 * The parts of one education line, as the form holds them.
 *
 * `degreeChoice` is either a value from DEGREES or DEGREE_OTHER, and is never sent
 * anywhere: what gets saved is the degree's own name, or whatever was typed under
 * Other. Keeping the choice separate is what lets the box under Other be empty
 * without the dropdown jumping back to nothing.
 */
export interface EducationParts {
  degreeChoice: string;
  degreeOther: string;
  fieldOfStudy: string;
  score: string;
  scoreOutOf: string;
  fromYear: string;
  toYear: string;
}

/** An empty set of boxes, for a qualification being added by hand. */
export function emptyEducation(): EducationParts {
  return {
    degreeChoice: '',
    degreeOther: '',
    fieldOfStudy: '',
    score: '',
    scoreOutOf: '',
    fromYear: '',
    toYear: '',
  };
}

/** The degree as it will be stored: the chosen one, or whatever Other was given. */
export function degreeName(parts: EducationParts): string {
  return parts.degreeChoice === DEGREE_OTHER
    ? parts.degreeOther.trim()
    : parts.degreeChoice.trim();
}

/** How a score reads once it is printed. 100 means a percentage; see schema.prisma. */
export function scoreLabel(score: string, outOf: string): string {
  if (!score.trim() || !outOf.trim()) return '';
  return outOf.trim() === '100'
    ? `${score.trim()}%`
    : `CGPA ${score.trim()}/${outOf.trim()}`;
}

/**
 * The one line an education row will print as.
 *
 * Shown on the form as well as saved, because this is the only place the parts turn
 * back into a sentence and a person is entitled to see the sentence before agreeing
 * to it. Everything downstream - matching, tailoring, the pdf - reads this string
 * and not the parts.
 */
export function composeEducation(parts: EducationParts): string {
  const degree = degreeName(parts);
  const field = parts.fieldOfStudy.trim();
  const head = [degree, field && `in ${field}`].filter(Boolean).join(' ');
  const score = scoreLabel(parts.score, parts.scoreOutOf);
  // An em dash rather than a comma: "B.Tech in Computer Science, CGPA 8.6/10" reads
  // as a list of two things, and the score is a note about the first.
  return [head, score].filter(Boolean).join(' — ');
}

/** "2019 – 2023", or one year, or nothing. The same column every other date uses. */
export function composeYears(parts: EducationParts): string | null {
  const from = parts.fromYear.trim();
  const to = parts.toYear.trim();
  if (from && to) return `${from} – ${to}`;
  return from || to || null;
}

const YEAR = /(?:19|20)\d{2}/;

/**
 * Reads the years back out of a stored date range.
 *
 * There are no year columns - the dates live in `dateRange` with every other date in
 * the table - so re-opening a saved education row has to take them apart again.
 * Splitting on the dash first means "Aug 2019 - May 2023" gives 2019 and 2023 rather
 * than the first two numbers it happens to find, and a side reading "Present" is kept
 * as the word rather than dropped, since that is what somebody still studying wrote.
 */
export function yearsFrom(range: string | null | undefined): {
  fromYear: string;
  toYear: string;
} {
  const sides = (range ?? '')
    .split(/[–—]|\s-\s|\bto\b/i)
    .map((s) => s.trim())
    .filter(Boolean);
  const year = (side: string): string =>
    side.match(YEAR)?.[0] ??
    (/present|current|ongoing|expected/i.test(side) ? 'Present' : '');
  if (sides.length === 0) return { fromYear: '', toYear: '' };
  if (sides.length === 1) return { fromYear: year(sides[0]), toYear: '' };
  return { fromYear: year(sides[0]), toYear: year(sides[sides.length - 1]) };
}

/** A score written with its own scale in it: "8.6/10", "8.6 out of 10", "82%". */
const SCORE_WITH_SCALE =
  /(\d{1,3}(?:\.\d{1,2})?)\s*(?:\/|out of\s*)\s*(\d{1,3})|(\d{1,3}(?:\.\d{1,2})?)\s*%/i;

/**
 * Takes an education line the parser produced apart into the form's boxes.
 *
 * DELIBERATELY TIMID. A bare "8.6" sitting in a resume line is not read as a score,
 * because it could be out of ten, out of four, or a percentage typed without its
 * sign - and a CGPA prefilled wrongly is a false claim on a real application that a
 * person skimming a filled-in form will not catch. Only a figure that states its own
 * scale is taken.
 *
 * The same rule applies to the degree: recognised, or else the whole line is kept
 * verbatim under Other. Nothing is ever thrown away in the process, which is the
 * property that makes guessing safe here at all.
 */
export function splitEducation(
  text: string,
  dateRange: string | null | undefined,
): EducationParts {
  const line = text.trim();
  const years = yearsFrom(dateRange);

  const scored = line.match(SCORE_WITH_SCALE);
  const score = (scored?.[1] ?? scored?.[3] ?? '').trim();
  const scoreOutOf = score ? (scored?.[2] ?? '100').trim() : '';

  const degree = DEGREES.find((d) => d.match.test(line));
  if (!degree) {
    return {
      degreeChoice: DEGREE_OTHER,
      degreeOther: line,
      fieldOfStudy: '',
      score,
      scoreOutOf,
      ...years,
    };
  }

  // What is left once the degree and the score have been lifted out. Usually the
  // subject.
  const remainder = line
    .replace(degree.match, ' ')
    .replace(SCORE_WITH_SCALE, ' ')
    .replace(/\b(cgpa|gpa|percentage|marks|grade)\b/gi, ' ')
    .replace(/[,;|–—]+/g, ' ')
    .replace(/^\s*(in|of)\b/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Too long to be a subject means the line held something this did not understand -
  // an institution, an address, two qualifications on one line. Falling back to Other
  // with the wording untouched is what makes the guessing above safe: the composed
  // line is either built from boxes a person can see, or it is the original sentence.
  if (remainder.length > 60) {
    return {
      degreeChoice: DEGREE_OTHER,
      degreeOther: line,
      fieldOfStudy: '',
      score,
      scoreOutOf,
      ...years,
    };
  }

  return {
    degreeChoice: degree.value,
    degreeOther: '',
    fieldOfStudy: remainder,
    score,
    scoreOutOf,
    ...years,
  };
}

/** Which kinds have an employer and a date range worth showing a field for.
 *  A skill has neither, and empty inputs beside forty skills is just noise. */
export const KIND_HAS_META: Record<AtomKind, boolean> = {
  ROLE: true,
  BULLET: true,
  SKILL: false,
  EDU: true,
};

/**
 * A label the API will accept, guessed from the uploaded filename.
 *
 * The server's rule is letters, numbers, spaces, hyphens and underscores, so a
 * real filename ("Astha_Niharika_Resume (2).pdf") has to be cleaned rather than
 * offered as-is - a prefilled value that fails validation on submit reads as the
 * form being broken.
 */
export function labelFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '');
  const cleaned = base
    .replace(/[^A-Za-z0-9 _-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[^A-Za-z0-9]+/, '')
    .trim()
    .slice(0, 60)
    .trim();
  return cleaned || 'primary';
}
