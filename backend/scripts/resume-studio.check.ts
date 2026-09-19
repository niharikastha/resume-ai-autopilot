/**
 * Does the resume studio build documents out of the candidate's own words, and only those?
 *
 *   npx ts-node -r tsconfig-paths/register scripts/resume-studio.check.ts
 *
 * WHAT IS BEING CHECKED, and it is not the prompt. The three screens added for the studio
 * - the preview beside the editor, the suggestions panel, and tailoring against a pasted
 * or picked job description - all run the SAME provenance guard, document builder and
 * renderer the apply pipeline runs. The risk in that arrangement is not that the model
 * writes something wrong; the model is expected to. The risk is that one of the three new
 * paths quietly checks it less, or renders it through something else. So the fabrications
 * here are hand-written, the LLM is a stub returning them verbatim, and what runs is the
 * real service against the real guard and the real renderer:
 *
 *   - a resume belonging to somebody else is not found rather than refused
 *   - `allowedTech` is the atoms' tags plus ENABLED SkillsReserve rows, and nothing else
 *   - the preview is a real docx written by resume.render.ts, one file per resume
 *   - a suggested rewrite claiming a figure the atom does not state is DROPPED
 *   - advice is kept unguarded, because naming an absent fact is the point of it
 *   - a failed tailoring run renders the BASE resume, and the fabricated sentence is
 *     nowhere in the file it wrote
 *
 * THE DOCUMENTS ARE OPENED. The last point cannot be checked from a return value - a
 * service that recorded `guardPassed: false` and rendered the rejected text anyway would
 * look identical from the outside - so the docx is unzipped and `word/document.xml` is
 * read. That is the only way to answer "what does the file actually say".
 *
 * WHY A SCRIPT AND NOT A JEST TEST. Same reason as the other two check scripts: this repo
 * verifies by running the real code path. The stubs below are Prisma, the config and the
 * LLM - three boundaries - and everything between them is the shipped code, including one
 * genuine LibreOffice conversion per render.
 *
 * Needs `unzip` and, for the pdf half, `soffice`. A machine without LibreOffice fails no
 * case here: a null pdf is a reported outcome, not an error.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AtomKind } from '@prisma/client';
import { execFileSync } from 'child_process';
import { mkdtemp, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { LlmProvider } from '../src/llm/llm.types';
import type { PrismaService } from '../src/prisma/prisma.service';
import { OnDemandTailoringService } from '../src/tailoring/on-demand.service';
import { PreviewService } from '../src/tailoring/preview.service';
import { ResumeSourceService } from '../src/tailoring/resume.source';
import { SuggestionsService } from '../src/tailoring/suggestions.service';

const USER = 'user-1';
const OTHER_USER = 'user-2';
const PROFILE = 'profile-1';

/** The atoms, in ordinal order. The ROLE one is first because the headline is its text. */
const ATOMS = [
  {
    id: 'atom-role',
    kind: AtomKind.ROLE,
    text: 'Senior Backend Engineer',
    tech: [],
    metrics: [],
    employer: 'Acme',
    dateRange: '2023-2025',
    ordinal: 0,
  },
  {
    id: 'atom-cache',
    kind: AtomKind.BULLET,
    text: 'Cut checkout p95 latency by 40% with a Redis cache in front of Postgres.',
    tech: ['Redis', 'PostgreSQL'],
    metrics: ['40%'],
    employer: 'Acme',
    dateRange: '2023-2025',
    ordinal: 1,
  },
  {
    id: 'atom-services',
    kind: AtomKind.BULLET,
    text: 'Moved 12 services out of the monolith and onto containers.',
    tech: ['Docker'],
    metrics: ['12'],
    employer: 'Acme',
    dateRange: '2023-2025',
    ordinal: 2,
  },
  {
    id: 'atom-skill',
    kind: AtomKind.SKILL,
    text: 'TypeScript',
    tech: ['TypeScript'],
    metrics: [],
    employer: null,
    dateRange: null,
    ordinal: 3,
  },
  {
    id: 'atom-edu',
    kind: AtomKind.EDU,
    text: 'B.Tech, Computer Science',
    tech: [],
    metrics: [],
    employer: 'A University',
    dateRange: '2015-2019',
    ordinal: 4,
  },
];

