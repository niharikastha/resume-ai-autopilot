/**
 * Which adapter opens which URL.
 *
 * THE ONE THING WORTH TESTING HERE IS THE HOST PARSING, and it is worth testing because
 * the naive version is a regex over the whole URL - which matches
 * `https://evil.com/?redirect=jobs.lever.co` and hands that page the Lever adapter,
 * along with the candidate's phone number and their resume. The host is the only part
 * of a URL that says who is serving it.
 *
 * The name tables are not tested against these boards' real markup, and cannot be
 * without hitting them. What the tests below check is that they are wired to the right
 * hosts and that the fallback ordering holds; whether `first_name` is still
 * Greenhouse's field name is a fact about Greenhouse, and the run log's coverage
 * number is what reports it going stale.
 */
import { AtsType } from '@prisma/client';
import {
  AdapterRegistry,
  AshbyAdapter,
  boardAdapters,
  GenericAdapter,
  GreenhouseAdapter,
  LeverAdapter,
  SmartRecruitersAdapter,
  WorkableAdapter,
  WorkdayAdapter,
} from './board.adapters';
import type { PreparedApplication } from './ats.adapter';

const registry = () =>
  new AdapterRegistry(boardAdapters(), new GenericAdapter(undefined));

describe('picking an adapter by URL', () => {
  const cases: [string, AtsType][] = [
    ['https://job-boards.greenhouse.io/acme/jobs/4123456', AtsType.GREENHOUSE],
    ['https://boards.greenhouse.io/acme/jobs/4123456', AtsType.GREENHOUSE],
    ['https://jobs.lever.co/acme/1a2b3c/apply', AtsType.LEVER],
    ['https://jobs.ashbyhq.com/acme/1a2b3c/application', AtsType.ASHBY],
    [
      'https://jobs.smartrecruiters.com/Acme/744000-backend',
      AtsType.SMARTRECRUITERS,
    ],
    ['https://apply.workable.com/acme/j/ABC123/', AtsType.WORKABLE],
    ['https://acme.wd3.myworkdayjobs.com/en-US/careers/job/x', AtsType.WORKDAY],
    // An in-house careers page: nothing claims it, so the generic filler gets it.
    ['https://careers.acme.co.in/openings/backend-engineer', AtsType.CUSTOM],
  ];

  it.each(cases)('sends %s to the %s adapter', (url, atsType) => {
    expect(registry().for(url).atsType).toBe(atsType);
  });

  it('reads the host, not the whole URL', async () => {
    // The attack the parsing exists for. A page on any domain can put a board's
    // hostname in its query string; that does not make it that board's form, and
    // handing it a tier-1 adapter is handing it a name map for fields it controls.
    const adapter = registry().for(
      'https://evil.example.com/?next=jobs.lever.co/acme',
    );

    expect(adapter.atsType).toBe(AtsType.CUSTOM);
    // And a suffix that merely ENDS in the board's name is not the board either.
    expect(registry().for('https://notlever.co/acme/apply').atsType).toBe(
      AtsType.CUSTOM,
    );
    expect(registry().for('https://greenhouse.io.evil.com/x').atsType).toBe(
      AtsType.CUSTOM,
    );
    await Promise.resolve();
  });

  it('refuses a file:// or javascript: URL', () => {
    // `new URL` parses both happily. Neither is a job application, and a file:// page
    // handed a form filler is a way to read the local disk into a text box.
    expect(new GreenhouseAdapter().canHandle('file:///etc/passwd')).toBe(false);
    expect(new LeverAdapter().canHandle('javascript:alert(1)')).toBe(false);
    expect(new AshbyAdapter().canHandle('not a url at all')).toBe(false);
  });

  it('matches the host case-insensitively', () => {
    expect(
      new SmartRecruitersAdapter().canHandle(
        'https://JOBS.SmartRecruiters.COM/x',
      ),
    ).toBe(true);
    expect(
      new WorkableAdapter().canHandle('https://Apply.Workable.com/x'),
    ).toBe(true);
  });
});

describe('Workday, which is dropped on purpose', () => {
  it('recognises the host and declines instead of half-filling it', async () => {
    // A Workday URL reaching the generic filler would fill page one of a six-page
    // wizard and report coverage for it, which reads as progress. Naming the refusal
    // says the true thing: this one is a manual link.
    const result = await new WorkdayAdapter().prefill();

    expect(result.requiredTotal).toBe(0);
    expect(result.fields).toEqual([]);
    expect(result.needsHuman).toEqual([
      expect.stringContaining('not automated'),
    ]);
  });
});

describe('the registry', () => {
  it('does not reach the generic adapter while a specific one matches', () => {
    // GenericAdapter.canHandle returns true unconditionally, so it is kept OUT of the
    // list and passed as the fallback - if it were ever reordered into the middle of
    // the array it would shadow every adapter after it.
    const generic = new GenericAdapter(undefined);
    const list = new AdapterRegistry(
      [new GreenhouseAdapter(), new LeverAdapter()],
      generic,
    );

    expect(list.for('https://jobs.lever.co/acme/1/apply')).toBeInstanceOf(
      LeverAdapter,
    );
    expect(list.for('https://jobs.ashbyhq.com/acme/1')).toBe(generic);
  });
});

/** Unused by these tests, but it documents the shape an adapter is called with. */
export const EXAMPLE: PreparedApplication = {
  applicationId: 'app-1',
  jobId: 'job-1',
  applyUrl: 'https://jobs.lever.co/acme/1/apply',
  title: 'Backend Engineer',
  company: 'Acme',
  answers: {
    profile: {
      fullName: 'Astha Niharika',
      email: 'astha@example.com',
      phone: null,
      location: null,
      linkedIn: null,
      github: null,
      portfolio: null,
    },
    stated: {
      workAuthorization: null,
      needsSponsorship: null,
      noticePeriodDays: null,
      currentCtcLpa: null,
      expectedCtcLpa: null,
      willingToRelocate: null,
      earliestStartDate: null,
      customAnswers: {},
    },
    resumePath: null,
    coverLetter: null,
  },
  screenshotPath: null,
};
