/**
 * Turning atoms plus a tailoring decision into the shape of a resume.
 *
 * Pure and separate from the docx writer on purpose: this is where every decision
 * about WHAT appears and IN WHAT ORDER lives, and those are the decisions worth
 * testing. The writer that follows it only turns this structure into XML.
 *
 * It builds the base resume and the tailored resume with the same function. The
 * fallback path in PLAN phase 5 - "any violation, discard the variant and fall back
 * to the base resume" - is `build(atoms, contact, null)`, so the fallback is not a
 * second renderer that could drift from the first. It is the same renderer with the
 * tailoring argument omitted.
 *
 * TWO THINGS THE MODEL'S ORDERING DOES NOT GET TO DO, both structural:
 *
 *   1. It cannot move a bullet out from under its role. `selectedAtomIds` arrives
 *      "most relevant first", which is useful information and is NOT a resume
 *      ordering - a bullet printed away from the job it happened at is a
 *      misattribution, which is the thing this whole phase exists to prevent. So
 *      relevance orders bullets WITHIN a role block and nothing else.
 *   2. It cannot reorder the roles. Those stay in the profile's own ordinal order,
 *      which is the reverse-chronological order the candidate wrote, because a
 *      resume whose jobs are out of date order reads as an error to a human and
 *      parses as one to an ATS.
 *
 * Employers, dates and role titles are read from ProfileAtom here and never from the
 * model's output. That is what makes "employer names and date ranges byte-identical
 * to source" true by construction rather than by inspection - there is no code path
 * through which a model-authored employer could reach the page.
 */
import { AtomKind } from '@prisma/client';
import type { TailorOutput } from '../llm/tasks/tailor-resume.task';

export interface DocumentAtom {
  id: string;
  kind: AtomKind;
  text: string;
  employer: string | null;
  dateRange: string | null;
  ordinal: number;
}

export interface ResumeContact {
  fullName: string;
  email: string;
  phone: string | null;
  location: string | null;
  linkedIn: string | null;
  github: string | null;
  portfolio: string | null;
}

export interface ResumeBullet {
  atomId: string;
  text: string;
  /** True when this text came from the model rather than from the atom verbatim. */
  rewritten: boolean;
}

/**
 * An education entry.
 *
 * Carries the institution and dates rather than reusing ResumeBullet, because an EDU
 * atom's `text` is only the degree - "B.Tech, Computer Science" - and the institution
 * lives in `employer`. Rendering it as a plain bullet dropped both, which produced a
 * resume with a degree and no university on it.
 */
export interface ResumeEducation extends ResumeBullet {
  institution: string | null;
  dateRange: string | null;
}

export interface ResumeRoleBlock {
  /** The ROLE atom's own id, or null for a block holding orphan bullets. */
  atomId: string | null;
  title: string;
  employer: string | null;
  dateRange: string | null;
  bullets: ResumeBullet[];
}

export interface ResumeDocument {
  contact: ResumeContact;
  headline: string | null;
  /** SKILL atom lines, in profile order. */
  skills: ResumeBullet[];
  roles: ResumeRoleBlock[];
  education: ResumeEducation[];
  /** False when this is the base resume - the fallback after a guard failure. */
  tailored: boolean;
}

/**
 * Builds the document.
 *
 * `tailoring` null means the base resume: every atom, no rewrites, the profile's own
 * headline. Passing a tailoring output filters to the selected atoms and substitutes
 * the rewritten text.
 *
 * ONLY EVER CALL THIS WITH A TAILORING THE GUARD PASSED. Nothing here re-checks
 * provenance - it is a renderer, and a renderer that also validated would be a second
 * place for the rules to live.
 */