const PROFILE_ROW = {
  id: PROFILE,
  userId: USER,
  label: 'Backend 2026',
  isActive: true,
  confirmedAt: new Date('2026-09-01T00:00:00Z'),
  fullName: 'Astha Niharika',
  email: 'astha@example.com',
  phone: '+91 90000 00000',
  location: 'Bengaluru',
  linkedIn: null,
  github: null,
  portfolio: null,
};

/** Terraform is enabled, Kubernetes is not. The difference is checked below. */
const RESERVE = [
  { skill: 'Terraform', enabled: true },
  { skill: 'Kubernetes', enabled: false },
];

const JOBS: Record<
  string,
  {
    id: string;
    title: string;
    descriptionText: string | null;
    company: { name: string } | null;
  }
> = {
  'job-ok': {
    id: 'job-ok',
    title: 'Staff Backend Engineer',
    descriptionText:
      'You will own our payments platform: Postgres, Redis, containers, and the ' +
      'latency budget that goes with them. We care about people who have made a ' +
      'monolith smaller rather than talked about it.',
    company: { name: 'Globex' },
  },
  'job-empty': {
    id: 'job-empty',
    title: 'Backend Engineer',
    descriptionText: '   ',
    company: { name: 'Initech' },
  },
};

const JD = [
  'We are hiring a backend engineer to work on checkout latency, caching and the',
  'gradual removal of a monolith. Postgres and Redis experience matters more to us',
  'than any particular framework, and you will be measured on p95 rather than on',
  'tickets closed.',
].join(' ');

// ---------------------------------------------------------------------------- stubs

/** Rows written by `run`, so `list` can read what the service actually stored. */
interface StoredRow {
  id: string;
  userId: string;
  profileId: string;
  jobId: string | null;
  title: string;
  company: string;
  jdText: string;
  atomSelection: unknown;
  coverLetter: string | null;
  docxPath: string | null;
  pdfPath: string | null;
  provenanceReport: unknown;
  guardPassed: boolean;
  llmProvider: string;
  model: string | null;
  createdAt: Date;
}

const stored: StoredRow[] = [];

/**
 * The whole Prisma surface these four services touch.
 *
 * `where` is honoured rather than ignored - the ownership case and the enabled-only case
 * are both checks of a where clause, and a stub that returned everything regardless would
 * make them pass without the code being right.
 */
const prisma = {
  candidateProfile: {
    findFirst: (args: {
      where: { id?: string; userId: string; isActive?: boolean };
    }) => {
      const w = args.where;
      const match =
        w.userId === PROFILE_ROW.userId &&
        (w.id === undefined || w.id === PROFILE_ROW.id);
      return Promise.resolve(match ? PROFILE_ROW : null);
    },
  },
  profileAtom: {
    findMany: () =>
      Promise.resolve([...ATOMS].sort((a, b) => a.ordinal - b.ordinal)),
  },
  skillsReserve: {
    findMany: (args: { where: { enabled?: boolean } }) =>
      Promise.resolve(
        RESERVE.filter(
          (row) => args.where.enabled === undefined || row.enabled,
        ).map((row) => ({ skill: row.skill })),
      ),
  },
  jobPosting: {
    findUnique: (args: { where: { id: string } }) =>
      Promise.resolve(JOBS[args.where.id] ?? null),
  },
  tailoredResume: {
    create: (args: { data: Omit<StoredRow, 'createdAt'> }) => {
      const row = {
        ...args.data,
        // Spaced so "newest first" is a real ordering rather than a tie.
        createdAt: new Date(Date.now() + stored.length * 1000),
      };
      stored.push(row);
      return Promise.resolve(row);
    },
    findMany: (args: {
      where: { userId: string; profileId?: string };
      take: number;
    }) =>
      Promise.resolve(
        stored
          .filter(
            (row) =>
              row.userId === args.where.userId &&
              (args.where.profileId === undefined ||
                row.profileId === args.where.profileId),
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, args.take),
      ),
  },
} as unknown as PrismaService;

let outputDir = '';
const config = {
  getOrThrow: () => outputDir,
} as unknown as ConfigService;

/** One scripted answer, returned verbatim. The schema is the provider's job, not this. */
function llmReturning(value: unknown): LlmProvider {
  return {
    id: 'claude',
    modelFor: () => 'stub-deep',
    complete: () =>
      Promise.resolve({
        value,
        provider: 'claude',
        model: 'stub-deep',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      }),
    completeMany: () => {
      throw new Error('the studio never batches');
    },
  } as unknown as LlmProvider;
}

// ------------------------------------------------------------------- the model's answers

