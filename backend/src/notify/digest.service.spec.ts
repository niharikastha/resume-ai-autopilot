/**
 * What the digest counts, and what it must never do.
 *
 * FOUR THINGS ARE WORTH TESTING HERE, and none of them is "does it add up":
 *
 *   1. THE WINDOW. "9 new" is the only reason anybody opens this thing, and the number
 *      is a claim about an interval. Anchoring to the previous digest is what makes a
 *      missed morning get absorbed instead of skipped, and it is invisible from the
 *      output - a wrong window produces numbers that look perfectly reasonable.
 *   2. NULL IS NOT ZERO. `guardFailureRate` on a day when nothing was tailored, because
 *      "0% failed" is a claim of a perfect record and 0/0 is not one.
 *   3. THE SYSTEM SECTION IS ADMIN-ONLY. Board yield is a fact about the operator's
 *      machine, and a plain candidate's digest must not carry it.
 *   4. REBUILDING IS NOT RESENDING. The upsert must leave the delivery stamps alone, or
 *      a worker in a restart loop mails the same morning over and over.
 *
 * WHAT IS FAKED. Prisma, so there is no database. That means these tests cover the
 * queries this file BUILDS - the filters and the window - and not what Postgres does
 * with them.
 */
import { NotFoundException } from '@nestjs/common';
import {
  ApplicationStatus,
  MatchDecision,
  MatchVerdict,
  Prisma,
  Role,
} from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  DigestService,
  dayValue,
  deadBoards,
  istDay,
  missingAnswers,
} from './digest.service';
import { DigestPayloadSchema } from './digest.types';

const USER = 'user-1';

/** 02:00 IST on the 8th, which is still the 7th in UTC. */
const NOW = new Date('2026-09-07T20:30:00.000Z');

interface Seed {
  role?: Role;
  /** The row `windowStart` finds, or nothing for a first-ever digest. */
  previous?: { payload: unknown; createdAt: Date } | null;
  newMatches?: number;
  undecided?: number;
  verdicts?: { verdict: MatchVerdict; _count: { _all: number } }[];
  top?: ReturnType<typeof score>[];
  tailored?: number;
  guardFailed?: number;
  preparedWaiting?: number;
  submitted?: number;
  answers?: Parameters<typeof missingAnswers>[0];
  /** What the upsert reports back, for the already-emailed check. */
  emailedAt?: Date | null;
  updateManyCount?: number;
}

function score(
  over: { jobId?: string; score?: number; salary?: string | null } = {},
) {
  const jobId = over.jobId ?? 'job-1';
  return {
    jobId,
    score: over.score ?? 88,
    verdict: MatchVerdict.STRONG,
    estimatedSalaryLPA:
      over.salary === undefined || over.salary === null
        ? null
        : new Prisma.Decimal(over.salary),
    job: {
      title: 'Applied AI Engineer',
      location: 'Bengaluru, India',
      applyUrl: `https://jobs.example.com/${jobId}`,
      company: { name: 'OpenAI' },
    },
  };
}

class FakePrisma {
  readonly calls: string[] = [];
  readonly args: Record<string, unknown[]> = {};

  constructor(private readonly seed: Seed = {}) {}

  private record<T>(name: string, arg: unknown, value: T): T {
    this.calls.push(name);
    (this.args[name] ??= []).push(arg);
    return value;
  }

  /** The last `where` a named query was called with. */
  where(name: string, index = 0): Record<string, unknown> {
    const call = (this.args[name] ?? [])[index] as {
      where?: Record<string, unknown>;
    };
    return call?.where ?? {};
  }

  user = {
    findUnique: (arg: unknown) =>
      Promise.resolve(
        this.record('user.findUnique', arg, {
          role: this.seed.role ?? Role.USER,
        }),
      ),
  };

