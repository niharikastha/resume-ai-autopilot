/**
 * Does the answers screen offer back the right questions, and only those?
 *
 *   npx ts-node -r tsconfig-paths/register scripts/answers-library.check.ts
 *
 * WHY THIS EXISTS. The complaint was that forms arrive with boxes empty and the reason
 * given is "no stored answer matches" - a sentence that reads like a missing setting and
 * tells the candidate nothing about which setting. The fix is for the screen to offer the
 * questions the forms actually asked, which means reading them back out of the
 * `screeningAnswers` audit JSON. That read has to EXCLUDE three kinds of blank that are
 * not gaps - a demographic box, a declaration to tick, and a question one of the fixed
 * columns above already owns - and it has to work on records written before `fieldClass`
 * was stored on a field, which is every record that exists today.
 *
 * FIXTURE 1 IS REAL. It is the `screeningAnswers` of the one genuine prefill this system
 * has run, copied out of Postgres unmodified, and it contains one of each thing that
 * must be excluded plus exactly one question worth asking. Getting that row right is the
 * whole feature; the synthetic fixtures after it are the cases a future edit could break.
 *
 * WHY A SCRIPT AND NOT A JEST TEST. Same reason as label-extraction.check.ts: this repo
 * verifies by running the real code path against a real record. `AnswersService` touches
 * Prisma through two calls only, so the stub below is the whole dependency - which means
 * what runs here is the service itself, not a re-description of it.
 */
import type { PrismaService } from '../src/prisma/prisma.service';
import {
  AnswersService,
  type AnswersView,
} from '../src/profile/answers.service';

/** The audit record of the real OpenAI/Ashby prefill, verbatim from the database. */
const REAL_ASHBY_RUN = {
  url: 'https://jobs.ashbyhq.com/openai/bf036b23-cd23-46d0-a02f-4b1483f4698a',
  atsType: 'ASHBY',
  preparedAt: '2026-09-10T09:49:11.028Z',
  needsHuman: ['(unlabelled) - required, still empty'],
  fields: [
    {
      key: 'resume',
      label: '(unlabelled)',
      handle: 'f0',
      reason: 'resume upload',
      outcome: 'filled',
      required: false,
    },
    {
      key: 'fullName',
      label: 'Legal Name',
      handle: 'f1',
      reason: 'mapped from the field name "_systemfield_name"',
      outcome: 'filled',
      required: true,
    },
    {
      key: 'fullName',
      label: 'Preferred Name (if applicable)',
      handle: 'f2',
      reason: "the candidate's fullName",
      outcome: 'filled',
      required: false,
    },
    {
      key: 'email',
      label: 'Email',
      handle: 'f3',
      reason: 'mapped from the field name "_systemfield_email"',
      outcome: 'filled',
      required: true,
    },
    {
      key: 'resume',
      label: 'Resume',
      handle: 'f4',
      reason: 'resume upload',
      outcome: 'filled',
      required: true,
    },
    {
      key: 'phone',
      label: 'Phone Number',
      handle: 'f5',
      reason: "the candidate's phone",
      outcome: 'filled',
      required: true,
    },
    // The two the sibling-label fix was for. Still excluded here: a label that could not
    // be read is not a question anyone can file an answer under.
    {
      key: null,
      label: '(unlabelled)',
      handle: 'f6',
      reason: 'no stored answer matches',
      outcome: 'blank',
      required: false,
    },
    {
      key: null,
      label: '(unlabelled)',
      handle: 'f7',
      reason: 'no stored answer matches',
      outcome: 'blank',
      required: true,
    },
    // The one real question on the form.
    {
      key: null,
      label: 'Additional Information',
      handle: 'f8',
      reason: 'no stored answer matches',
      outcome: 'blank',
      required: false,
    },
    // A declaration. No `fieldClass` on this record, so it has to be recognised from the
    // label - see unansweredFields.
    {
      key: null,
      label: 'I confirm I have read the above.',
      handle: 'f9',
      reason: 'no stored answer matches',
      outcome: 'blank',
      required: false,
    },
  ],
};

/** A record written after `fieldClass` exists, with one of every class. */
const CLASSED_RUN = {
  preparedAt: '2026-09-18T07:00:00.000Z',
  fields: [
    {
      key: null,
      label: 'What are your pronouns?',
      handle: 'g0',
      fieldClass: 'demographic',
      reason: 'demographic or EEO question, never auto-filled',
      outcome: 'skipped',
      required: false,
    },
    {
      key: null,
      label: 'I agree to the privacy policy',
      handle: 'g1',
      fieldClass: 'consent',
      reason: 'a declaration only you can make, so it is never ticked for you',
      outcome: 'skipped',
      required: true,
    },
    {
      key: 'expectedCtcLpa',
      label: 'Expected CTC',
      handle: 'g2',
      fieldClass: 'legal',
      reason: 'nothing stored for expectedCtcLpa',
      outcome: 'blank',
      required: true,
    },
    {
      key: null,
      label: 'Why do you want to work here?',
      handle: 'g3',
      fieldClass: 'long-form',
      reason: 'free-text question, flagged for the human to answer',
      outcome: 'skipped',
      required: true,
    },
    {
      key: null,
      label: 'How did you hear about us?',
      handle: 'g4',
      fieldClass: 'ordinary',
      reason: 'no stored answer matches',
      outcome: 'blank',
      required: false,
    },
  ],
};

