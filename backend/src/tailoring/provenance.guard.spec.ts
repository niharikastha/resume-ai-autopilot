/**
 * The guard's tests, which PLAN.txt names as verification item 1 - the first tests
 * written in the project for a reason. Every other component fails loudly: a broken
 * connector returns zero postings, a broken matcher returns an empty shortlist. A
 * broken guard returns `passed: true` and the system carries on sending out resumes
 * that overstate, which is the one failure mode of this project that damages the
 * person using it.
 *
 * So these tests are written as fabrications rather than as unit coverage. Each one
 * is a specific lie a model plausibly tells, and the assertion is that this lie is
 * caught. The two named in the plan - 65% becoming 85%, and a silently added Kafka -
 * are the first two.
 */
import {
  checkProvenance,
  summarize,
  type GuardAtom,
  type GuardInput,
} from './provenance.guard';
import type { TailorOutput } from '../llm/tasks/tailor-resume.task';

/**
 * A small profile shaped like a real one: two employers, one atom with a metric, one
 * with none, one skills atom.
 *
 * Two employers is the minimum that makes the cross-attribution rule testable at all
 * - with one employer there is nothing to move a bullet to.
 */
const ATOMS: GuardAtom[] = [
  {
    id: 'atom-1',
    text: 'Improved document ingestion throughput by 65% by moving parsing onto worker threads.',
    tech: ['Node.js', 'Worker Threads'],
    metrics: ['65%'],
    employer: 'Merqube',
    dateRange: 'Jan 2024 - Present',
  },
  {
    id: 'atom-2',
    text: 'Built the HL7/FHIR ingestion pipeline serving 10,000+ records a day.',
    tech: ['Node.js', 'PostgreSQL', 'HL7/FHIR'],
    metrics: ['10,000+'],
    employer: 'Hyally',
    dateRange: 'Jun 2023 - Dec 2023',
  },
  {
    id: 'atom-3',
    text: 'Owned the deployment pipeline and on-call rotation.',
    tech: ['Docker'],
    metrics: [],
    employer: 'Hyally',
    dateRange: 'Jun 2023 - Dec 2023',
  },
];

const ALLOWED_TECH = [
  'Node.js',
  'PostgreSQL',
  'HL7/FHIR',
  'Worker Threads',
  'Docker',
  'TypeScript',
];

function output(overrides: Partial<TailorOutput> = {}): TailorOutput {
  return {
    selectedAtomIds: ['atom-1', 'atom-2', 'atom-3'],
    rewrites: [],
    headline: 'Backend engineer, document pipelines',
    coverLetter: '',
    ...overrides,
  };
}

function check(
  overrides: Partial<TailorOutput> = {},
  input: Partial<GuardInput> = {},
) {
  return checkProvenance({
    atoms: ATOMS,
    allowedTech: ALLOWED_TECH,
    output: output(overrides),
    ...input,
  });
}

/** The kinds present, so a test can assert on the set without indexing an array. */
function kinds(report: ReturnType<typeof check>): string[] {
  return report.violations.map((v) => v.kind);
}

describe('the two fabrications the plan names', () => {
  it('blocks 65% becoming 85%', () => {
    const report = check({
      rewrites: [
        {
          atomId: 'atom-1',
          text: 'Improved ingestion throughput by 85% using worker threads.',
        },
      ],
    });

    expect(report.passed).toBe(false);
    expect(kinds(report)).toEqual(['invented-number']);
    expect(report.violations[0].found).toBe('85%');
    expect(report.violations[0].atomId).toBe('atom-1');
    // The available figure is named, because the person reading the digest needs to
    // know whether the model inflated a number or the atom is simply missing one.
    expect(report.violations[0].detail).toContain('65%');
  });

  it('blocks a silently added Kafka', () => {
    const report = check({
      rewrites: [
        {
          atomId: 'atom-2',
          text: 'Built the HL7/FHIR ingestion pipeline on Kafka.',
        },
      ],
    });

    expect(report.passed).toBe(false);
    expect(kinds(report)).toEqual(['invented-tech']);
    expect(report.violations[0].found).toBe('Kafka');
  });
});

