/**
 * Tests for the document model.
 *
 * The assertions worth having here are about the two things the model's output is NOT
 * allowed to do - move a bullet away from its employer, and reorder the jobs - plus
 * the fallback, which has to produce a complete resume from the atoms alone because
 * it is what runs every time the guard rejects a variant.
 */
import { AtomKind } from '@prisma/client';
import {
  buildResume,
  resumeFilename,
  type DocumentAtom,
  type ResumeContact,
} from './resume.document';
import type { TailorOutput } from '../llm/tasks/tailor-resume.task';

const CONTACT: ResumeContact = {
  fullName: 'Astha Niharika',
  email: 'astha@example.com',
  phone: '+91 90000 00000',
  location: 'Bengaluru, India',
  linkedIn: 'linkedin.com/in/astha',
  github: null,
  portfolio: null,
};

function atom(
  id: string,
  kind: AtomKind,
  text: string,
  ordinal: number,
  employer: string | null = null,
  dateRange: string | null = null,
): DocumentAtom {
  return { id, kind, text, ordinal, employer, dateRange };
}

/** Two jobs, newest first, plus skills and education - a normal resume. */
const ATOMS: DocumentAtom[] = [
  atom('skill-1', AtomKind.SKILL, 'Languages: TypeScript, Python', 0),
  atom('role-1', AtomKind.ROLE, 'SDE-1', 1, 'Merqube', 'Jan 2024 - Present'),
  atom('b-1', AtomKind.BULLET, 'Improved ingestion throughput by 65%.', 2, 'Merqube', 'Jan 2024 - Present'),
  atom('b-2', AtomKind.BULLET, 'Owned the release pipeline.', 3, 'Merqube', 'Jan 2024 - Present'),
  atom('role-2', AtomKind.ROLE, 'Intern', 4, 'Hyally', 'Jun 2023 - Dec 2023'),
  atom('b-3', AtomKind.BULLET, 'Built the HL7/FHIR pipeline.', 5, 'Hyally', 'Jun 2023 - Dec 2023'),
  atom('edu-1', AtomKind.EDU, 'B.Tech, Computer Science', 6, 'NIT', '2019 - 2023'),
];

function tailoring(overrides: Partial<TailorOutput> = {}): TailorOutput {
  return {
    selectedAtomIds: ATOMS.map((a) => a.id),
    rewrites: [],
    headline: 'Backend engineer, data pipelines',
    coverLetter: '',
    ...overrides,
  };
}

describe('the base resume - the fallback path', () => {
  const doc = buildResume(ATOMS, CONTACT, 'Software Engineer', null);

  it('is marked as not tailored', () => {
    expect(doc.tailored).toBe(false);
  });

  it('includes every atom', () => {
    expect(doc.skills).toHaveLength(1);
    expect(doc.education).toHaveLength(1);
    expect(doc.roles).toHaveLength(2);
    expect(doc.roles.flatMap((r) => r.bullets)).toHaveLength(3);
  });

  it('uses the profile headline, since there is no model to supply one', () => {
    expect(doc.headline).toBe('Software Engineer');
  });

  it('carries the institution and dates onto an education entry', () => {
    // The degree text alone is "B.Tech, Computer Science" - without these the
    // resume shows a degree and no university.
    expect(doc.education[0]).toMatchObject({
      text: 'B.Tech, Computer Science',
      institution: 'NIT',
      dateRange: '2019 - 2023',
    });
  });

  it('rewrites nothing', () => {
    const all = doc.roles.flatMap((r) => r.bullets);
    expect(all.every((b) => !b.rewritten)).toBe(true);
    expect(all[0].text).toBe('Improved ingestion throughput by 65%.');
  });

  it('keeps the profile bullet order', () => {
    expect(doc.roles[0].bullets.map((b) => b.atomId)).toEqual(['b-1', 'b-2']);
  });

  it('does not depend on the atoms arriving sorted', () => {
    const shuffled = [ATOMS[5], ATOMS[0], ATOMS[3], ATOMS[1], ATOMS[6], ATOMS[2], ATOMS[4]];
    const fromShuffled = buildResume(shuffled, CONTACT, null, null);
    expect(fromShuffled.roles.map((r) => r.employer)).toEqual(['Merqube', 'Hyally']);
    expect(fromShuffled.roles[0].bullets.map((b) => b.atomId)).toEqual(['b-1', 'b-2']);
  });
});

describe('the tailored resume', () => {
  it('takes the headline from the model', () => {
    const doc = buildResume(ATOMS, CONTACT, 'Software Engineer', tailoring());
    expect(doc.headline).toBe('Backend engineer, data pipelines');
    expect(doc.tailored).toBe(true);
  });

  it('substitutes a rewritten bullet and flags it', () => {
    const doc = buildResume(
      ATOMS,
      CONTACT,
      null,
      tailoring({ rewrites: [{ atomId: 'b-1', text: 'Raised throughput 65%.' }] }),
    );
    const [first, second] = doc.roles[0].bullets;
    expect(first).toMatchObject({ text: 'Raised throughput 65%.', rewritten: true });
    expect(second.rewritten).toBe(false);
  });

  it('drops an atom that was not selected', () => {
    const doc = buildResume(
      ATOMS,
      CONTACT,
      null,
      tailoring({ selectedAtomIds: ['skill-1', 'role-1', 'b-1', 'edu-1'] }),
    );
    expect(doc.roles).toHaveLength(1);
    expect(doc.roles[0].bullets.map((b) => b.atomId)).toEqual(['b-1']);
  });
});