/** The same question, worded differently, on a second form. */
const SECOND_RUN = {
  preparedAt: '2026-09-19T07:00:00.000Z',
  fields: [
    {
      key: null,
      label: 'How did you hear about us?',
      handle: 'h0',
      fieldClass: 'ordinary',
      reason: 'no stored answer matches',
      outcome: 'blank',
      required: true,
    },
    {
      key: null,
      label: 'Additional information',
      handle: 'h1',
      fieldClass: 'long-form',
      reason: 'free-text question, flagged for the human to answer',
      outcome: 'skipped',
      required: false,
    },
  ],
};

interface Case {
  name: string;
  applications: { screeningAnswers: unknown; updatedAt: Date }[];
  /** What is already in the library, question -> answer. */
  stored?: Record<string, string>;
  check(view: AnswersView): string | null;
}

const asked = (view: AnswersView) => view.asked.map((a) => a.question);

const CASES: Case[] = [
  {
    name: 'the real Ashby run offers its one answerable question and nothing else',
    applications: [
      {
        screeningAnswers: REAL_ASHBY_RUN,
        updatedAt: new Date('2026-09-10T09:49:11Z'),
      },
    ],
    check: (view) =>
      same(asked(view), ['Additional Information']) ??
      expect(
        view.asked[0]?.lastAskedAt === REAL_ASHBY_RUN.preparedAt,
        'lastAskedAt comes from the record, not the row timestamp',
      ),
  },
  {
    name: 'a record with no fields at all is not an error',
    applications: [{ screeningAnswers: null, updatedAt: new Date() }],
    check: (view) => same(asked(view), []),
  },
  {
    name: 'demographic, consent and keyed fields are all excluded by class',
    applications: [{ screeningAnswers: CLASSED_RUN, updatedAt: new Date() }],
    check: (view) =>
      same(asked(view), [
        'Why do you want to work here?',
        'How did you hear about us?',
      ]),
  },
  {
    name: 'the same question on two forms counts twice and keeps the latest date',
    applications: [
      { screeningAnswers: SECOND_RUN, updatedAt: new Date() },
      { screeningAnswers: CLASSED_RUN, updatedAt: new Date() },
    ],
    check: (view) => {
      const hear = view.asked.find(
        (a) => a.question === 'How did you hear about us?',
      );
      return (
        expect(
          hear?.timesAsked === 2,
          `asked twice, got ${hear?.timesAsked}`,
        ) ??
        expect(
          hear?.required === true,
          'required on one form makes it required',
        ) ??
        expect(
          hear?.lastAskedAt === SECOND_RUN.preparedAt,
          'newest date wins',
        ) ??
        expect(view.asked[0] === hear, 'the commonest question sorts first')
      );
    },
  },
  {
    name: 'a stored answer removes the question, however it was worded',
    applications: [
      { screeningAnswers: REAL_ASHBY_RUN, updatedAt: new Date() },
      { screeningAnswers: SECOND_RUN, updatedAt: new Date() },
    ],
    // 'Additional information' vs 'Additional Information' - normalizeQuestion decides,
    // the same way the form filler decides at fill time.
    stored: { 'additional information': 'Happy to share more on a call.' },
    check: (view) => same(asked(view), ['How did you hear about us?']),
  },
  {
    name: 'a starter a real form already asked is offered once, from `asked`',
    applications: [{ screeningAnswers: CLASSED_RUN, updatedAt: new Date() }],
    check: (view) =>
      expect(
        asked(view).includes('How did you hear about us?'),
        'the real one is in asked',
      ) ??
      expect(
        !view.suggested.includes('How did you hear about us?'),
        'and not also in suggested',
      ) ??
      expect(view.suggested.length > 0, 'the other starters still appear'),
  },
  {
    name: 'a stored answer removes the starter too',
    applications: [],
    stored: { 'Do you have a valid passport?': 'Yes, valid until 2031.' },
    check: (view) =>
      expect(
        !view.suggested.includes('Do you have a valid passport?'),
        'answered starters are gone',
      ) ??
      expect(
        view.suggested.includes('Current employer'),
        'unanswered ones remain',
      ),
  },
  {
    name: 'a paragraph of instructions is not a question',
    applications: [
      {
        screeningAnswers: {
          fields: [
            {
              key: null,
              label: 'x'.repeat(501),
              handle: 'z0',
              fieldClass: 'ordinary',
              reason: 'no stored answer matches',
              outcome: 'blank',
              required: true,
            },
          ],
        },
        updatedAt: new Date(),
      },
    ],
    check: (view) => same(asked(view), []),
  },
];

/** Both lists, in order. */
function same(got: string[], want: string[]): string | null {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  return a === b ? null : `wanted ${b}, got ${a}`;
}

function expect(ok: boolean, complaint: string): string | null {
  return ok ? null : complaint;
}

async function main() {
  let pass = 0;
  let fail = 0;

  for (const testCase of CASES) {
    // The whole Prisma surface AnswersService.view touches. Anything it starts using
    // beyond these two calls fails here loudly rather than reading as a passing test.
    const prisma = {
      applicationAnswers: {
        findUnique: () =>
          Promise.resolve(
            testCase.stored
              ? {
                  userId: 'u1',
                  updatedAt: new Date('2026-09-19T00:00:00Z'),
                  customAnswers: testCase.stored,
                }
              : null,
          ),
      },
      application: { findMany: () => Promise.resolve(testCase.applications) },
    } as unknown as PrismaService;

    const view = await new AnswersService(prisma).view('u1');
    const complaint = testCase.check(view);
    if (complaint === null) pass++;
    else fail++;
    console.log(
      `${complaint === null ? 'PASS' : 'FAIL'}  ${testCase.name}` +
        (complaint === null ? '' : `\n        ${complaint}`),
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