describe('the honest rewrite', () => {
  it('passes when nothing is rewritten at all', () => {
    const report = check();
    expect(report.passed).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it('passes a rewrite that keeps the figure and the tech', () => {
    const report = check({
      rewrites: [
        {
          atomId: 'atom-1',
          text: 'Moved parsing onto Worker Threads in Node.js, raising ingestion throughput 65%.',
        },
      ],
    });
    expect(report.passed).toBe(true);
  });

  it('passes a rewrite that DROPS the figure', () => {
    // Explicitly allowed by rule 2: dropping a number understates, and understating
    // is never the failure this guard exists to prevent.
    const report = check({
      rewrites: [
        {
          atomId: 'atom-1',
          text: 'Moved document parsing onto worker threads.',
        },
      ],
    });
    expect(report.passed).toBe(true);
  });

  it('passes "65 percent" written out, rather than discarding an honest rewrite', () => {
    // The false positive that normalizeUnits exists for. A resume writes 65%; prose
    // writes 65 percent. Refusing this would cost a variant for a spelling.
    const report = check({
      rewrites: [
        { atomId: 'atom-1', text: 'Raised throughput by 65 percent.' },
      ],
    });
    expect(report.passed).toBe(true);
  });

  it('passes a rewrite naming tech from a DIFFERENT atom', () => {
    // Deliberate: tech is checked against the whole allowed union, because a tag
    // list reflects the sentence that happened to be written, not the work done.
    const report = check({
      rewrites: [
        {
          atomId: 'atom-3',
          text: 'Owned the Docker deployment pipeline, including the PostgreSQL migrations.',
        },
      ],
    });
    expect(report.passed).toBe(true);
  });

  it('accepts an allowedTech entry written non-canonically', () => {
    // SkillsReserve is typed by a human, so "nodejs" and "node js" arrive. If the
    // set were compared raw, an enabled reserve skill would still be rejected.
    const report = check(
      {
        rewrites: [{ atomId: 'atom-1', text: 'Wrote the parser in Node.js.' }],
      },
      { allowedTech: ['nodejs', 'worker_threads'] },
    );
    expect(report.passed).toBe(true);
  });
});

describe('the number rule', () => {
  it('refuses a number the atom has no metric for at all', () => {
    // atom-3 with its dates stripped, so there is genuinely nothing to compare
    // against - that is the branch of the message this test is about. With the
    // dateRange left on, the years in it are legitimately available (see the
    // year tests below) and the message says so instead.
    const report = check(
      {
        rewrites: [
          {
            atomId: 'atom-3',
            text: 'Owned the deployment pipeline for 12 services.',
          },
        ],
      },
      { atoms: [ATOMS[0], ATOMS[1], { ...ATOMS[2], dateRange: null }] },
    );
    expect(kinds(report)).toEqual(['invented-number']);
    expect(report.violations[0].detail).toContain('no metrics at all');
  });

  it('still refuses an invented number when only the dates are available', () => {
    const report = check({
      rewrites: [
        {
          atomId: 'atom-3',
          text: 'Owned the deployment pipeline for 12 services.',
        },
      ],
    });
    expect(kinds(report)).toEqual(['invented-number']);
    expect(report.violations[0].found).toBe('12');
    // The message lists what IS available, which is the date range's year and
    // nothing else - a headcount is not licensed by a date.
    expect(report.violations[0].detail).toContain('2023');
  });

  it('refuses a changed unit: 40% does not license 40x', () => {
    const report = check(
      { rewrites: [{ atomId: 'atom-1', text: 'Made ingestion 40x faster.' }] },
      {
        atoms: [
          { ...ATOMS[0], metrics: ['40%'], text: 'Improved ingestion by 40%.' },
          ATOMS[1],
          ATOMS[2],
        ],
      },
    );
    expect(kinds(report)).toEqual(['invented-number']);
    expect(report.violations[0].found).toBe('40x');
  });

  it('allows dropping the + from "10,000+", which understates', () => {
    const report = check({
      rewrites: [
        {
          atomId: 'atom-2',
          text: 'Built a pipeline serving 10,000 records a day.',
        },
      ],
    });
    expect(report.passed).toBe(true);
  });

  it('refuses ADDING a + that the atom does not claim', () => {
    const report = check(
      {
        rewrites: [{ atomId: 'atom-2', text: 'Served 10,000+ records a day.' }],
      },
      {
        atoms: [ATOMS[0], { ...ATOMS[1], metrics: ['10,000'] }, ATOMS[2]],
      },
    );
    expect(kinds(report)).toEqual(['invented-number']);
  });

  it('does not treat a version or a product number as a metric', () => {
    // HL7 and S3 are why numbersIn requires no letter touching the digits. If they
    // registered as numbers, this honest rewrite would be rejected.
    const report = check({
      rewrites: [
        {
          atomId: 'atom-2',
          text: 'Built the HL7/FHIR ingestion pipeline on Node.js.',
        },
      ],
    });
    expect(report.passed).toBe(true);
  });

  it('reports every invented number, not just the first', () => {
    const report = check({
      rewrites: [
        { atomId: 'atom-1', text: 'Improved throughput 85% across 4 regions.' },
      ],
    });
    expect(kinds(report)).toEqual(['invented-number', 'invented-number']);
    expect(report.violations.map((v) => v.found)).toEqual(['85%', '4']);
  });
});

/**
 * Dates, which are the one place the number rule was measurably too strict.
 *
 * `tailorResumeTask.prefix` prints `dates: Jun 2023 - Dec 2023` on every atom, so a
 * cover letter that said "since 2023" was rejected as an invented figure - the guard
 * throwing away a whole Opus call over a number the prompt itself supplied. These
 * tests pin both halves: the year is allowed, and allowing it did not open a door.
 */
describe('dates as figures', () => {
  it("allows a rewrite restating the year from the atom's own date range", () => {
    const report = check({
      rewrites: [
        {
          atomId: 'atom-3',
          text: 'Owned the deployment pipeline and on-call rotation from 2023.',
        },
      ],
    });
    expect(report.passed).toBe(true);
  });

  it('allows a cover letter citing a year - the measured false positive', () => {
    const report = check({
      coverLetter:
        'I have been building document pipelines at Merqube since 2024, and before ' +
        'that spent 2023 on healthcare ingestion.',
    });
    expect(report.passed).toBe(true);
  });

  it('refuses a year no atom worked in', () => {
    const report = check({
      coverLetter: 'I have been building document pipelines since 2019.',
    });
    expect(kinds(report)).toEqual(['invented-number']);
    expect(report.violations[0].found).toBe('2019');
  });

  it('does not let a year license the same value with a unit', () => {
    // The whole point of keeping yearsIn to bare values: 2024 as a date must not
    // become 2024% of anything, which supportsNumber only refuses if the unit is
    // still compared.
    const report = check({
      rewrites: [{ atomId: 'atom-1', text: 'Cut ingestion latency by 2024%.' }],
    });
    expect(kinds(report)).toEqual(['invented-number']);
    expect(report.violations[0].found).toBe('2024%');
  });

  it('does not license a non-year number written inside a date range', () => {
    // "03/2024" contains a 3. A date range is allowed to license WHEN, not how
    // many, so the month must not quietly become a headcount.
    const report = check(
      {
        selectedAtomIds: ['atom-1'],
        rewrites: [
          { atomId: 'atom-1', text: 'Led a team of 3 on the parser.' },
        ],
      },
      { atoms: [{ ...ATOMS[0], metrics: [], dateRange: '03/2024 - Present' }] },
    );
    expect(kinds(report)).toEqual(['invented-number']);
    expect(report.violations[0].found).toBe('3');
  });

  it('ignores a date range on an atom this resume did not select', () => {
    // The cover letter is scoped to the selection, and a year is no different: a
    // date from work the reader cannot see is not evidence for anything.
    const report = check({
      selectedAtomIds: ['atom-1'],
      coverLetter: 'I worked on healthcare ingestion through 2023.',
    });
    expect(kinds(report)).toEqual(['invented-number']);
    expect(report.violations[0].found).toBe('2023');
  });
});

describe('citation integrity', () => {
  it('refuses a rewrite citing an atom that does not exist', () => {
    const report = check({
      rewrites: [{ atomId: 'atom-999', text: 'Did something impressive.' }],
    });
    expect(kinds(report)).toEqual(['unknown-atom']);
    expect(report.violations[0].found).toBe('atom-999');
  });

  it('refuses a SELECTION of an atom that does not exist', () => {
    const report = check({ selectedAtomIds: ['atom-1', 'atom-nope'] });
    expect(kinds(report)).toEqual(['unknown-atom']);
    expect(report.violations[0].site).toBe('selection');
  });

  it('refuses a rewrite for an atom that was not selected', () => {
    const report = check({
      selectedAtomIds: ['atom-1'],
      rewrites: [{ atomId: 'atom-3', text: 'Owned the deployment pipeline.' }],
    });
    expect(kinds(report)).toEqual(['rewrite-not-selected']);
  });

  it('refuses two rewrites of the same atom', () => {
    const report = check({
      rewrites: [
        { atomId: 'atom-3', text: 'Owned the deployment pipeline.' },
        { atomId: 'atom-3', text: 'Ran the on-call rotation.' },
      ],
    });
    expect(kinds(report)).toEqual(['duplicate-rewrite']);
  });

  it('refuses an empty selection', () => {
    // The output schema already requires min(1), and this is checked anyway: the
    // guard is the last line and must not assume an earlier layer ran.
    const report = check({ selectedAtomIds: [] });
    expect(kinds(report)).toEqual(['empty-selection']);
  });

  it('does not count a repeated selection as a violation', () => {
    const report = check({ selectedAtomIds: ['atom-1', 'atom-1', 'atom-2'] });
    expect(report.passed).toBe(true);
    // Deduped, because the renderer must not print the bullet twice.
    expect(report.counts.selected).toBe(2);
  });
});

describe('employer attribution', () => {
  it('refuses a bullet that reattributes work to another employer', () => {
    const report = check({
      rewrites: [
        {
          atomId: 'atom-1',
          text: 'At Hyally, improved document ingestion throughput by 65%.',
        },
      ],
    });
    expect(kinds(report)).toEqual(['moved-employer']);
    expect(report.violations[0].found).toBe('Hyally');
    expect(report.violations[0].detail).toContain('Merqube');
  });

  it('allows a bullet naming its OWN employer', () => {
    const report = check({
      rewrites: [
        {
          atomId: 'atom-1',
          text: 'At Merqube, improved document ingestion throughput by 65%.',
        },
      ],
    });
    expect(report.passed).toBe(true);
  });
});

describe('the headline and the cover letter', () => {
  it('checks the headline for invented tech', () => {
    const report = check({
      headline: 'Backend engineer, Kafka and Kubernetes',
    });
    expect(report.passed).toBe(false);
    expect(report.violations.every((v) => v.site === 'headline')).toBe(true);
    // Dictionary order, not text order - techIn is deliberately stable so that two
    // atoms naming the same pair of tools produce identical arrays.
    expect(report.violations.map((v) => v.found)).toEqual([
      'Kafka',
      'Kubernetes',
    ]);
  });

  it('checks the cover letter for invented numbers', () => {
    const report = check({
      coverLetter: 'I have seven years of experience and cut costs by 30%.',
    });
    expect(kinds(report)).toEqual(['invented-number']);
    expect(report.violations[0].site).toBe('coverLetter');
    expect(report.violations[0].found).toBe('30%');
  });

  it('scopes cover-letter numbers to the SELECTED atoms only', () => {
    // atom-2's 10,000+ is real, but this resume left atom-2 out - so a cover letter
    // leaning on that figure is describing work the reader cannot see.
    const report = check({
      selectedAtomIds: ['atom-1'],
      coverLetter: 'I have built pipelines serving 10,000+ records a day.',
    });
    expect(kinds(report)).toEqual(['invented-number']);
  });

  it('allows a cover letter reusing a figure from a selected atom', () => {
    const report = check({
      selectedAtomIds: ['atom-1'],
      coverLetter: 'The throughput work I am proudest of moved the needle 65%.',
    });
    expect(report.passed).toBe(true);
  });

  it('does not check an empty cover letter', () => {
    const report = check({ coverLetter: '' });
    expect(report.passed).toBe(true);
  });
});

describe('the report itself', () => {
  it('counts what it looked at, so an empty report is distinguishable from a skipped one', () => {
    const report = check({
      rewrites: [
        {
          atomId: 'atom-1',
          text: 'Raised ingestion throughput 65% on Node.js.',
        },
        { atomId: 'atom-2', text: 'Served 10,000+ records a day.' },
      ],
    });

    expect(report.passed).toBe(true);
    expect(report.counts.selected).toBe(3);
    expect(report.counts.rewrites).toBe(2);
    expect(report.counts.numbersChecked).toBe(2);
    expect(report.counts.techTokensChecked).toBeGreaterThan(0);
  });

  it('is retained on the pass path - the rate is what matters, not the failures', () => {
    // Not an assertion about behaviour so much as about shape: a passing report has
    // to be a real object with counts, because a violation RATE cannot be computed
    // from failures alone.
    const report = check();
    expect(report).toMatchObject({ passed: true, violations: [] });
    expect(report.counts).toBeDefined();
  });

  it('summarizes a pass with the counts', () => {
    expect(summarize(check())).toMatch(/^provenance OK \(3 atoms, 0 rewrites/);
  });

  it('groups the summary by kind rather than listing every violation', () => {
    const report = check({
      rewrites: [
        { atomId: 'atom-1', text: 'Improved throughput 85% across 4 regions.' },
      ],
      headline: 'Kafka engineer',
    });
    const line = summarize(report);
    expect(line).toContain('provenance FAILED');
    expect(line).toContain('invented-number x2');
    expect(line).toContain('invented-tech x1');
  });
});

describe('failing closed', () => {
  it('fails the WHOLE variant for one bad number, not just the bad bullet', () => {
    // The design decision, asserted so it cannot be softened into
    // drop-the-bad-bullet without a test turning red. A resume with one silently
    // removed bullet looks fine to everyone who reads it.
    const report = check({
      rewrites: [
        { atomId: 'atom-1', text: 'Raised throughput 65%.' },
        { atomId: 'atom-2', text: 'Served 999,999 records a day.' },
      ],
    });
    expect(report.passed).toBe(false);
  });

  it('never throws on a hostile output', () => {
    expect(() =>
      checkProvenance({
        atoms: [],
        allowedTech: [],
        output: {
          selectedAtomIds: [],
          rewrites: [{ atomId: '', text: '0' }],
          headline: '',
          coverLetter: '',
        },
      }),
    ).not.toThrow();
  });
});