describe('what the model is not allowed to reorder', () => {
  it('orders bullets WITHIN a role by relevance', () => {
    const doc = buildResume(
      ATOMS,
      CONTACT,
      null,
      // b-2 ranked ahead of b-1.
      tailoring({ selectedAtomIds: ['b-2', 'b-1', 'role-1', 'role-2', 'b-3'] }),
    );
    expect(doc.roles[0].bullets.map((b) => b.atomId)).toEqual(['b-2', 'b-1']);
  });

  it('does NOT reorder the jobs, even when a later job is ranked first', () => {
    // The whole point. Hyally is ranked most relevant and still prints second,
    // because a resume with its jobs out of date order reads as an error.
    const doc = buildResume(
      ATOMS,
      CONTACT,
      null,
      tailoring({ selectedAtomIds: ['b-3', 'role-2', 'role-1', 'b-1', 'b-2'] }),
    );
    expect(doc.roles.map((r) => r.employer)).toEqual(['Merqube', 'Hyally']);
  });

  it('does NOT move a bullet to another employer', () => {
    // Even asked to, there is no mechanism: a bullet's block comes from its own
    // atom's employer, which the model never supplies.
    const doc = buildResume(ATOMS, CONTACT, null, tailoring());
    const hyally = doc.roles.find((r) => r.employer === 'Hyally');
    expect(hyally?.bullets.map((b) => b.atomId)).toEqual(['b-3']);
    expect(doc.roles[0].bullets.map((b) => b.atomId)).not.toContain('b-3');
  });

  it('reads employer, dates and title from the atom, never from the model', () => {
    const doc = buildResume(ATOMS, CONTACT, null, tailoring());
    expect(doc.roles[0]).toMatchObject({
      employer: 'Merqube',
      dateRange: 'Jan 2024 - Present',
      title: 'SDE-1',
    });
  });

  it('sorts an unranked bullet last rather than first', () => {
    const doc = buildResume(
      ATOMS,
      CONTACT,
      null,
      // Base resume semantics do not apply - this is a tailoring, and b-2 is
      // selected but absent from the front of the ranking.
      tailoring({ selectedAtomIds: ['role-1', 'b-2', 'b-1'] }),
    );
    expect(doc.roles[0].bullets.map((b) => b.atomId)).toEqual(['b-2', 'b-1']);
  });
});

describe('role blocks', () => {
  it('keeps a selected role that has no bullets left, so the timeline has no gap', () => {
    const doc = buildResume(
      ATOMS,
      CONTACT,
      null,
      tailoring({ selectedAtomIds: ['role-1', 'b-1', 'role-2'] }),
    );
    const hyally = doc.roles.find((r) => r.employer === 'Hyally');
    expect(hyally).toBeDefined();
    expect(hyally?.bullets).toEqual([]);
  });

  it('drops a role block that was neither selected nor has bullets', () => {
    const doc = buildResume(
      ATOMS,
      CONTACT,
      null,
      tailoring({ selectedAtomIds: ['role-1', 'b-1'] }),
    );
    expect(doc.roles.map((r) => r.employer)).toEqual(['Merqube']);
  });

  it('gives an orphan bullet its own block rather than attaching it to the last role', () => {
    // A CERTIFICATIONS line has no ROLE above it. Attaching it to whatever came
    // last would credit a certificate to an employer.
    const withOrphan = [
      ...ATOMS,
      atom('cert-1', AtomKind.BULLET, 'AWS Solutions Architect, 2025', 7, null),
    ];
    const doc = buildResume(withOrphan, CONTACT, null, null);
    const orphan = doc.roles[doc.roles.length - 1];
    expect(orphan.employer).toBeNull();
    expect(orphan.atomId).toBeNull();
    expect(orphan.bullets.map((b) => b.atomId)).toEqual(['cert-1']);
  });
});

describe('resumeFilename', () => {
  it('builds the name PLAN specifies', () => {
    expect(resumeFilename('Astha Niharika', 'Razorpay', 'Backend Engineer')).toBe(
      'Astha_Niharika_Razorpay_Backend_Engineer',
    );
  });

  it('strips a slash out of a role title', () => {
    // "Backend / Platform Engineer" is a real posting title, and a slash reaching
    // the filesystem is a path separator.
    expect(resumeFilename('A B', 'Acme', 'Backend / Platform Engineer')).toBe(
      'A_B_Acme_Backend_Platform_Engineer',
    );
  });

  it('strips punctuation a company name carries', () => {
    expect(resumeFilename('A B', 'Foo, Inc.', 'SDE II')).toBe('A_B_Foo_Inc_SDE_II');
  });

  it('does not leave a dangling separator when a part is empty', () => {
    expect(resumeFilename('A B', '???', 'SDE')).toBe('A_B_SDE');
  });

  it('caps each part so a long posting title cannot overflow a path', () => {
    const name = resumeFilename('A B', 'C', 'x'.repeat(200));
    expect(name.length).toBeLessThan(80);
  });
});