export function buildResume(
  atoms: readonly DocumentAtom[],
  contact: ResumeContact,
  profileHeadline: string | null,
  tailoring: TailorOutput | null,
): ResumeDocument {
  const ordered = [...atoms].sort((a, b) => a.ordinal - b.ordinal);

  // Relevance rank per atom, used only within a role block. An atom the model did
  // not rank sorts last rather than first, so an unranked atom cannot displace a
  // ranked one.
  const rank = new Map<string, number>();
  tailoring?.selectedAtomIds.forEach((id, at) => {
    if (!rank.has(id)) rank.set(id, at);
  });

  const rewrites = new Map(
    (tailoring?.rewrites ?? []).map((r) => [r.atomId, r.text]),
  );

  const included = tailoring ? new Set(tailoring.selectedAtomIds) : null;
  const keep = (atom: DocumentAtom): boolean =>
    included === null || included.has(atom.id);

  const bulletOf = (atom: DocumentAtom): ResumeBullet => {
    const rewritten = rewrites.get(atom.id);
    return {
      atomId: atom.id,
      text: rewritten ?? atom.text,
      rewritten: rewritten !== undefined,
    };
  };

  const skills: ResumeBullet[] = [];
  const education: ResumeEducation[] = [];
  const roles: ResumeRoleBlock[] = [];

  // The open role block. A ROLE atom opens one; every BULLET after it belongs to it,
  // which is exactly how the parser assigned employers in the first place.
  let open: ResumeRoleBlock | null = null;

  for (const atom of ordered) {
    switch (atom.kind) {
      case AtomKind.SKILL:
        if (keep(atom)) skills.push(bulletOf(atom));
        break;

      case AtomKind.EDU:
        if (keep(atom)) {
          education.push({
            ...bulletOf(atom),
            institution: atom.employer,
            dateRange: atom.dateRange,
          });
        }
        break;

      case AtomKind.ROLE:
        // The block is created even when the ROLE atom itself was not selected, so
        // long as a bullet under it is - dropping the heading would leave bullets
        // with no employer on the page. It is discarded at the end if it stays
        // empty. A ROLE atom's own text is a job title and is never rewritten
        // into the body, so `keep` does not gate the block's existence.
        open = {
          atomId: atom.id,
          title: rewrites.get(atom.id) ?? atom.text,
          employer: atom.employer,
          dateRange: atom.dateRange,
          bullets: [],
        };
        roles.push(open);
        break;

      case AtomKind.BULLET: {
        if (!keep(atom)) break;
        // An orphan bullet: the 'other' sections (CERTIFICATIONS, LEADERSHIP) emit
        // standalone bullets with no ROLE above them. They get a block of their own
        // rather than being attached to whatever role happened to be last, which
        // would attribute a certification to an employer.
        if (!open || open.employer !== atom.employer) {
          open = {
            atomId: null,
            title: '',
            employer: atom.employer,
            dateRange: atom.dateRange,
            bullets: [],
          };
          roles.push(open);
        }
        open.bullets.push(bulletOf(atom));
        break;
      }
    }
  }

  const RANK_LAST = Number.MAX_SAFE_INTEGER;
  for (const block of roles) {
    // Stable within equal ranks, which matters for the base resume where every rank
    // is RANK_LAST and the profile's own bullet order must survive untouched.
    block.bullets.sort(
      (a, b) =>
        (rank.get(a.atomId) ?? RANK_LAST) - (rank.get(b.atomId) ?? RANK_LAST),
    );
  }

  return {
    contact,
    headline: tailoring?.headline ?? profileHeadline,
    skills,
    education,
    roles: roles.filter(
      // A role block with no bullets left is dropped - EXCEPT when the model
      // explicitly selected the ROLE atom, which is how a job with no bullets worth
      // printing still appears on the page as employment history rather than
      // becoming a gap in the candidate's timeline.
      (block) =>
        block.bullets.length > 0 ||
        (block.atomId !== null &&
          (included === null || included.has(block.atomId))),
    ),
    tailored: tailoring !== null,
  };
}

/**
 * The contact block, from the profile row.
 *
 * Here rather than in one service, because three callers now need it - the pipeline's
 * tailoring run, the on-demand one and the editor's preview - and a second copy is a
 * resume that silently loses its GitHub link on one of the three paths. Structural
 * typing means it takes any row selected with these columns.
 */
export function contactOf(profile: ResumeContact): ResumeContact {
  return {
    fullName: profile.fullName,
    email: profile.email,
    phone: profile.phone,
    location: profile.location,
    linkedIn: profile.linkedIn,
    github: profile.github,
    portfolio: profile.portfolio,
  };
}

/**
 * The filename PLAN specifies: Astha_Niharika_<Company>_<Role>.
 *
 * Returned without an extension, because the docx and the pdf are the same name.
 * Sanitised hard: this string reaches the filesystem, and a role title containing a
 * slash - "Backend / Platform Engineer", which is a common posting title - would
 * otherwise be a path separator.
 */
export function resumeFilename(
  fullName: string,
  company: string,
  role: string,
): string {
  const part = (value: string): string =>
    value
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_-]+/g, '_')
      .slice(0, 60)
      .replace(/^_+|_+$/g, '');

  return [part(fullName), part(company), part(role)]
    .filter((piece) => piece.length > 0)
    .join('_');
}
