/**
 * The digest as words.
 *
 * WHY THE WORDING IS TESTED AT ALL. This is the only part of the system a person reads
 * every day, and every failure here is silent: a subject line that says nothing gets
 * filtered, "0%" where the honest answer is "n/a" reports a perfect record on a day when
 * nothing happened, and an unescaped job title from a job board puts a stranger's HTML
 * inside an email. None of those breaks a build.
 */
import { digestHtml, digestSubject, digestText, percent } from './digest.text';
import type { DigestPayload } from './digest.types';

const APP_URL = 'http://localhost:3200';

function payload(
  over: Partial<DigestPayload['candidate']> = {},
): DigestPayload {
  return {
    version: 1,
    day: '2026-09-08',
    generatedAt: '2026-09-08T03:30:00.000Z',
    since: '2026-09-07T03:30:00.000Z',
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
      ...over,
    },
    system: null,
  };
}

function match(over: Partial<DigestPayload['candidate']['top'][0]> = {}) {
  return {
    jobId: 'job-1',
    title: 'Applied AI Engineer',
    company: 'OpenAI',
    location: 'Bengaluru, India',
    score: 88,
    verdict: 'STRONG',
    salaryLpa: '42.5',
    url: 'https://jobs.example.com/job-1',
    ...over,
  };
}

describe('digestSubject', () => {
  it('leads with the numbers that decide whether it gets opened', () => {
    const subject = digestSubject(
      payload({ newMatches: 9, undecided: 4, preparedWaiting: 2 }),
    );

    expect(subject).toBe(
      'AUTOPILOT 2026-09-08: 9 new matches, 4 to review, 2 ready to send',
    );
  });

  it('says so plainly when there is nothing', () => {
    // An empty morning still gets a subject that says it is empty, rather than a heading
    // that promises something and a body that does not deliver it.
    expect(digestSubject(payload())).toBe('AUTOPILOT 2026-09-08: nothing new');
  });

  it('gets the singular right', () => {
    expect(digestSubject(payload({ newMatches: 1 }))).toBe(
      'AUTOPILOT 2026-09-08: 1 new match',
    );
  });

  it('leaves out the counts that are zero', () => {
    const subject = digestSubject(payload({ newMatches: 3 }));

    // "3 new matches, 0 to review, 0 ready to send" is three numbers to read where one
    // is the answer.
    expect(subject).toBe('AUTOPILOT 2026-09-08: 3 new matches');
  });
});

describe('digestText', () => {
  it('reports the guard as a rate only when something was tailored', () => {
    const quiet = digestText(payload({ tailored: 0, guardFailed: 0 }), APP_URL);
    const busy = digestText(
      payload({ tailored: 4, guardFailed: 1, guardFailureRate: 0.25 }),
      APP_URL,
    );

    expect(quiet).not.toContain('provenance');
    expect(busy).toContain(
      'Resumes written: 4, of which 1 failed the provenance check (25%)',
    );
  });

  it('puts the missing answers above the job list', () => {
    const text = digestText(
      payload({ missingAnswers: ['expected CTC'], top: [match()] }),
      APP_URL,
    );

    // Deliberate ordering. It is the one item here the reader can fix in two minutes, and
    // until they do it leaves a required box empty on every form.
    expect(text.indexOf('expected CTC')).toBeLessThan(
      text.indexOf('Applied AI Engineer'),
    );
  });

  it('links to the page where the buttons are', () => {
    const text = digestText(payload({ top: [match()] }), APP_URL);

    expect(text).toContain(`${APP_URL}/app/digest`);
    // ONE link, and it only navigates. Mail scanners and corporate gateways fetch every
    // link in a message before a human sees it, so a "not for me" URL in here would
    // answer on the candidate's behalf.
    expect(text.match(/https?:\/\//g)).toHaveLength(1);
    expect(text).not.toContain('/decision');
  });

  it('leaves out a location or a salary it does not have', () => {
    const text = digestText(
      payload({ top: [match({ location: null, salaryLpa: null })] }),
      APP_URL,
    );

    expect(text).toContain('88  Applied AI Engineer @ OpenAI');
    expect(text).not.toContain('LPA');
    expect(text).not.toContain('null');
  });

  it('names the verdicts that occurred and no others', () => {
    const text = digestText(
      payload({ newMatches: 3, byVerdict: { STRONG: 1, GOOD: 2, WEAK: 0 } }),
      APP_URL,
    );

    expect(text).toContain('1 strong, 2 good');
    expect(text).not.toContain('weak');
  });

  it('adds the machine section only when the digest has one', () => {
    const plain = digestText(payload(), APP_URL);
    const admin = digestText(
      {
        ...payload(),
        system: {
          newCompanies: 4,
          newPostings: 9,
          boards: [
            {
              source: 'greenhouse',
              companiesTried: 20,
              postingsSeen: 40,
              postingsNew: 9,
              errors: 0,
            },
          ],
          deadBoards: [
            {
              source: 'keka',
              reason: 'tried 8 board(s) and read no postings at all',
            },
          ],
          modelUse: [{ model: 'claude-haiku-4-5', calls: 12 }],
          lastDiscoveryAt: '2026-09-08T00:30:00.000Z',
        },
      },
      APP_URL,
    );

    expect(plain).not.toContain('the machine');
    expect(admin).toContain('greenhouse: 9 / 40 / 20 / 0');
    expect(admin).toContain(
      'keka: tried 8 board(s) and read no postings at all',
    );
    // Calls, not tokens. Token counts are not persisted anywhere, and printing a call
    // count under the word "tokens" would be worse than printing neither.
    expect(admin).toContain('LLM calls: 12 x claude-haiku-4-5');
  });
});

describe('digestHtml', () => {
  it('escapes whatever the job board gave us', () => {
    const html = digestHtml(
      payload({
        top: [
          match({ title: '<script>alert(1)</script>', company: 'Foo & Bar' }),
        ],
      }),
      APP_URL,
    );

    // Titles and employer names arrive from other people's websites. This is an email,
    // so there is no CSP to fall back on.
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Foo &amp; Bar');
  });

  it('says what is happening when nothing is waiting', () => {
    const html = digestHtml(payload(), APP_URL);

    expect(html).toContain('Nothing is waiting for a decision.');
    expect(html).not.toContain('Say yes or no</a>');
  });

  it('ends with the promise the whole system is built on', () => {
    expect(digestHtml(payload({ top: [match()] }), APP_URL)).toContain(
      'Nothing is ever submitted',
    );
  });
});

describe('percent', () => {
  it('is "n/a" and never "0%" when there is nothing to rate', () => {
    // The distinction the whole guardFailureRate field exists for.
    expect(percent(null)).toBe('n/a');
    expect(percent(0)).toBe('0%');
    expect(percent(0.25)).toBe('25%');
    expect(percent(1)).toBe('100%');
  });
});
