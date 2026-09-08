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
  ROLE: 'One line per employer or project, with the dates.',
  BULLET:
    'These are what a tailored resume is allowed to draw from. Nothing outside this list ever appears on an application.',
  SKILL: 'Read from your resume. Fix a misspelling here and matching follows.',
  EDU: 'Degrees, institutions, certifications.',
};

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
