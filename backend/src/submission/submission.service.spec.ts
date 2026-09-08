/**
 * The queue, the claim, and the confirmation.
 *
 * THE THREE THINGS WORTH TESTING, all of them about what does NOT happen:
 *
 *   1. An application is not offered twice, and is not offered to a company that was
 *      applied to last week. Both caps exist because the cost of breaking them lands
 *      on a real recruiter's inbox, and neither is visible from the output of a run
 *      that broke them.
 *   2. The Application row exists BEFORE the browser opens. A crash mid-form has to
 *      leave a trace, or the next session opens the same form believing it is new.
 *   3. SUBMITTED is written only on evidence from the page. That row is what stops this
 *      system ever offering the role again.
 *
 * WHAT IS FAKED. Prisma, so there is no database and therefore no coverage of the
 * unique index itself - the index is the real duplicate guard and it is enforced in
 * Postgres. What these tests check is the code above it: that the query is built with
 * the right filter, and that the row is written at the right moment. The browser is
 * faked too, so nothing here opens Chrome.
 */
import { ApplicationStatus, AtsType } from '@prisma/client';
import { SubmissionError, SubmissionService } from './submission.service';
import { AdapterRegistry } from './board.adapters';
import type { AtsAdapter, PrefillResult } from './ats.adapter';
import type { PrismaService } from '../prisma/prisma.service';
import type { BrowserService } from './browser.service';
import type { ConfigService } from '@nestjs/config';

const USER = 'user-1';

const PROFILE = {
  fullName: 'Astha Niharika',
  email: 'astha@example.com',
  phone: '+91 90000 00000',
  location: 'Bhubaneswar, India',
  linkedIn: null,
  github: null,
  portfolio: null,
};

/** One tailored variant, with the posting it was written for. */
function variant(over: {
  id?: string;
  jobId?: string;
  companyId?: string | null;
  company?: string;
  title?: string;
  createdAt?: Date;
}) {
  const jobId = over.jobId ?? 'job-1';
  const title = over.title ?? 'Backend Engineer';
  return {
    id: over.id ?? 'variant-1',
    jobId,
    pdfPath: '.artifacts/resumes/Astha_Acme_Backend.pdf',
    docxPath: '.artifacts/resumes/Astha_Acme_Backend.docx',
    coverLetter: 'Dear Acme,',
    createdAt: over.createdAt ?? new Date('2026-09-07T09:00:00Z'),
    job: {
      id: jobId,
      title,
      normalizedTitle: title.toLowerCase(),
      applyUrl: `https://jobs.lever.co/acme/${jobId}/apply`,
      atsType: AtsType.LEVER,
      companyId: over.companyId === undefined ? 'company-1' : over.companyId,
      closedAt: null,
      company: { name: over.company ?? 'Acme' },
    },
  };
}

interface Seed {
  variants?: ReturnType<typeof variant>[];
  scores?: { jobId: string; score: number }[];
  /** Rows returned for the "already dealt with" query. */
  existing?: { jobId: string; status: ApplicationStatus }[];
  /** Rows returned for the cooldown query. */
  submitted?: { companyId: string }[];
  profiles?: { id: string; userId: string; label: string; isActive: boolean }[];
}

class FakePrisma {
  readonly calls: string[] = [];
  readonly args: Record<string, unknown[]> = {};

  constructor(private readonly seed: Seed) {}

  private record(name: string, arg: unknown) {
    this.calls.push(name);
    (this.args[name] ??= []).push(arg);
  }

  readonly candidateProfile = {
    findMany: (arg: unknown) => {
      this.record('candidateProfile.findMany', arg);
      return Promise.resolve(
        this.seed.profiles ?? [
          { id: 'profile-1', userId: USER, label: 'primary', isActive: true },
        ],
      );
    },
    findFirst: (arg: unknown) => {
      this.record('candidateProfile.findFirst', arg);
      return Promise.resolve(PROFILE);
    },
  };

  readonly resumeVariant = {
    findMany: (arg: unknown) => {
      this.record('resumeVariant.findMany', arg);
      return Promise.resolve(this.seed.variants ?? []);
    },
  };

  readonly matchScore = {
    findMany: (arg: unknown) => {
      this.record('matchScore.findMany', arg);
      return Promise.resolve(this.seed.scores ?? []);
    },
  };

  readonly applicationAnswers = {
    findUnique: (arg: unknown) => {
      this.record('applicationAnswers.findUnique', arg);
      return Promise.resolve(null);
    },
  };

