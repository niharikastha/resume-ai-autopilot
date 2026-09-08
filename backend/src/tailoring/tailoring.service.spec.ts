/**
 * The service's selection rules.
 *
 * These exist because the shortlist is where the money goes. Every row it returns is
 * one deep-tier call, and the two ways this code can be wrong are both silent: it
 * returns too many postings and the daily cap means nothing, or it returns none and
 * the run reports "nothing to tailor" for a reason that has nothing to do with the
 * job market. The `--job` bypass shipped broken in exactly the second way - it queried
 * MatchScore for a posting the caller had already named, so the one flag meant for
 * debugging before matching has run was unusable before matching had run.
 *
 * WHAT IS FAKED AND WHAT IS NOT. Prisma is a hand-written stub, so nothing here
 * verifies SQL. Where a filter belongs to the database the test asserts on the `where`
 * clause the service BUILT rather than on what the stub returned - otherwise the test
 * would be checking the stub's filtering, which no user runs. The selection loop
 * itself (the cap, the per-company rule, the existing-variant skip) is real code
 * running against real inputs.
 *
 * The LLM is a stub too, and deliberately never reaches the network: `dryRun: true`
 * is passed almost everywhere so no file is written either.
 */
import { AtomKind, MatchVerdict } from '@prisma/client';
import { TailoringError, TailoringService } from './tailoring.service';
import type { TailorOutput } from '../llm/tasks/tailor-resume.task';
import type { LlmProvider, LlmResult, LlmTier } from '../llm/llm.types';

/** Three atoms across two employers, as in the guard's own fixture. */
const ATOMS = [
  {
    id: 'atom-1',
    profileId: 'profile-1',
    kind: AtomKind.ROLE,
    text: 'Backend Engineer',
    tech: ['Node.js'],
    metrics: [],
    employer: 'Merqube',
    dateRange: 'Jan 2024 - Present',
    ordinal: 0,
  },
  {
    id: 'atom-2',
    profileId: 'profile-1',
    kind: AtomKind.BULLET,
    text: 'Improved ingestion throughput by 65% by moving parsing onto worker threads.',
    tech: ['Node.js', 'Worker Threads'],
    metrics: ['65%'],
    employer: 'Merqube',
    dateRange: 'Jan 2024 - Present',
    ordinal: 1,
  },
  {
    id: 'atom-3',
    profileId: 'profile-1',
    kind: AtomKind.BULLET,
    text: 'Owned the deployment pipeline and the on-call rotation.',
    tech: ['Docker'],
    metrics: [],
    employer: 'Merqube',
    dateRange: 'Jan 2024 - Present',
    ordinal: 2,
  },
];

const PROFILE = {
  id: 'profile-1',
  userId: 'user-1',
  label: 'default',
  fullName: 'Test Candidate',
  email: 'candidate@example.com',
  phone: null,
  location: null,
  linkedIn: null,
  github: null,
  portfolio: null,
  confirmedAt: new Date('2026-01-01'),
  // The selected resume. A candidate may keep several; tailoring reads this one and
  // refuses rather than picking, so every fixture below has to say which it is.
  isActive: true,
  atoms: [ATOMS[0]],
};

interface FakeJob {
  id: string;
  title: string;
  descriptionText: string;
  companyId: string | null;
  company: { id: string; name: string } | null;
  closedAt: Date | null;
}

function job(id: string, overrides: Partial<FakeJob> = {}): FakeJob {
  return {
    id,
    title: `Backend Engineer ${id}`,
    descriptionText:
      'We need someone who has run a Node.js ingestion pipeline.',
    companyId: `company-${id}`,
    company: { id: `company-${id}`, name: `Company ${id}` },
    closedAt: null,
    ...overrides,
  };
}

/** A guard-passing output: every atom selected, nothing rewritten, honest headline. */
function passingOutput(overrides: Partial<TailorOutput> = {}): TailorOutput {
  return {
    selectedAtomIds: ['atom-1', 'atom-2', 'atom-3'],
    rewrites: [],
    headline: 'Backend engineer, ingestion pipelines',
    coverLetter: '',
    ...overrides,
  };
}