  dailyDigest = {
    upsert: (arg: unknown) =>
      Promise.resolve(
        this.record('dailyDigest.upsert', arg, {
          id: 'digest-1',
          emailedAt: this.seed.emailedAt ?? null,
        }),
      ),
    findFirst: (arg: unknown) =>
      Promise.resolve(
        this.record('dailyDigest.findFirst', arg, this.seed.previous ?? null),
      ),
    findMany: (arg: unknown) =>
      Promise.resolve(this.record('dailyDigest.findMany', arg, [])),
    count: (arg: unknown) =>
      Promise.resolve(this.record('dailyDigest.count', arg, 3)),
    update: (arg: unknown) =>
      Promise.resolve(this.record('dailyDigest.update', arg, {})),
    updateMany: (arg: unknown) =>
      Promise.resolve(this.record('dailyDigest.updateMany', arg, { count: 1 })),
  };

  candidateProfile = {
    findMany: (arg: unknown) =>
      Promise.resolve(
        this.record('candidateProfile.findMany', arg, [
          { user: { id: USER, email: 'a@example.com', name: 'A' } },
        ]),
      ),
  };

  matchScore = {
    // Two different questions share this method, told apart by the filter rather than by
    // call order - a test that depended on the order would break the moment the
    // Promise.all list is reordered.
    count: (arg: { where: { decision?: MatchDecision } }) =>
      Promise.resolve(
        this.record(
          arg.where.decision === undefined ? 'newMatches' : 'undecided',
          arg,
          arg.where.decision === undefined
            ? (this.seed.newMatches ?? 0)
            : (this.seed.undecided ?? 0),
        ),
      ),
    groupBy: (arg: { by: string[] }) =>
      Promise.resolve(
        arg.by[0] === 'verdict'
          ? this.record('verdicts', arg, this.seed.verdicts ?? [])
          : this.record('scoreModels', arg, [
              { model: 'claude-haiku-4-5', _count: { _all: 12 } },
            ]),
      ),
    findMany: (arg: unknown) =>
      Promise.resolve(
        this.record('matchScore.findMany', arg, this.seed.top ?? []),
      ),
    updateMany: (arg: unknown) =>
      Promise.resolve(
        this.record('matchScore.updateMany', arg, {
          count: this.seed.updateManyCount ?? 1,
        }),
      ),
  };

  resumeVariant = {
    count: (arg: { where: { guardPassed?: boolean } }) =>
      Promise.resolve(
        arg.where.guardPassed === undefined
          ? this.record('tailored', arg, this.seed.tailored ?? 0)
          : this.record('guardFailed', arg, this.seed.guardFailed ?? 0),
      ),
    groupBy: (arg: unknown) =>
      Promise.resolve(
        this.record('variantModels', arg, [
          { model: 'claude-opus-5', _count: { _all: 3 } },
        ]),
      ),
  };

  application = {
    count: (arg: { where: { status: ApplicationStatus } }) =>
      Promise.resolve(
        arg.where.status === ApplicationStatus.PREPARED
          ? this.record('preparedWaiting', arg, this.seed.preparedWaiting ?? 0)
          : this.record('submitted', arg, this.seed.submitted ?? 0),
      ),
  };

  applicationAnswers = {
    findUnique: (arg: unknown) =>
      Promise.resolve(
        this.record(
          'applicationAnswers.findUnique',
          arg,
          this.seed.answers ?? null,
        ),
      ),
  };

  company = {
    count: (arg: unknown) =>
      Promise.resolve(this.record('company.count', arg, 4)),
  };

  jobPosting = {
    count: (arg: unknown) =>
      Promise.resolve(this.record('jobPosting.count', arg, 9)),
  };

  sourceRun = {
    groupBy: (arg: unknown) =>
      Promise.resolve(
        this.record('sourceRun.groupBy', arg, [
          {
            source: 'greenhouse',
            _sum: {
              companiesTried: 20,
              postingsSeen: 40,
              postingsNew: 9,
              errors: 0,
            },
          },
        ]),
      ),
    findFirst: (arg: unknown) =>
      Promise.resolve(
        this.record('sourceRun.findFirst', arg, {
          startedAt: new Date('2026-09-07T00:30:00.000Z'),
        }),
      ),
  };
}

