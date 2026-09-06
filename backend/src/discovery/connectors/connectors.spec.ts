/**
 * The connectors, run against payloads CAPTURED FROM THE LIVE APIs.
 *
 * The fixtures in __fixtures__ are real responses (groww on Greenhouse, zeta on
 * Lever, a Ramp posting on Ashby that actually states its pay), trimmed to one job
 * each. That matters more than it sounds: every bug worth catching in a connector is
 * a field-name or field-shape bug, and a hand-written fixture is written from the
 * same wrong assumption as the connector. Greenhouse's entity-escaped `content`,
 * Lever's `text`-not-`title`, its requirements living in `lists`, and Ashby putting
 * the equity component before the salary one were all found by reading real
 * responses - so they are asserted against real responses.
 *
 * The through-line of the whole file: descriptionText must be non-empty and must
 * contain the requirements. An empty or blurb-only description is the exact failure
 * that left 4,765 seeded rows unusable, and it is invisible unless something checks.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { RemoteType, SalaryPeriod } from '@prisma/client';
import { AshbyConnector } from './ashby.connector';
import { GreenhouseConnector } from './greenhouse.connector';
import { LeverConnector } from './lever.connector';
import { SmartRecruitersConnector } from './smartrecruiters.connector';
import { connectorFor, connectorForAts, CONNECTORS } from './index';

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(__dirname, '__fixtures__', `${name}.json`), 'utf8'),
  ) as unknown;
}

describe('GreenhouseConnector', () => {
  const connector = new GreenhouseConnector();

  it('asks for content, without which the whole connector is pointless', () => {
    expect(connector.listUrl('groww')).toBe(
      'https://boards-api.greenhouse.io/v1/boards/groww/jobs?content=true',
    );
  });

  it('percent-encodes the token rather than interpolating it raw', () => {
    expect(connector.listUrl('a b/../c')).toBe(
      'https://boards-api.greenhouse.io/v1/boards/a%20b%2F..%2Fc/jobs?content=true',
    );
  });

  it('parses the captured board', () => {
    const [posting, ...rest] = connector.parse(fixture('greenhouse'), 'groww');
    expect(rest).toHaveLength(0);

    expect(posting.sourceJobId).toBe('4880153101');
    expect(posting.title).toBe('Associate - Content (Digest)');
    expect(posting.location).toBe('Bengaluru-VTP, India');
    expect(posting.remoteType).toBe(RemoteType.ONSITE);
    expect(posting.department).toBe('Growth');
  });

  it('produces readable text from the escaped content field', () => {
    // The assertion that would fail if decodeGreenhouseContent were dropped: the
    // text would still be non-empty, it would just be full of "&lt;div&gt;".
    const [posting] = connector.parse(fixture('greenhouse'), 'groww');
    expect(posting.descriptionText.length).toBeGreaterThan(200);
    expect(posting.descriptionText).toContain('About Groww');
    expect(posting.descriptionText).not.toContain('&lt;');
    expect(posting.descriptionText).not.toContain('<div>');
  });

  it('links to the posting, not the board', () => {
    const [posting] = connector.parse(fixture('greenhouse'), 'groww');
    expect(posting.applyUrl).toBe(
      'https://job-boards.eu.greenhouse.io/groww/jobs/4880153101',
    );
    expect(posting.applyUrl).toContain(posting.sourceJobId);
  });

  it('dates from first_published, not from the last recruiter edit', () => {
    // The fixture has both, three months apart. updated_at moves on a typo fix, so
    // reading it would make a June role look like an August one.
    const [posting] = connector.parse(fixture('greenhouse'), 'groww');
    expect(posting.postedAt?.toISOString()).toBe('2026-06-03T06:46:08.000Z');
  });

  it('reports no salary when the board states none', () => {
    // 99.7% of the Indian data. Inventing a range here is worse than a null.
    const [posting] = connector.parse(fixture('greenhouse'), 'groww');
    expect(posting.salary).toBeNull();
  });

  it('converts pay_input_ranges from CENTS', () => {
    // Read as major units this is a 2,000,000 salary reported as 200,000,000 - and
    // numeric(14,2) accepts it, so nothing downstream would catch it.
    const [posting] = connector.parse(
      {
        jobs: [
          {
            id: 1,
            title: 'Engineer',
            absolute_url: 'https://example.com/jobs/1',
            location: { name: 'Bengaluru, India' },
            content: '&lt;p&gt;Role&lt;/p&gt;',
            pay_input_ranges: [
              {
                min_cents: 200000000,
                max_cents: 400000000,
                currency_type: 'INR',
              },
            ],
          },
        ],
      },
      'x',
    );
    expect(posting.salary).toEqual({
      min: '2000000.00',
      max: '4000000.00',
      currency: 'INR',
      period: SalaryPeriod.YEAR,
    });
  });

  it('skips a posting with no title or no openable url', () => {
    const postings = connector.parse(
      {
        jobs: [
          { id: 1, title: '', absolute_url: 'https://example.com/1' },
          { id: 2, title: 'Engineer', absolute_url: '' },
          { id: 3, title: 'Engineer', absolute_url: 'javascript:alert(1)' },
          { title: 'No id', absolute_url: 'https://example.com/4' },
        ],
      },
      'x',
    );
    expect(postings).toHaveLength(0);
  });

  it('returns nothing for an error body instead of throwing', () => {
    expect(connector.parse({ error: 'Not found' }, 'x')).toEqual([]);
    expect(connector.parse(null, 'x')).toEqual([]);
    expect(connector.parse([], 'x')).toEqual([]);
  });
});

describe('LeverConnector', () => {
  const connector = new LeverConnector();

  it('parses the captured board', () => {
    const [posting, ...rest] = connector.parse(fixture('lever'), 'zeta');
    expect(rest).toHaveLength(0);

    expect(posting.sourceJobId).toBe('dad16204-8051-4517-9e50-966f329045b5');
    // `text`, not `title`. Reading `.title` gives undefined on every Lever posting,
    // and the connector would silently return zero results for the whole source.
    expect(posting.title).toBe('Cloud Network Engineer II');
    expect(posting.location).toBe('Hyderabad');
    expect(posting.remoteType).toBe(RemoteType.ONSITE);
    expect(posting.department).toBe('Global SRE');
    expect(posting.employmentType).toBe('Full-time');
  });

  it('includes the lists sections, where the requirements actually are', () => {
    // THE TRAP, asserted. "Cloudflare" and the AWS/Kubernetes line live in
    // `lists[].content` and appear nowhere in `descriptionPlain`, so a connector that
    // read the description field alone would pass every other test in this block
    // while feeding the matcher a marketing paragraph.
    const [posting] = connector.parse(fixture('lever'), 'zeta');
    expect(posting.descriptionText).toContain('Cloudflare');
    expect(posting.descriptionText).toContain('Kubernetes');
    expect(posting.descriptionText).toContain('Responsibilities:');
    expect(posting.descriptionText).toContain('Experience and Qualifications:');
  });

  it('keeps the EEO statement out of the scoring text but in the raw body', () => {
    // `additional` is Lever's equal-opportunity slot: identical on every posting a
    // company has, and dense with protected-characteristic language. It is kept
    // verbatim in descriptionRaw so nothing is lost, and withheld from the text the
    // model reads.
    const [posting] = connector.parse(fixture('lever'), 'zeta');
    expect(posting.descriptionRaw).toContain('equal opportunity');
    expect(posting.descriptionText).not.toContain('equal opportunity');
    expect(posting.descriptionText.toLowerCase()).not.toContain('veteran');
  });

  it('prefers the readable posting page over the apply form', () => {
    const [posting] = connector.parse(fixture('lever'), 'zeta');
    expect(posting.applyUrl).toBe(
      'https://jobs.lever.co/zeta/dad16204-8051-4517-9e50-966f329045b5',
    );
  });

  it('reads createdAt as epoch milliseconds', () => {
    const [posting] = connector.parse(fixture('lever'), 'zeta');
    expect(posting.postedAt?.getTime()).toBe(1787732026874);
  });

  it('treats the error OBJECT as an empty board, not a crash', () => {
    // A wrong token gets HTTP 200 with `{"ok": false, "error": ...}` where an array
    // is expected. This is why absence is judged by body content, never status code.
    expect(
      connector.parse({ ok: false, error: 'Account not found' }, 'x'),
    ).toEqual([]);
  });
});

describe('AshbyConnector', () => {
  const connector = new AshbyConnector();

  it('parses the captured board', () => {
    const [posting, ...rest] = connector.parse(fixture('ashby'), 'ramp');
    expect(rest).toHaveLength(0);

    expect(posting.sourceJobId).toBe('34413f8d-26bf-4bbc-8ade-eb309a0e2245');
    expect(posting.title).toBe('Security Engineer, Cloud');
    expect(posting.descriptionText).toContain('About Ramp');
    expect(posting.employmentType).toBe('FullTime');
    expect(posting.department).toBe('Engineering');
  });

  it('appends secondaryLocations, where the second office hides', () => {
    // Reading `location` alone would report this role as New York only. On Indian
    // boards the same field is where "Bengaluru" sits on a US-primary posting, and
    // dropping it filters out a job that was open here all along.
    const [posting] = connector.parse(fixture('ashby'), 'ramp');
    expect(posting.location).toBe(
      'New York, NY (HQ); Remote (Canada); Remote (US); Miami, FL',
    );
  });

  it('takes the SALARY component, not the equity one that comes first', () => {
    // components[0] on this real posting is
    // `{compensationType: 'EquityPercentage', minValue: null, interval: 'NONE'}`.
    // Read positionally it yields a salary with no figures - on precisely the
    // postings that do disclose pay.
    const [posting] = connector.parse(fixture('ashby'), 'ramp');
    expect(posting.salary).toEqual({
      min: '211400.00',
      max: '290600.00',
      currency: 'USD',
      period: SalaryPeriod.YEAR,
    });
  });

  it('reads hybrid from workplaceType even when isRemote is true', () => {
    // The fixture is both isRemote:true and workplaceType:'Hybrid'. Hybrid is the
    // narrower, truer claim.
    const [posting] = connector.parse(fixture('ashby'), 'ramp');
    expect(posting.remoteType).toBe(RemoteType.HYBRID);
  });

  it('skips an unpublished posting', () => {
    // Still in the API, no longer open. Including it puts a dead link in the digest.
    expect(
      connector.parse(
        {
          jobs: [
            {
              id: 'a',
              title: 'Engineer',
              jobUrl: 'https://jobs.ashbyhq.com/x/a',
              isListed: false,
              descriptionHtml: '<p>Role</p>',
            },
          ],
        },
        'x',
      ),
    ).toEqual([]);
  });

  it('keeps scanning tiers past one whose salary is unusable', () => {
    // A weekly rate is dropped rather than mislabelled, but a later tier with a
    // usable annual figure must still be found.
    const [posting] = connector.parse(
      {
        jobs: [
          {
            id: 'a',
            title: 'Engineer',
            jobUrl: 'https://jobs.ashbyhq.com/x/a',
            location: 'Bengaluru, India',
            descriptionHtml: '<p>Role</p>',
            compensation: {
              compensationTiers: [
                {
                  components: [
                    {
                      compensationType: 'Salary',
                      interval: '1 WEEK',
                      currencyCode: 'USD',
                      minValue: 2000,
                      maxValue: 3000,
                    },
                  ],
                },
                {
                  components: [
                    {
                      compensationType: 'Salary',
                      interval: '1 YEAR',
                      currencyCode: 'INR',
                      minValue: 1800000,
                      maxValue: 2400000,
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
      'x',
    );
    expect(posting.salary).toEqual({
      min: '1800000.00',
      max: '2400000.00',
      currency: 'INR',
      period: SalaryPeriod.YEAR,
    });
  });

  it('falls back to descriptionPlain when there is no HTML body', () => {
    const [posting] = connector.parse(
      {
        jobs: [
          {
            id: 'a',
            title: 'Engineer',
            jobUrl: 'https://jobs.ashbyhq.com/x/a',
            descriptionHtml: '',
            descriptionPlain: 'Plain body only',
          },
        ],
      },
      'x',
    );
    expect(posting.descriptionText).toBe('Plain body only');
  });
});

describe('SmartRecruitersConnector', () => {
  const connector = new SmartRecruitersConnector();

  // Hand-built from a live Alight response rather than captured: that board had two
  // postings and neither carried a description, which is the fact this block is
  // about. The field names below are the ones that response used.
  const list = {
    totalFound: 137,
    content: [
      {
        id: '744000012345678',
        name: 'Senior Backend Engineer',
        visibility: 'PUBLIC',
        releasedDate: '2026-08-14T09:12:00.000Z',
        location: {
          city: 'Bengaluru',
          region: 'KA',
          country: 'in',
          remote: false,
        },
        department: { label: 'Technology' },
        typeOfEmployment: { label: 'Permanent' },
      },
      {
        id: '744000087654321',
        name: 'Internal Only Role',
        visibility: 'INTERNAL',
        location: { city: 'Pune', country: 'in' },
      },
    ],
  };

  it('paginates with limit and offset', () => {
    expect(connector.listUrl('alight', 0)).toBe(
      'https://api.smartrecruiters.com/v1/companies/alight/postings?limit=100&offset=0',
    );
    expect(connector.listUrl('alight', 100)).toContain('offset=100');
    expect(connector.totalAvailable(list)).toBe(137);
    expect(connector.totalAvailable({})).toBeNull();
  });

  it('reads name, skips INTERNAL, and leaves the body empty for hydration', () => {
    const postings = connector.parse(list, 'alight');
    expect(postings).toHaveLength(1);
    expect(postings[0].title).toBe('Senior Backend Engineer');
    expect(postings[0].location).toBe('Bengaluru, KA, in');
    expect(postings[0].remoteType).toBe(RemoteType.ONSITE);
    // The service DROPS a posting still in this state. Asserted so nobody "fixes"
    // the emptiness by storing the row description-less.
    expect(postings[0].descriptionText).toBe('');
    expect(postings[0].salary).toBeNull();
  });

  it('hydrates the body from the detail response and takes its real url', () => {
    const [posting] = connector.parse(list, 'alight');
    expect(connector.detailUrl(posting, 'alight')).toBe(
      'https://api.smartrecruiters.com/v1/companies/alight/postings/744000012345678',
    );

    const merged = connector.mergeDetail(posting, {
      postingUrl:
        'https://jobs.smartrecruiters.com/Alight/744000012345678-senior-backend-engineer',
      applyUrl: 'https://jobs.smartrecruiters.com/apply/744000012345678',
      location: { remote: true, city: 'Bengaluru' },
      jobAd: {
        sections: {
          companyDescription: {
            title: 'About us',
            text: '<p>We do benefits.</p>',
          },
          jobDescription: {
            title: 'The role',
            text: '<p>Own the payments API.</p>',
          },
          qualifications: {
            title: 'What you bring',
            text: '<ul><li>Java</li><li>Kafka</li></ul>',
          },
          additionalInformation: {
            title: 'EEO',
            text: '<p>We are an equal opportunity employer.</p>',
          },
        },
      },
    });

    expect(merged.descriptionText).toContain('Own the payments API.');
    expect(merged.descriptionText).toContain('- Java');
    expect(merged.descriptionText).toContain('What you bring');
    // Same rule as Lever's `additional`: kept in the raw body, withheld from the
    // text the model reads.
    expect(merged.descriptionRaw).toContain('equal opportunity');
    expect(merged.descriptionText).not.toContain('equal opportunity');

    expect(merged.applyUrl).toBe(
      'https://jobs.smartrecruiters.com/Alight/744000012345678-senior-backend-engineer',
    );
    // The detail response says remote; the list response did not.
    expect(merged.remoteType).toBe(RemoteType.REMOTE_INDIA);
  });

  it('keeps the constructed url when the detail response has no usable one', () => {
    const [posting] = connector.parse(list, 'alight');
    const merged = connector.mergeDetail(posting, { jobAd: { sections: {} } });
    expect(merged.applyUrl).toBe(posting.applyUrl);
    expect(merged.descriptionText).toBe('');
  });
});

describe('the registry', () => {
  it('gives every connector a distinct source and resolves both ways', () => {
    const sources = CONNECTORS.map((c) => c.source);
    expect(new Set(sources).size).toBe(sources.length);

    for (const connector of CONNECTORS) {
      expect(connectorFor(connector.source)).toBe(connector);
      expect(connectorForAts(connector.atsType)).toBe(connector);
      // `source` is stored in job_postings.source and compared to it later, so a
      // capitalised value would quietly split one source into two.
      expect(connector.source).toBe(connector.source.toLowerCase());
    }
  });

  it('returns undefined for a source it does not have', () => {
    expect(connectorFor('linkedin')).toBeUndefined();
  });
});