interface Seed {
  profiles?: unknown[];
  atoms?: unknown[];
  /** MatchScore rows, already in the state the query would have returned them. */
  scores?: { userId: string; jobId: string; score: number; job: FakeJob }[];
  jobs?: FakeJob[];
  variants?: { jobId: string }[];
  reserve?: { skill: string }[];
}

/** Records what it was asked, so the tests can assert on the query, not the answer. */
class FakePrisma {
  readonly calls: { matchScoreFindMany: unknown[]; variantCreate: unknown[] } =
    {
      matchScoreFindMany: [],
      variantCreate: [],
    };

  constructor(private readonly seed: Seed) {}

  candidateProfile = {
    findMany: () => Promise.resolve(this.seed.profiles ?? [PROFILE]),
  };

  profileAtom = {
    findMany: () => Promise.resolve(this.seed.atoms ?? ATOMS),
  };

  skillsReserve = {
    findMany: () => Promise.resolve(this.seed.reserve ?? []),
  };

  matchScore = {
    findMany: (args: { take?: number }) => {
      this.calls.matchScoreFindMany.push(args);
      // `take` is honoured because the service relies on over-fetching, and a stub
      // that ignored it would hide a cap applied to the wrong number.
      const rows = this.seed.scores ?? [];
      return Promise.resolve(args.take ? rows.slice(0, args.take) : rows);
    },
    findUnique: (args: { where: { userId_jobId: { jobId: string } } }) =>
      Promise.resolve(
        this.seed.scores?.find(
          (s) => s.jobId === args.where.userId_jobId.jobId,
        ) ?? null,
      ),
  };

  jobPosting = {
    findUnique: (args: { where: { id: string } }) =>
      Promise.resolve(
        this.seed.jobs?.find((j) => j.id === args.where.id) ?? null,
      ),
  };

  resumeVariant = {
    findMany: () => Promise.resolve(this.seed.variants ?? []),
    create: (args: unknown) => {
      this.calls.variantCreate.push(args);
      return Promise.resolve({ id: 'variant-1' });
    },
  };
}

/** Returns a fixed output, or throws, per call. */
class FakeLlm implements LlmProvider {
  readonly id = 'claude' as const;
  readonly seen: string[] = [];

  constructor(
    private readonly reply: (title: string) => TailorOutput | Error = () =>
      passingOutput(),
  ) {}

  modelFor(_tier: LlmTier): string {
    return 'claude-opus-5';
  }

  complete<S, I, O>(
    _task: unknown,
    _shared: S,
    input: I,
  ): Promise<LlmResult<O>> {
    const title = (input as { title: string }).title;
    this.seen.push(title);
    const answer = this.reply(title);
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({
      value: answer as unknown as O,
      provider: 'claude',
      model: 'claude-opus-5',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    });
  }

  // Underscored because they exist only to match the interface's signature; this
  // path is never reached, and tailoring is one call per posting by design.
  completeMany<_S, _I, O>(): Promise<Map<string, LlmResult<O>>> {
    throw new Error('tailoring does not batch');
  }
}

function build(seed: Seed = {}, llm: FakeLlm = new FakeLlm()) {
  const prisma = new FakePrisma(seed);
  const config = { getOrThrow: () => '.artifacts/test-resumes' };
  const service = new TailoringService(prisma as never, config as never, llm);
  return { service, prisma, llm };
}

function scored(j: FakeJob, score: number) {
  return { userId: 'user-1', jobId: j.id, score, job: j };
}