/** Seven suggestions: three that should survive the guard and four that should not. */
const SUGGESTIONS = {
  overall: '  Strong on latency work, thin on ownership.  ',
  suggestions: [
    {
      atomId: 'atom-cache',
      kind: 'rewrite',
      text: 'Cut checkout p95 latency 40% by putting Redis in front of PostgreSQL.',
      why: 'Leads with the result.',
    },
    {
      atomId: 'atom-services',
      kind: 'rewrite',
      // 'Terraform' is in SkillsReserve and enabled, so this is allowed.
      text: 'Moved 12 services off the monolith onto containers, described in Terraform.',
      why: 'Names the tooling.',
    },
    {
      atomId: 'atom-services',
      kind: 'advice',
      text: 'If you know how much deploy time that saved, say the number.',
      why: 'A figure here would carry the bullet.',
    },
    {
      atomId: 'atom-cache',
      kind: 'rewrite',
      text: 'Cut checkout p95 latency by 85% with a Redis cache.',
      why: 'Stronger figure.',
    },
    {
      atomId: 'atom-cache',
      kind: 'rewrite',
      text: 'Cut checkout p95 latency 40% by moving reads onto Kafka.',
      why: 'Mentions streaming.',
    },
    {
      atomId: 'atom-services',
      kind: 'rewrite',
      // Kubernetes IS in SkillsReserve - and disabled, which must not count.
      text: 'Moved 12 services off the monolith and onto Kubernetes.',
      why: 'More specific.',
    },
    {
      atomId: 'atom-deleted',
      kind: 'rewrite',
      text: 'Something about an atom that is not in this resume.',
      why: 'Stale id.',
    },
  ],
};

const HONEST_TAILORING = {
  selectedAtomIds: [
    'atom-role',
    'atom-cache',
    'atom-services',
    'atom-skill',
    'atom-edu',
  ],
  rewrites: [
    {
      atomId: 'atom-cache',
      text: 'Took 40% off checkout p95 with a Redis read-through cache over PostgreSQL.',
    },
  ],
  headline: 'Backend engineer, payments and latency',
  coverLetter:
    'I have spent two years on exactly the latency budget you describe.',
};

const FABRICATED_TAILORING = {
  selectedAtomIds: ['atom-role', 'atom-cache', 'atom-services'],
  rewrites: [
    {
      atomId: 'atom-cache',
      text: 'Cut checkout p95 latency by 85% with a Redis cache and Kafka fan-out.',
    },
  ],
  headline: 'Backend engineer, payments and latency',
  coverLetter:
    'I would be glad to bring the same 85% improvement to your team.',
};

// -------------------------------------------------------------------------- assertions

function expect(ok: boolean, complaint: string): string | null {
  return ok ? null : complaint;
}

function same(got: unknown, want: unknown): string | null {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  return a === b ? null : `wanted ${b}, got ${a}`;
}

/**
 * What a docx SAYS, with the markup taken out.
 *
 * Tags are removed without putting a space in their place: Word splits a sentence across
 * several `<w:t>` runs, and a space per tag would break every phrase being searched for.
 */
function documentText(docxPath: string): string {
  const xml = execFileSync('unzip', ['-p', docxPath, 'word/document.xml'], {
    maxBuffer: 16 * 1024 * 1024,
  }).toString('utf8');
  return xml.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
}

async function thrown(
  run: () => Promise<unknown>,
): Promise<{ name: string; message: string } | null> {
  try {
    await run();
    return null;
  } catch (error) {
    const err = error as Error;
    return { name: err.constructor.name, message: err.message };
  }
}

// ------------------------------------------------------------------------------- cases

interface Case {
  name: string;
  run: () => Promise<string | null>;
}

const source = () => new ResumeSourceService(prisma);
const preview = () => new PreviewService(source(), config);
const suggestions = (answer: unknown) =>
  new SuggestionsService(source(), llmReturning(answer));
const tailoring = (answer: unknown) =>
  new OnDemandTailoringService(prisma, source(), config, llmReturning(answer));

