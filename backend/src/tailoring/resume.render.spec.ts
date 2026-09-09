/**
 * Where each line of the resume lands on the page.
 *
 * THE FAILURE THIS FILE EXISTS FOR, measured on a real rendered pdf: two volunteer
 * positions - "Web Developer Lead - IT Dept, MLSA" and "Member - Girlscript
 * Sambalpur" - printed as two more bullets under the Walking Pal heading, because a
 * standalone bullet has no heading of its own and a page has no way to show that the
 * heading above it stopped applying. Nothing was misworded; the layout made the claim.
 *
 * Tested through `layout` rather than through the docx, because a Paragraph is an XML
 * builder and cannot be read back. `layout` returns the same decisions as plain data.
 * What the paragraphs then look like - fonts, borders, keep-with-next - is not a
 * decision and is not tested here.
 */
import type {
  ResumeContact,
  ResumeDocument,
  ResumeRoleBlock,
} from './resume.document';
import { layout, type ResumeBlock } from './resume.render';

const CONTACT: ResumeContact = {
  fullName: 'Astha Niharika',
  email: 'astha@example.com',
  phone: '+91 90000 00000',
  location: 'Bengaluru, India',
  linkedIn: null,
  github: null,
  portfolio: null,
};

function job(employer: string, ...bullets: string[]): ResumeRoleBlock {
  return {
    atomId: `role-${employer}`,
    title: 'Engineer',
    employer,
    dateRange: 'Jan 2024 - Present',
    bullets: bullets.map((text, i) => ({
      atomId: `${employer}-${i}`,
      text,
      rewritten: false,
    })),
  };
}

/** What the document model produces for a CERTIFICATIONS or LEADERSHIP line. */
function orphan(...bullets: string[]): ResumeRoleBlock {
  return {
    atomId: null,
    title: '',
    employer: null,
    dateRange: null,
    bullets: bullets.map((text, i) => ({
      atomId: `loose-${i}`,
      text,
      rewritten: false,
    })),
  };
}

function resume(over: Partial<ResumeDocument> = {}): ResumeDocument {
  return {
    contact: CONTACT,
    headline: 'Backend engineer',
    tailored: false,
    skills: [],
    education: [],
    roles: [],
    ...over,
  };
}

/** The sections, in the order they print. */
function sections(blocks: ResumeBlock[]): string[] {
  return blocks
    .filter((block) => block.kind === 'section')
    .map((block) => block.text);
}

/** Which section a line ended up under. Null if it printed above every heading. */
function sectionOf(blocks: ResumeBlock[], text: string): string | null {
  let current: string | null = null;
  for (const block of blocks) {
    if (block.kind === 'section') current = block.text;
    if ('text' in block && block.text === text && block.kind !== 'section') {
      return current;
    }
  }
  throw new Error(`no line reading ${text}`);
}

describe('a standalone bullet with no job above it', () => {
  const doc = resume({
    roles: [
      job('Hyscaler', 'Built the ingestion pipeline.'),
      orphan(
        'Web Developer Lead - IT Dept, MLSA',
        'Member - Girlscript Sambalpur',
      ),
    ],
    education: [
      {
        atomId: 'edu-1',
        text: 'B.Tech, Computer Science',
        rewritten: false,
        institution: 'NIT',
        dateRange: '2019 - 2023',
      },
    ],
  });
  const blocks = layout(doc);

  it('does not print under the last job', () => {
    // The bug, stated as an assertion: under Experience, these two lines read as
    // things done at Hyscaler.
    expect(sectionOf(blocks, 'Web Developer Lead - IT Dept, MLSA')).toBe(
      'Certifications & Activities',
    );
    expect(sectionOf(blocks, 'Member - Girlscript Sambalpur')).toBe(
      'Certifications & Activities',
    );
  });

  it('leaves the job it does not belong to alone', () => {
    expect(sectionOf(blocks, 'Built the ingestion pipeline.')).toBe(
      'Experience',
    );
  });

  it('comes after education, where a reader looks for it', () => {
    expect(sections(blocks)).toEqual([
      'Experience',
      'Education',
      'Certifications & Activities',
    ]);
  });
});

describe('a resume that is nothing but standalone bullets', () => {
  // A parse that found no ROLE atoms at all. There is no job above these lines, so
  // there is nothing for them to be misread as - and heading them "certifications"
  // would be the renderer claiming something about lines it cannot see the source of.
  const blocks = layout(
    resume({ roles: [orphan('AWS Certified Solutions Architect')] }),
  );

  it('keeps them under Experience rather than inventing a section', () => {
    expect(sections(blocks)).toEqual(['Experience']);
    expect(sectionOf(blocks, 'AWS Certified Solutions Architect')).toBe(
      'Experience',
    );
  });
});

describe('an ordinary resume', () => {
  const blocks = layout(
    resume({
      skills: [
        {
          atomId: 's-1',
          text: 'Languages: TypeScript, Python',
          rewritten: false,
        },
      ],
      roles: [job('Merqube', 'Improved throughput by 65%.')],
      education: [
        {
          atomId: 'edu-1',
          text: 'B.Tech, Computer Science',
          rewritten: false,
          institution: 'NIT',
          dateRange: '2019 - 2023',
        },
      ],
    }),
  );

  it('prints skills, experience and education, and no empty extra section', () => {
    expect(sections(blocks)).toEqual(['Skills', 'Experience', 'Education']);
  });

  it('opens with the name, headline and contact line, above every heading', () => {
    expect(blocks.slice(0, 3).map((block) => block.kind)).toEqual([
      'name',
      'headline',
      'contact',
    ]);
    // The contact line is assembled, not a field: the separator is what makes it one
    // line rather than a table, which is the thing an ATS cannot read.
    expect(blocks[2]).toMatchObject({
      kind: 'contact',
      text: 'astha@example.com  |  +91 90000 00000  |  Bengaluru, India',
    });
  });

  it('keeps a degree and its university on one entry', () => {
    expect(blocks).toContainEqual({
      kind: 'entry',
      title: 'B.Tech, Computer Science',
      employer: 'NIT',
      dateRange: '2019 - 2023',
    });
  });

  it('writes a skills line as a line, not as a one-item bullet', () => {
    expect(blocks).toContainEqual({
      kind: 'line',
      text: 'Languages: TypeScript, Python',
    });
  });
});

describe('an empty resume', () => {
  it('is a name and a contact line, and no headings at all', () => {
    const blocks = layout(resume({ headline: null }));

    expect(sections(blocks)).toEqual([]);
    expect(blocks.map((block) => block.kind)).toEqual(['name', 'contact']);
  });
});