describe('the --job bypass', () => {
  it('tailors a posting that has never been scored', async () => {
    // The regression. There is no MatchScore row at all here, which is the state the
    // flag exists for, and the first version of this code returned an empty shortlist.
    const target = job('a');
    const { service, prisma, llm } = build({ jobs: [target], scores: [] });

    const result = await service.tailor({ jobId: 'a', dryRun: true });

    expect(result.shortlisted).toBe(1);
    expect(result.tailored).toBe(1);
    expect(result.guardPassed).toBe(1);
    expect(llm.seen).toEqual(['Backend Engineer a']);
    // And it did not consult the shortlist on the way.
    expect(prisma.calls.matchScoreFindMany).toHaveLength(0);
  });

  it('reports the score as 0 when there is none, rather than refusing', async () => {
    const { service } = build({ jobs: [job('a')], scores: [] });

    const result = await service.tailor({ jobId: 'a', dryRun: true });

    expect(result.results[0].score).toBe(0);
  });

  it('shows the real score when the posting was scored', async () => {
    const target = job('a');
    const { service } = build({ jobs: [target], scores: [scored(target, 81)] });

    const result = await service.tailor({ jobId: 'a', dryRun: true });

    expect(result.results[0].score).toBe(81);
  });

  it('tailors a posting whose verdict would not have shortlisted it', async () => {
    // No verdict is consulted on this path. A WEAK posting is a legitimate thing to
    // point the prompt at while debugging it.
    const target = job('a');
    const { service } = build({ jobs: [target], scores: [scored(target, 12)] });

    await expect(
      service.tailor({ jobId: 'a', dryRun: true }),
    ).resolves.toMatchObject({
      tailored: 1,
    });
  });

  it('ignores an existing passing variant without --force', async () => {
    // The existing-variant skip is a cap-protection rule, and the cap is not what
    // --job is subject to.
    const target = job('a');
    const { service } = build({
      jobs: [target],
      scores: [],
      variants: [{ jobId: 'a' }],
    });

    await expect(
      service.tailor({ jobId: 'a', dryRun: true }),
    ).resolves.toMatchObject({
      tailored: 1,
    });
  });

  it('throws for an id that does not exist', async () => {
    const { service } = build({ jobs: [] });

    await expect(
      service.tailor({ jobId: 'nope', dryRun: true }),
    ).rejects.toThrow(TailoringError);
    await expect(
      service.tailor({ jobId: 'nope', dryRun: true }),
    ).rejects.toThrow(/no posting with id nope/);
  });

  it('throws rather than reporting "nothing to tailor" for an empty description', async () => {
    // The distinction matters: "nothing to tailor" sends someone to look at matching
    // for a problem that is in the posting.
    const { service } = build({ jobs: [job('a', { descriptionText: '' })] });

    await expect(service.tailor({ jobId: 'a', dryRun: true })).rejects.toThrow(
      /empty description/,
    );
  });
});

describe('the shortlist query', () => {
  it('asks the database for STRONG and GOOD only, and only open postings', async () => {
    const { service, prisma } = build({ scores: [] });

    await service.tailor({ dryRun: true });

    expect(prisma.calls.matchScoreFindMany).toHaveLength(1);
    expect(prisma.calls.matchScoreFindMany[0]).toMatchObject({
      where: {
        userId: 'user-1',
        verdict: { in: [MatchVerdict.STRONG, MatchVerdict.GOOD] },
        job: { closedAt: null },
      },
      orderBy: { score: 'desc' },
    });
  });

  it('excludes BORDERLINE deliberately', async () => {
    // Stated as its own test because it is a judgement call, not an oversight: a
    // borderline role is the one a human most wants to see before a call is spent.
    const { service, prisma } = build({ scores: [] });

    await service.tailor({ dryRun: true });

    const where = (
      prisma.calls.matchScoreFindMany[0] as {
        where: { verdict: { in: MatchVerdict[] } };
      }
    ).where;
    expect(where.verdict.in).not.toContain(MatchVerdict.BORDERLINE);
  });

  it('over-fetches, because the later filters remove rows', async () => {
    const { service, prisma } = build({ scores: [] });

    await service.tailor({ dryRun: true, limit: 5 });

    expect(prisma.calls.matchScoreFindMany[0]).toMatchObject({ take: 20 });
  });

  it('says so when nothing was shortlisted, and makes no calls', async () => {
    const { service, llm } = build({ scores: [] });

    const result = await service.tailor({ dryRun: true });

    expect(result.shortlisted).toBe(0);
    expect(result.tailored).toBe(0);
    expect(llm.seen).toHaveLength(0);
  });
});