const CASES: Case[] = [
  {
    name: "somebody else's resume is not found, not refused",
    run: async () => {
      const failure = await thrown(() => source().load(OTHER_USER, PROFILE));
      return (
        expect(failure !== null, 'it loaded') ??
        expect(
          failure?.name === NotFoundException.name,
          `wanted NotFoundException, got ${failure?.name}`,
        )
      );
    },
  },
  {
    name: 'the allowed technologies are the atoms plus ENABLED reserve rows only',
    run: async () => {
      const loaded = await source().load(USER);
      const tech = [...loaded.shared.allowedTech].sort();
      return (
        same(tech, [
          'Docker',
          'PostgreSQL',
          'Redis',
          'Terraform',
          'TypeScript',
        ]) ??
        expect(
          loaded.headline === 'Senior Backend Engineer',
          `headline was ${String(loaded.headline)}`,
        ) ??
        expect(
          loaded.documentAtoms.map((a) => a.ordinal).join() === '0,1,2,3,4',
          'atoms are not in ordinal order',
        )
      );
    },
  },
  {
    name: 'the preview is a real docx of the base resume, one file per resume',
    run: async () => {
      const first = await preview().render(USER, PROFILE);
      await preview().render(USER, PROFILE);

      const file = await preview().file(USER, PROFILE, 'docx');
      const text = documentText(file.path);
      const docxCount = (await readdir(join(outputDir, 'previews'))).filter(
        (name) => name.endsWith('.docx'),
      ).length;

      return (
        expect(first.atomCount === ATOMS.length, `${first.atomCount} pieces`) ??
        expect(
          text.includes('Cut checkout p95 latency by 40%'),
          'the base bullet is not in the document',
        ) ??
        expect(
          text.includes('Astha Niharika'),
          'the contact block is not in the document',
        ) ??
        expect(
          docxCount === 1,
          `${docxCount} docx files after two renders - previews are accumulating`,
        ) ??
        expect(
          first.label === PROFILE_ROW.label,
          'the label is not the resume label',
        )
      );
    },
  },
  {
    name: 'an unrendered preview is a 404, not an empty file',
    run: async () => {
      const failure = await thrown(() =>
        preview().file(USER, PROFILE, 'nope' as 'pdf'),
      );
      return expect(
        failure?.name === NotFoundException.name,
        `wanted NotFoundException, got ${failure?.name}`,
      );
    },
  },
  {
    name: 'a suggestion claiming a figure the atom does not state is dropped',
    run: async () => {
      const result = await suggestions(SUGGESTIONS).suggest(USER, {
        resumeId: PROFILE,
      });

      const kept = result.suggestions.map(
        (s) => `${s.kind}:${s.text.slice(0, 24)}`,
      );
      return (
        same(kept, [
          'rewrite:Cut checkout p95 latency',
          'rewrite:Moved 12 services off th',
          'advice:If you know how much dep',
        ]) ??
        // 85%, Kafka, the disabled Kubernetes, and the stale atom id.
        expect(
          result.rejected === 4,
          `${result.rejected} rejected, wanted 4`,
        ) ??
        expect(
          result.overall === 'Strong on latency work, thin on ownership.',
          'the overall note was not trimmed',
        ) ??
        expect(
          result.suggestions[0]?.current === ATOMS[1].text,
          'a suggestion does not carry the current text of its atom',
        )
      );
    },
  },
  {
    name: 'a tailoring run that passes the guard writes the rewritten sentence',
    run: async () => {
      const summary = await tailoring(HONEST_TAILORING).run(USER, {
        resumeId: PROFILE,
        jdText: JD,
      });
      const row = stored.find((r) => r.id === summary.id);
      const text = row?.docxPath ? documentText(row.docxPath) : '';

      return (
        expect(
          summary.guardPassed,
          `guard failed: ${summary.violations.join('; ')}`,
        ) ??
        expect(
          text.includes('Took 40% off checkout p95'),
          'the rewritten bullet is not in the document',
        ) ??
        expect(
          summary.coverLetter === HONEST_TAILORING.coverLetter,
          'the cover letter was not stored',
        ) ??
        expect(
          summary.jobId === null,
          'a pasted JD must not claim a posting',
        ) ??
        expect(
          summary.title === 'the role' && summary.company === 'the company',
          `pasted defaults were ${summary.title} / ${summary.company}`,
        ) ??
        expect(
          (row?.docxPath ?? '').includes(summary.id.slice(0, 8)),
          'the filename does not carry the row id, so two runs would collide',
        ) ??
        expect(
          (summary.counts?.numbersChecked ?? 0) > 0,
          'the guard checked no numbers at all',
        )
      );
    },
  },
  {
    name: 'a rejected rewrite is nowhere in the file the run wrote',
    run: async () => {
      const summary = await tailoring(FABRICATED_TAILORING).run(USER, {
        resumeId: PROFILE,
        jdText: JD,
      });
      const row = stored.find((r) => r.id === summary.id);
      const text = row?.docxPath ? documentText(row.docxPath) : '';

      return (
        expect(
          !summary.guardPassed,
          'the guard passed an invented 85% and Kafka',
        ) ??
        expect(
          summary.violations.some((v) => v.startsWith('invented-number')) &&
            summary.violations.some((v) => v.startsWith('invented-tech')),
          `violations were ${JSON.stringify(summary.violations)}`,
        ) ??
        expect(
          !text.includes('85%'),
          'the invented figure reached the document',
        ) ??
        expect(
          !text.includes('Kafka'),
          'the invented tech reached the document',
        ) ??
        expect(
          text.includes('Cut checkout p95 latency by 40%'),
          "the fallback is not the candidate's own bullet",
        ) ??
        expect(
          summary.coverLetter === null,
          'a cover letter from a rejected run was stored',
        ) ??
        expect(
          row?.atomSelection !== null && row?.atomSelection !== undefined,
          'the rejected selection was not kept as evidence',
        )
      );
    },
  },
  {
    name: 'a picked posting brings its own title, company and description',
    run: async () => {
      const summary = await tailoring(HONEST_TAILORING).run(USER, {
        resumeId: PROFILE,
        jobId: 'job-ok',
      });
      const row = stored.find((r) => r.id === summary.id);
      return (
        expect(summary.jobId === 'job-ok', 'the posting was not recorded') ??
        expect(
          summary.title === 'Staff Backend Engineer' &&
            summary.company === 'Globex',
          `got ${summary.title} / ${summary.company}`,
        ) ??
        expect(
          row?.jdText === JOBS['job-ok'].descriptionText,
          "the posting's own description was not stored",
        )
      );
    },
  },
  {
    name: 'the requests that cannot be honoured are refused before the model is called',
    run: async () => {
      const both = await thrown(() =>
        tailoring(HONEST_TAILORING).run(USER, {
          resumeId: PROFILE,
          jobId: 'job-ok',
          jdText: JD,
        }),
      );
      const short = await thrown(() =>
        tailoring(HONEST_TAILORING).run(USER, {
          resumeId: PROFILE,
          jdText: 'Backend engineer, Bengaluru.',
        }),
      );
      const empty = await thrown(() =>
        tailoring(HONEST_TAILORING).run(USER, {
          resumeId: PROFILE,
          jobId: 'job-empty',
        }),
      );
      const missing = await thrown(() =>
        tailoring(HONEST_TAILORING).run(USER, {
          resumeId: PROFILE,
          jobId: 'job-gone',
        }),
      );

      return (
        expect(
          both?.name === BadRequestException.name,
          `a posting and a paste together gave ${both?.name}`,
        ) ??
        expect(
          short?.name === BadRequestException.name,
          `a two-line paste gave ${short?.name}`,
        ) ??
        expect(
          empty?.name === BadRequestException.name,
          `a posting with no description gave ${empty?.name}`,
        ) ??
        expect(
          missing?.name === NotFoundException.name,
          `an unknown posting gave ${missing?.name}`,
        )
      );
    },
  },
  {
    name: 'the history is every run against this resume, newest first',
    run: async () => {
      const rows = await tailoring(HONEST_TAILORING).list(USER, PROFILE);
      const ordered = rows.every(
        (row, at) => at === 0 || rows[at - 1].createdAt >= row.createdAt,
      );
      return (
        expect(rows.length === 3, `${rows.length} rows, wanted 3`) ??
        expect(ordered, 'the history is not newest first') ??
        expect(
          rows.every((row) => !row.jdPreview.includes('\n')),
          'a jd preview still has its line breaks',
        ) ??
        expect(
          (await tailoring(HONEST_TAILORING).list(OTHER_USER, PROFILE))
            .length === 0,
          "another user can see this resume's history",
        )
      );
    },
  },
];

async function main() {
  outputDir = await mkdtemp(join(tmpdir(), 'resume-studio-check-'));
  let pass = 0;
  let fail = 0;

  try {
    for (const testCase of CASES) {
      const complaint = await testCase
        .run()
        .catch((error: unknown) => `threw: ${String(error)}`);
      if (complaint === null) pass++;
      else fail++;
      console.log(
        `${complaint === null ? 'PASS' : 'FAIL'}  ${testCase.name}` +
          (complaint === null ? '' : `\n        ${complaint}`),
      );
    }
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