  readonly application = {
    findMany: (arg: unknown) => {
      const where = (
        arg as { where: { status?: unknown; submittedAt?: unknown } }
      ).where;
      // The service asks two different questions of this table. Distinguished by the
      // cooldown query's date filter, which is the only thing that differs.
      if (where.submittedAt) {
        this.record('application.findMany:cooldown', arg);
        return Promise.resolve(this.seed.submitted ?? []);
      }
      this.record('application.findMany:existing', arg);
      return Promise.resolve(this.seed.existing ?? []);
    },
    upsert: (arg: unknown) => {
      this.record('application.upsert', arg);
      return Promise.resolve({ id: 'app-1' });
    },
    update: (arg: unknown) => {
      this.record('application.update', arg);
      return Promise.resolve({ id: 'app-1' });
    },
  };
}

/** Records what the adapter was handed, and returns a fixed prefill. */
class FakeAdapter implements AtsAdapter {
  readonly atsType = AtsType.LEVER;
  called = 0;
  /** Set to throw, to exercise the FAILED path. */
  breaks = false;

  canHandle(): boolean {
    return true;
  }

  prefill(): Promise<PrefillResult> {
    this.called++;
    if (this.breaks) return Promise.reject(new Error('the form never loaded'));
    return Promise.resolve({
      requiredTotal: 4,
      requiredFilled: 3,
      fields: [],
      needsHuman: ['Expected CTC - needs your answer'],
      screenshotPath: '/tmp/app-1.png',
    });
  }
}

class FakeBrowser {
  visited: string[] = [];
  pageText = 'Your application has been received.';

  visit(url: string) {
    this.visited.push(url);
    return Promise.resolve({
      page: {} as never,
      raw: { innerText: () => Promise.resolve(this.pageText) } as never,
    });
  }
}

function build(seed: Seed = {}) {
  const prisma = new FakePrisma(seed);
  const browser = new FakeBrowser();
  const adapter = new FakeAdapter();
  const config = { get: () => undefined } as unknown as ConfigService;
  const service = new SubmissionService(
    prisma as unknown as PrismaService,
    config,
    browser as unknown as BrowserService,
    new AdapterRegistry([adapter], adapter),
  );
  return { service, prisma, browser, adapter };
}