describe('what the shortlist spends the cap on', () => {
  it('stops at the limit', async () => {
    const jobs = [job('a'), job('b'), job('c')];
    const { service, llm } = build({
      scores: jobs.map((j, i) => scored(j, 90 - i)),
    });

    const result = await service.tailor({ dryRun: true, limit: 2 });

    expect(result.shortlisted).toBe(2);
    expect(llm.seen).toHaveLength(2);
  });

  it('takes at most one posting per company', async () => {
    // Three openings at one employer is a common shape, and sending three tailored
    // resumes to the same recruiter on the same day is the outcome being prevented.
    const same = {
      companyId: 'company-x',
      company: { id: 'company-x', name: 'X' },
    };
    const { service } = build({
      scores: [
        scored(job('a', same), 90),
        scored(job('b', same), 88),
        scored(job('c', same), 80),
      ],
    });

    const result = await service.tailor({ dryRun: true, limit: 10 });

    expect(result.shortlisted).toBe(1);
  });

  it('does not collapse postings that merely have no company', async () => {
    // A null companyId is unknown, not shared. Treating two nulls as one employer
    // would silently drop postings.
    const orphan = { companyId: null, company: null };
    const { service } = build({
      scores: [scored(job('a', orphan), 90), scored(job('b', orphan), 88)],
    });

    const result = await service.tailor({ dryRun: true, limit: 10 });

    expect(result.shortlisted).toBe(2);
  });

  it('skips a posting that already has a passing variant', async () => {
    const { service } = build({
      scores: [scored(job('a'), 90), scored(job('b'), 88)],
      variants: [{ jobId: 'a' }],
    });

    const result = await service.tailor({ dryRun: true, limit: 10 });

    expect(result.results.map((r) => r.jobId)).toEqual(['b']);
  });

  it('re-tailors it under --force', async () => {
    const { service } = build({
      scores: [scored(job('a'), 90)],
      variants: [{ jobId: 'a' }],
    });

    const result = await service.tailor({
      dryRun: true,
      limit: 10,
      force: true,
    });

    expect(result.results.map((r) => r.jobId)).toEqual(['a']);
  });

  it('skips a posting with no description text', async () => {
    const { service } = build({
      scores: [
        scored(job('a', { descriptionText: '' }), 95),
        scored(job('b'), 70),
      ],
    });

    const result = await service.tailor({ dryRun: true, limit: 10 });

    expect(result.results.map((r) => r.jobId)).toEqual(['b']);
  });
});

describe('the guard in the loop', () => {
  it('records a pass and keeps the tailored document', async () => {
    const { service } = build({ scores: [scored(job('a'), 90)] });

    const result = await service.tailor({ dryRun: true });

    expect(result.guardPassed).toBe(1);
    expect(result.guardFailed).toBe(0);
    expect(result.results[0].guardPassed).toBe(true);
  });

  it('counts a fabricated number as a failure and still returns the posting', async () => {
    // 65% became 85%. The run does not throw and the posting is still reported,
    // because the fallback is a base resume rather than nothing.
    const llm = new FakeLlm(() =>
      passingOutput({
        rewrites: [
          {
            atomId: 'atom-2',
            text: 'Improved ingestion throughput by 85% by moving parsing onto worker threads.',
          },
        ],
      }),
    );
    const { service } = build({ scores: [scored(job('a'), 90)] }, llm);

    const result = await service.tailor({ dryRun: true });

    expect(result.tailored).toBe(1);
    expect(result.guardFailed).toBe(1);
    expect(result.results[0].guardPassed).toBe(false);
    expect(result.results[0].report.violations.map((v) => v.kind)).toContain(
      'invented-number',
    );
  });

  it('writes nothing at all on a dry run, pass or fail', async () => {
    const { service, prisma } = build({ scores: [scored(job('a'), 90)] });

    const result = await service.tailor({ dryRun: true });

    expect(prisma.calls.variantCreate).toHaveLength(0);
    expect(result.results[0].variantId).toBeNull();
    expect(result.results[0].docxPath).toBeNull();
  });
});