function make(seed: Seed = {}) {
  const prisma = new FakePrisma(seed);
  const service = new DigestService(prisma as unknown as PrismaService);
  return { prisma, service };
}

/** A stored payload from the previous morning, generated at `at`. */
function previousPayload(at: string) {
  return {
    version: 1,
    day: '2026-09-07',
    generatedAt: at,
    since: '2026-09-06T03:30:00.000Z',
    candidate: {
      newMatches: 0,
      byVerdict: {},
      undecided: 0,
      top: [],
      tailored: 0,
      guardFailed: 0,
      guardFailureRate: null,
      preparedWaiting: 0,
      submitted: 0,
      missingAnswers: [],
    },
    system: null,
  };
}

describe('DigestService.build', () => {
  it('names the digest after the IST day, not the server day', async () => {
    const { prisma, service } = make();

    const built = await service.build(USER, NOW);

    // 20:30 UTC on the 7th is 02:00 IST on the 8th. A digest dated the 7th here would
    // collide with the one the previous morning already wrote.
    expect(built.day).toBe('2026-09-08');
    expect(prisma.where('dailyDigest.upsert')).toEqual({
      userId_day: { userId: USER, day: new Date('2026-09-08T00:00:00.000Z') },
    });
  });

  it('writes a payload this version can read back', async () => {
    const { service } = make({
      newMatches: 9,
      undecided: 4,
      top: [score({ salary: '32.50' })],
      verdicts: [{ verdict: MatchVerdict.STRONG, _count: { _all: 2 } }],
    });

    const built = await service.build(USER, NOW);

    // Parsed with the real schema rather than compared field by field: the payload
    // crosses a Json column, and "can the reader read it" is the property that matters.
    expect(DigestPayloadSchema.safeParse(built.payload).success).toBe(true);
    expect(built.payload.candidate.byVerdict).toEqual({ STRONG: 2 });
    expect(built.payload.candidate.top[0].salaryLpa).toBe('32.5');
  });

  it('rewrites the payload without touching the delivery stamps', async () => {
    const { prisma, service } = make({
      emailedAt: new Date('2026-09-08T03:30:00.000Z'),
    });

    const built = await service.build(USER, NOW);

    const call = prisma.args['dailyDigest.upsert'][0] as {
      update: Record<string, unknown>;
    };
    // An email that has gone out cannot be unsent. If the rewrite cleared these, a
    // worker restarting in a loop would mail the same morning on every attempt.
    expect(Object.keys(call.update)).toEqual(['payload']);
    expect(built.alreadyEmailed).toBe(true);
  });

  it('reports alreadyEmailed false when nothing has been mailed yet', async () => {
    const { service } = make({ emailedAt: null });
    expect((await service.build(USER, NOW)).alreadyEmailed).toBe(false);
  });

  it('refuses to build for a user that does not exist', async () => {
    const prisma = new FakePrisma();
    prisma.user.findUnique = () =>
      Promise.resolve(null as unknown as { role: Role });
    const service = new DigestService(prisma as unknown as PrismaService);

    await expect(service.build(USER, NOW)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('DigestService window', () => {
  it('counts from the previous digest, so a missed morning is absorbed', async () => {
    const generatedAt = '2026-09-05T03:30:00.000Z';
    const { prisma, service } = make({
      previous: {
        payload: previousPayload(generatedAt),
        createdAt: new Date(generatedAt),
      },
    });

    const built = await service.build(USER, NOW);

    // Three days of postings, reported once, by the next digest to run. A fixed 24-hour
    // window would have counted the 6th and the 7th as new on days when nothing was
    // sent, and then never again.
    expect(built.payload.since).toBe(generatedAt);
    expect(prisma.where('newMatches')).toMatchObject({
      scoredAt: { gte: new Date(generatedAt) },
    });
  });

  it('falls back to 24 hours for a first-ever digest', async () => {
    const { service } = make({ previous: null });

    const built = await service.build(USER, NOW);

    expect(built.payload.since).toBe(
      new Date(NOW.getTime() - 86_400_000).toISOString(),
    );
  });

  it('falls back to 24 hours when the previous stamp is in the future', async () => {
    const { service } = make({
      previous: {
        payload: previousPayload('2027-01-01T00:00:00.000Z'),
        createdAt: new Date('2027-01-01T00:00:00.000Z'),
      },
    });

    const built = await service.build(USER, NOW);

    // A window that ends before it starts makes every count zero, which reads as a
    // quiet day rather than as the broken clock it is.
    expect(built.payload.since).toBe(
      new Date(NOW.getTime() - 86_400_000).toISOString(),
    );
  });

  it("uses the previous row's createdAt when its payload cannot be read", async () => {
    const createdAt = new Date('2026-09-06T03:31:00.000Z');
    const { service } = make({
      previous: { payload: { version: 99, nonsense: true }, createdAt },
    });

    const built = await service.build(USER, NOW);

    expect(built.payload.since).toBe(createdAt.toISOString());
  });

  it('looks only at days before today for the anchor', async () => {
    const { prisma, service } = make();

    await service.build(USER, NOW);

    // Today's own row is what this run is about to write. Anchoring to it would make
    // the window empty on every re-run.
    expect(prisma.where('dailyDigest.findFirst')).toMatchObject({
      userId: USER,
      day: { lt: new Date('2026-09-08T00:00:00.000Z') },
    });
  });
});

describe('DigestService candidate numbers', () => {
  it('reports no failure rate at all when nothing was tailored', async () => {
    const { service } = make({ tailored: 0, guardFailed: 0 });

    const built = await service.build(USER, NOW);

    // Not 0. A week of quiet days would otherwise read as a perfect guard record.
    expect(built.payload.candidate.guardFailureRate).toBeNull();
  });

  it('reports the rate when resumes were written', async () => {
    const { service } = make({ tailored: 4, guardFailed: 1 });
    expect(
      (await service.build(USER, NOW)).payload.candidate.guardFailureRate,
    ).toBe(0.25);
  });

  it('asks for a decision only about open postings nobody has decided on', async () => {
    const { prisma, service } = make();

    await service.build(USER, NOW);

    for (const name of ['undecided', 'matchScore.findMany']) {
      expect(prisma.where(name)).toMatchObject({
        userId: USER,
        decision: MatchDecision.UNDECIDED,
        verdict: {
          in: [MatchVerdict.STRONG, MatchVerdict.GOOD, MatchVerdict.BORDERLINE],
        },
        job: { closedAt: null },
      });
    }
  });

  it("counts every form waiting to be sent, not only this window's", async () => {
    const { prisma, service } = make({ preparedWaiting: 2 });

    await service.build(USER, NOW);

    // A form filled in on Tuesday and still unsent on Friday is still waiting, and
    // dropping it out of the digest is how it gets forgotten.
    expect(prisma.where('preparedWaiting')).toEqual({
      userId: USER,
      status: ApplicationStatus.PREPARED,
    });
  });
});

describe('DigestService system section', () => {
  it('is absent for a plain candidate', async () => {
    const { prisma, service } = make({ role: Role.USER });

    const built = await service.build(USER, NOW);

    expect(built.payload.system).toBeNull();
    // Not merely hidden - the queries are not run at all, because a candidate cannot act
    // on board yield and it is not their business what the operator's machine is doing.
    expect(prisma.calls).not.toContain('sourceRun.groupBy');
  });

  it('reports boards and calls-by-model for an admin', async () => {
    const { service } = make({ role: Role.ADMIN });

    const built = await service.build(USER, NOW);

    expect(built.payload.system).toMatchObject({
      newCompanies: 4,
      newPostings: 9,
      boards: [{ source: 'greenhouse', postingsNew: 9 }],
      lastDiscoveryAt: '2026-09-07T00:30:00.000Z',
    });
    // Calls, not tokens - token counts are never persisted. See DigestSystem.modelUse.
    expect(built.payload.system?.modelUse).toEqual([
      { model: 'claude-haiku-4-5', calls: 12 },
      { model: 'claude-opus-5', calls: 3 },
    ]);
  });
});

describe('DigestService.decide', () => {
  it('scopes the update by user and stamps when it was decided', async () => {
    const { prisma, service } = make();

    await service.decide(USER, 'job-9', MatchDecision.NOT_WANTED);

    const call = prisma.args['matchScore.updateMany'][0] as {
      where: Record<string, unknown>;
      data: { decision: MatchDecision; decidedAt: Date | null };
    };
    // userId in the WHERE, not checked afterwards: deciding on somebody else's score has
    // to be unexpressible rather than merely refused.
    expect(call.where).toEqual({ userId: USER, jobId: 'job-9' });
    expect(call.data.decision).toBe(MatchDecision.NOT_WANTED);
    expect(call.data.decidedAt).toBeInstanceOf(Date);
  });

  it('clears the stamp when the decision is taken back', async () => {
    const { prisma, service } = make();

    await service.decide(USER, 'job-9', MatchDecision.UNDECIDED);

    const call = prisma.args['matchScore.updateMany'][0] as {
      data: { decidedAt: Date | null };
    };
    // "Decided at" must not outlive the decision it refers to.
    expect(call.data.decidedAt).toBeNull();
  });

  it('refuses when the posting was never scored for this candidate', async () => {
    const { service } = make({ updateManyCount: 0 });

    await expect(
      service.decide(USER, 'job-nobody-scored', MatchDecision.WANTED),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('DigestService reads', () => {
  it('returns a null payload rather than throwing on a row it cannot read', async () => {
    const prisma = new FakePrisma();
    prisma.dailyDigest.findFirst = () =>
      Promise.resolve({
        id: 'digest-old',
        day: new Date('2026-08-01T00:00:00.000Z'),
        payload: { version: 42 },
        emailedAt: null,
        telegramAt: null,
        deliveryError: null,
        readAt: null,
        createdAt: new Date('2026-08-01T03:30:00.000Z'),
      } as never);
    const service = new DigestService(prisma as unknown as PrismaService);

    const row = await service.latest(USER);

    // One unreadable card in a list must not take down the request that was fetching a
    // fortnight of them.
    expect(row?.payload).toBeNull();
    expect(row?.day).toBe('2026-08-01');
  });

  it('scopes one() by user id in the query', async () => {
    const prisma = new FakePrisma();
    prisma.dailyDigest.findFirst = (arg: unknown) => {
      (prisma.args['one'] ??= []).push(arg);
      return Promise.resolve(null);
    };
    const service = new DigestService(prisma as unknown as PrismaService);

    await expect(service.one(USER, 'digest-x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect((prisma.args['one'][0] as { where: unknown }).where).toEqual({
      id: 'digest-x',
      userId: USER,
    });
  });

  it('marks read only once', async () => {
    const { prisma, service } = make();

    await service.markRead(USER, 'digest-1');

    // `readAt: null` in the filter: the first open is the one that counts, so a second
    // visit does not move the timestamp.
    expect(prisma.where('dailyDigest.updateMany')).toEqual({
      id: 'digest-1',
      userId: USER,
      readAt: null,
    });
  });

  it('builds for candidates with a selected resume only', async () => {
    const { prisma, service } = make();

    expect(await service.recipients()).toEqual([
      { id: USER, email: 'a@example.com', name: 'A' },
    ]);
    // isActive, not merely confirmed. Mailing a report of zeros every morning describes
    // the symptom of an unselected resume while hiding the cause.
    expect(prisma.where('candidateProfile.findMany')).toEqual({
      confirmedAt: { not: null },
      isActive: true,
      user: { active: true },
    });
  });
});

describe('recordDelivery', () => {
  it('stamps the channel and clears the last error on success', async () => {
    const { prisma, service } = make();

    await service.recordDelivery('digest-1', 'email', null);

    const call = prisma.args['dailyDigest.update'][0] as {
      data: { emailedAt?: Date; deliveryError: string | null };
    };
    expect(call.data.emailedAt).toBeInstanceOf(Date);
    expect(call.data.deliveryError).toBeNull();
  });

  it('records the failure with the channel that produced it', async () => {
    const { prisma, service } = make();

    await service.recordDelivery('digest-1', 'telegram', 'chat not found');

    const call = prisma.args['dailyDigest.update'][0] as {
      data: { deliveryError: string };
    };
    expect(call.data.deliveryError).toBe('telegram: chat not found');
  });

  it('truncates a long failure rather than storing an essay', async () => {
    const { prisma, service } = make();

    await service.recordDelivery('digest-1', 'email', 'x'.repeat(900));

    const call = prisma.args['dailyDigest.update'][0] as {
      data: { deliveryError: string };
    };
    expect(call.data.deliveryError).toHaveLength(500);
  });
});

describe('deadBoards', () => {
  const board = (over: Partial<Parameters<typeof deadBoards>[0][0]>) => ({
    source: 'greenhouse',
    companiesTried: 10,
    postingsSeen: 30,
    postingsNew: 2,
    errors: 0,
    ...over,
  });

  it('reports a board that read nothing at all', () => {
    expect(deadBoards([board({ postingsSeen: 0, postingsNew: 0 })])).toEqual([
      {
        source: 'greenhouse',
        reason: 'tried 10 board(s) and read no postings at all',
      },
    ]);
  });

  it('reports errors with nothing new', () => {
    expect(deadBoards([board({ errors: 3, postingsNew: 0 })])).toEqual([
      { source: 'greenhouse', reason: '3 error(s) and nothing new' },
    ]);
  });

  it('says nothing about a quiet board that is working', () => {
    // Postings read, none of them new, no errors: that is a small employer who did not
    // post anything today. Calling it dead would train the reader to ignore the section.
    expect(deadBoards([board({ postingsNew: 0 })])).toEqual([]);
  });

  it('says nothing about a board that was not tried', () => {
    expect(
      deadBoards([
        board({ companiesTried: 0, postingsSeen: 0, postingsNew: 0 }),
      ]),
    ).toEqual([]);
  });
});

describe('missingAnswers', () => {
  it('names all four when the candidate has never filled the form in', () => {
    expect(missingAnswers(null)).toEqual([
      'work authorisation',
      'whether you need sponsorship',
      'notice period',
      'expected CTC',
    ]);
  });

  it('treats "no, I do not need sponsorship" as an answer', () => {
    const missing = missingAnswers({
      workAuthorization: 'Indian citizen',
      needsSponsorship: false,
      noticePeriodDays: 60,
      expectedCtcLpa: new Prisma.Decimal('32.00'),
    });

    // `false` is a real answer. A falsy check here would ask the candidate every morning
    // to fill in something they had already filled in.
    expect(missing).toEqual([]);
  });

  it('asks in the words the form uses, not the column names', () => {
    const missing = missingAnswers({
      workAuthorization: null,
      needsSponsorship: null,
      noticePeriodDays: null,
      expectedCtcLpa: null,
    });

    expect(missing).toContain('whether you need sponsorship');
    expect(missing.join(' ')).not.toContain('needsSponsorship');
  });
});

describe('istDay and dayValue', () => {
  it('gives the Indian calendar day', () => {
    // 18:29 UTC is 23:59 IST the same day; one minute later it is tomorrow in India.
    expect(istDay(new Date('2026-09-07T18:29:00.000Z'))).toBe('2026-09-07');
    expect(istDay(new Date('2026-09-07T18:31:00.000Z'))).toBe('2026-09-08');
  });

  it('round-trips through a date-only column', () => {
    const day = istDay(NOW);
    // Midnight UTC, so formatting the stored value back cannot land on the day before.
    expect(dayValue(day).toISOString()).toBe('2026-09-08T00:00:00.000Z');
    expect(dayValue(day).toISOString().slice(0, 10)).toBe(day);
  });
});