describe('planning a session', () => {
  it('asks only for variants that passed the provenance guard on live postings', async () => {
    const { service, prisma } = build();

    await service.plan();

    // Asserted on the query the service BUILT, because the fake returns whatever it is
    // seeded with. A variant that failed the guard was rendered from the base resume,
    // and sending that under a filename and cover letter written for this company is
    // the thing this filter prevents.
    expect(prisma.args['resumeVariant.findMany'][0]).toMatchObject({
      where: { guardPassed: true, job: { closedAt: null } },
    });
  });

  it('orders by score, best first', async () => {
    const { service } = build({
      variants: [
        variant({ id: 'v1', jobId: 'job-1', companyId: 'c1', company: 'Acme' }),
        variant({
          id: 'v2',
          jobId: 'job-2',
          companyId: 'c2',
          company: 'Globex',
        }),
      ],
      scores: [
        { jobId: 'job-1', score: 71 },
        { jobId: 'job-2', score: 88 },
      ],
    });

    const plan = await service.plan();

    expect(plan.items.map((item) => item.jobId)).toEqual(['job-2', 'job-1']);
  });

  it('leaves out a posting already submitted or rejected', async () => {
    const { service } = build({
      variants: [variant({ jobId: 'job-1' })],
      existing: [{ jobId: 'job-1', status: ApplicationStatus.SUBMITTED }],
    });

    const plan = await service.plan();

    expect(plan.items).toEqual([]);
    expect(plan.skipped[0].reason).toMatch(/already submitted/);
  });

  it('re-offers a form that was prepared and never sent', async () => {
    // The query has to EXCLUDE only the finished statuses. A form the candidate opened
    // and did not submit is exactly what the next session should open again, and the
    // first version of this filter excluded every application row that existed.
    const { service, prisma } = build({ variants: [variant({})] });

    const plan = await service.plan();

    expect(
      (
        prisma.args['application.findMany:existing'][0] as {
          where: { status: { in: ApplicationStatus[] } };
        }
      ).where.status.in,
    ).toEqual([
      ApplicationStatus.SUBMITTED,
      ApplicationStatus.REJECTED,
      ApplicationStatus.SKIPPED,
    ]);
    expect(plan.items).toHaveLength(1);
  });

  it('respects the per-company cooldown', async () => {
    const { service } = build({
      variants: [variant({ companyId: 'company-1', company: 'Acme' })],
      submitted: [{ companyId: 'company-1' }],
    });

    const plan = await service.plan();

    expect(plan.items).toEqual([]);
    expect(plan.skipped[0].reason).toMatch(/within the last 14 days/);
  });

  it('counts the cooldown from submitted applications, not from prepared ones', async () => {
    // Settled here, having been left as a note in tailoring.service.ts: a form that was
    // opened and never sent cost the employer nothing and must not use up the window.
    const { service, prisma } = build({ variants: [variant({})] });

    await service.plan();

    expect(prisma.args['application.findMany:cooldown'][0]).toMatchObject({
      where: { status: ApplicationStatus.SUBMITTED },
    });
  });

  it('takes one role per company per session', async () => {
    const { service } = build({
      variants: [
        variant({
          id: 'v1',
          jobId: 'job-1',
          companyId: 'c1',
          title: 'Backend Engineer',
        }),
        variant({
          id: 'v2',
          jobId: 'job-2',
          companyId: 'c1',
          title: 'Platform Engineer',
        }),
      ],
      scores: [
        { jobId: 'job-1', score: 90 },
        { jobId: 'job-2', score: 80 },
      ],
    });

    const plan = await service.plan();

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].jobId).toBe('job-1');
    expect(plan.skipped[0].reason).toMatch(/already in this session/);
  });

  it('applies the daily cap', async () => {
    const { service } = build({
      variants: [
        variant({ id: 'v1', jobId: 'job-1', companyId: 'c1' }),
        variant({ id: 'v2', jobId: 'job-2', companyId: 'c2' }),
        variant({ id: 'v3', jobId: 'job-3', companyId: 'c3' }),
      ],
    });

    const plan = await service.plan({ limit: 2 });

    expect(plan.items).toHaveLength(2);
    expect(plan.skipped[0].reason).toMatch(/over the daily cap of 2/);
  });

  it('queues a posting once even after it was re-tailored', async () => {
    const { service } = build({
      variants: [
        variant({
          id: 'new',
          jobId: 'job-1',
          createdAt: new Date('2026-09-07'),
        }),
        variant({
          id: 'old',
          jobId: 'job-1',
          createdAt: new Date('2026-09-01'),
        }),
      ],
    });

    const plan = await service.plan();

    expect(plan.items).toHaveLength(1);
    // The newest, which is the resume about to be attached. `orderBy createdAt desc` in
    // the query is what makes that the first one seen.
    expect(plan.items[0].variantId).toBe('new');
  });

  it('will not queue a posting whose company was never resolved', async () => {
    // Application.companyId is required, and it is required because the duplicate index
    // is built on it. A posting that cannot be tracked is not applied to through here.
    const { service } = build({ variants: [variant({ companyId: null })] });

    const plan = await service.plan();

    expect(plan.items).toEqual([]);
    expect(plan.skipped[0].reason).toMatch(/no company on record/);
  });

  it('makes the resume path absolute', async () => {
    // The browser process resolves a file path against its own working directory, not
    // against this one, so a relative path attaches nothing.
    const { service } = build({ variants: [variant({})] });

    const plan = await service.plan();

    expect(plan.items[0].resumePath).toMatch(/^\/.*Astha_Acme_Backend\.pdf$/);
  });
});

describe('choosing whose resume to use', () => {
  it('refuses when several resumes exist and none is selected', async () => {
    const { service } = build({
      profiles: [
        { id: 'p1', userId: USER, label: 'primary', isActive: false },
        { id: 'p2', userId: USER, label: 'data', isActive: false },
      ],
    });

    await expect(service.plan()).rejects.toThrow(/none is selected/);
  });

  it('refuses to guess between two candidates', async () => {
    // Typing one candidate's phone number into a form headed with another's name is not
    // a mistake that announces itself.
    const { service } = build({
      profiles: [
        { id: 'p1', userId: USER, label: 'primary', isActive: true },
        { id: 'p2', userId: 'user-2', label: 'primary', isActive: true },
      ],
    });

    await expect(service.plan()).rejects.toThrow(
      /2 candidates have a selected resume/,
    );
  });

  it('refuses when there is no confirmed profile at all', async () => {
    const { service } = build({ profiles: [] });

    await expect(service.plan()).rejects.toThrow(SubmissionError);
  });
});