describe('when a call fails', () => {
  it('carries on to the next posting', async () => {
    // Fourteen resumes beat none. The failure is counted, not thrown.
    const llm = new FakeLlm((title) =>
      title.endsWith('a') ? new Error('overloaded') : passingOutput(),
    );
    const { service } = build(
      { scores: [scored(job('a'), 90), scored(job('b'), 80)] },
      llm,
    );

    const result = await service.tailor({ dryRun: true, limit: 10 });

    expect(result.callFailures).toBe(1);
    expect(result.tailored).toBe(1);
    expect(result.results.map((r) => r.jobId)).toEqual(['b']);
  });
});

describe('choosing a profile', () => {
  it('tailors the selected resume and ignores the candidate’s others', async () => {
    // The unselected one is returned first by the query on purpose: nothing may
    // depend on the order rows come back in.
    const { service } = build({
      profiles: [
        { ...PROFILE, id: 'profile-2', label: 'ml-roles', isActive: false },
        PROFILE,
      ],
    });

    const result = await service.tailor({ dryRun: true, limit: 1 });

    expect(result.profileId).toBe('profile-1');
  });

  it('refuses when several resumes exist and none is selected', async () => {
    // Not "just use the newest". A resume the candidate did not choose, rendered
    // into a file named after a real company, is not a mistake that announces
    // itself - so this stops instead.
    const { service } = build({
      profiles: [
        { ...PROFILE, isActive: false },
        { ...PROFILE, id: 'profile-2', label: 'other', isActive: false },
      ],
    });

    await expect(service.tailor({ dryRun: true })).rejects.toThrow(
      /none is selected/,
    );
  });

  it('refuses to guess between two candidates who each have one selected', async () => {
    // Both active is legal: the unique index is per user. Without --user there is
    // no answer, and the wrong one renders the wrong person's name.
    const { service } = build({
      profiles: [
        PROFILE,
        { ...PROFILE, id: 'profile-2', userId: 'user-2', label: 'other' },
      ],
    });

    await expect(service.tailor({ dryRun: true })).rejects.toThrow(
      /2 candidates have a selected resume/,
    );
  });

  it('uses a named label even when it is not the selected one', async () => {
    // --label is the escape hatch, so it has to work on a resume the candidate has
    // NOT selected - otherwise trying an alternative resume would mean switching
    // the live one first.
    const { service } = build({
      profiles: [{ ...PROFILE, label: 'ml-roles', isActive: false }],
    });

    const result = await service.tailor({
      dryRun: true,
      limit: 1,
      profileLabel: 'ml-roles',
    });

    expect(result.profileId).toBe('profile-1');
  });

  it('refuses when there is no confirmed profile', async () => {
    const { service } = build({ profiles: [] });

    await expect(service.tailor({ dryRun: true })).rejects.toThrow(
      /no confirmed candidate profile/,
    );
  });

  it('refuses when the profile has no atoms, before spending anything', async () => {
    const llm = new FakeLlm();
    const { service } = build({ atoms: [] }, llm);

    await expect(service.tailor({ dryRun: true })).rejects.toThrow(/no atoms/);
    expect(llm.seen).toHaveLength(0);
  });
});

describe('the cached prefix', () => {
  it('merges enabled skills-reserve entries into the allowed tech', async () => {
    // Canonicalised and deduped: "nodejs" from the reserve and "Node.js" from an atom
    // tag are one permission, and the guard compares canonical forms.
    const llm = new FakeLlm(() =>
      passingOutput({ headline: 'Backend engineer working in Kubernetes' }),
    );
    const { service } = build(
      { scores: [scored(job('a'), 90)], reserve: [{ skill: 'kubernetes' }] },
      llm,
    );

    const result = await service.tailor({ dryRun: true });

    // Kubernetes is nowhere in the atoms; it is allowed only because the reserve
    // said so, which is the whole purpose of that table.
    expect(result.guardPassed).toBe(1);
  });

  it('rejects tech that no atom and no reserve entry allows', async () => {
    const llm = new FakeLlm(() =>
      passingOutput({ headline: 'Backend engineer working in Kubernetes' }),
    );
    const { service } = build(
      { scores: [scored(job('a'), 90)], reserve: [] },
      llm,
    );

    const result = await service.tailor({ dryRun: true });

    expect(result.guardFailed).toBe(1);
    expect(result.results[0].report.violations.map((v) => v.kind)).toContain(
      'invented-tech',
    );
  });
});