describe('preparing one application', () => {
  const planned = {
    jobId: 'job-1',
    companyId: 'company-1',
    company: 'Acme',
    title: 'Backend Engineer',
    normalizedTitle: 'backend engineer',
    applyUrl: 'https://jobs.lever.co/acme/job-1/apply',
    atsType: AtsType.LEVER,
    variantId: 'variant-1',
    resumePath: '/tmp/resume.pdf',
    coverLetter: 'Dear Acme,',
    score: 88,
  };

  it('claims the row before the browser opens', async () => {
    // The ordering that makes a crash mid-form visible. Created afterwards, a failed
    // attempt would leave nothing behind and the next run would treat it as new.
    const { service, prisma, browser } = build();

    await service.prepare(USER, planned);

    expect(prisma.calls.indexOf('application.upsert')).toBeLessThan(
      prisma.calls.indexOf('application.update'),
    );
    expect(browser.visited).toEqual([planned.applyUrl]);
  });

  it('claims it on the duplicate key, not by searching first', async () => {
    const { service, prisma } = build();

    await service.prepare(USER, planned);

    expect(prisma.args['application.upsert'][0]).toMatchObject({
      where: {
        userId_companyId_normalizedTitle: {
          userId: USER,
          companyId: 'company-1',
          normalizedTitle: 'backend engineer',
        },
      },
      create: {
        status: ApplicationStatus.QUEUED,
        resumeVariantId: 'variant-1',
      },
      update: { resumeVariantId: 'variant-1' },
    });
  });

  it('records coverage and the screenshot, and leaves the row PREPARED', async () => {
    // PREPARED means "waiting for a human", which is where most rows stay. Nothing in
    // this method can produce SUBMITTED.
    const { service, prisma } = build();

    const result = await service.prepare(USER, planned);

    expect(result.coverage).toBe(0.75);
    expect(prisma.args['application.update'][0]).toMatchObject({
      data: {
        status: ApplicationStatus.PREPARED,
        prefillCoverage: 0.75,
        screenshotPath: '/tmp/app-1.png',
        failureReason: null,
      },
    });
  });

  it('marks the row FAILED with the reason when the form will not load', async () => {
    const { service, prisma, adapter } = build();
    adapter.breaks = true;

    await expect(service.prepare(USER, planned)).rejects.toThrow(
      /the form never loaded/,
    );

    expect(prisma.args['application.update'][0]).toMatchObject({
      data: {
        status: ApplicationStatus.FAILED,
        failureReason: 'the form never loaded',
      },
    });
  });
});

describe('recording a submission', () => {
  const planned = {
    jobId: 'job-1',
    companyId: 'company-1',
    company: 'Acme',
    title: 'Backend Engineer',
    normalizedTitle: 'backend engineer',
    applyUrl: 'https://jobs.lever.co/acme/job-1/apply',
    atsType: AtsType.LEVER,
    variantId: 'variant-1',
    resumePath: '/tmp/resume.pdf',
    coverLetter: null,
    score: 88,
  };

  it('writes SUBMITTED when the page confirms, and stores the sentence', async () => {
    const { service, prisma } = build();

    const result = await service.confirm(
      'app-1',
      'Your application has been received.',
    );

    expect(result).toEqual({
      submitted: true,
      confirmationText: 'Your application has been received.',
    });
    expect(prisma.args['application.update'][0]).toMatchObject({
      data: {
        status: ApplicationStatus.SUBMITTED,
        confirmationText: 'Your application has been received.',
      },
    });
  });

  it('writes nothing at all when the page does not confirm', async () => {
    // Never optimistically. The human pressing a key in the terminal is not evidence
    // the employer received anything, and the row that says SUBMITTED is the row that
    // stops this system offering the role again.
    const { service, prisma } = build();

    const result = await service.confirm(
      'app-1',
      'Review your application before submitting.',
    );

    expect(result).toEqual({ submitted: false, confirmationText: null });
    expect(prisma.calls).not.toContain('application.update');
  });

  it('reads the page after the human acted, not the form as it was filled', async () => {
    // `readPageText` is a closure and not a captured string, so the text it returns is
    // whatever page the human ended up on - which is the only place a confirmation can
    // appear.
    const { service, browser } = build();
    const ready = await service.prepare(USER, planned);

    browser.pageText = 'Thank you for applying to Acme.';

    expect(await ready.readPageText()).toBe('Thank you for applying to Acme.');
  });

  it('marks a skipped application without touching its status elsewhere', async () => {
    const { service, prisma } = build();

    await service.skip('app-1', 'not interested after reading the form');

    expect(prisma.args['application.update'][0]).toMatchObject({
      where: { id: 'app-1' },
      data: {
        status: ApplicationStatus.SKIPPED,
        failureReason: 'not interested after reading the form',
      },
    });
  });
});
