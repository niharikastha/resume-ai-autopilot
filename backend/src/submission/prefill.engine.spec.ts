/**
 * The filling engine, which is where phase 6's safety rules actually live.
 *
 * THE TWO THINGS WORTH TESTING HERE, and they are both about restraint rather than
 * capability:
 *
 *   1. A question this system is not allowed to answer stays blank however it is
 *      labelled, whatever the ATS calls the field, and even if a model says otherwise.
 *      A demographic box filled from a stored value is this program answering a
 *      question about someone's race on their behalf; there is no way to notice that
 *      from the outcome, because a filled form looks like a filled form.
 *   2. A value it cannot place is left alone rather than guessed. The specific case is
 *      a sponsorship dropdown: picking whichever option came first is how a system
 *      states the opposite of the truth about someone's visa to an employer.
 *
 * NO BROWSER AND NO PLAYWRIGHT. `FakePage` implements the same `FormPage` interface the
 * adapters are written against and records what was typed, which is the whole reason
 * that interface exists. What it does not cover is whether the real page object reads a
 * form correctly - that is playwright.page.ts, and it needs a browser.
 */
import { runPrefill } from './prefill.engine';
import type { FormField, FormPage } from './form-page';
import type { PreparedApplication } from './ats.adapter';
import type { AnswerSet } from './answers';
import { NO_STATED_ANSWERS } from './answers';

const PROFILE = {
  fullName: 'Astha Niharika',
  email: 'astha@example.com',
  phone: '+91 90000 00000',
  location: 'Bhubaneswar, India',
  linkedIn: 'https://linkedin.com/in/astha',
  github: 'https://github.com/astha',
  portfolio: 'https://astha.dev',
};

function answers(overrides: Partial<AnswerSet> = {}): AnswerSet {
  return {
    profile: PROFILE,
    stated: NO_STATED_ANSWERS,
    resumePath: '/tmp/Astha_Niharika_Acme_Backend.pdf',
    coverLetter: 'Dear Acme,\n\nI build backend services.',
    ...overrides,
  };
}

function field(overrides: Partial<FormField> & { label: string }): FormField {
  return {
    handle: 'f0',
    type: 'text',
    name: null,
    required: false,
    options: [],
    value: '',
    ...overrides,
  };
}

/** Handles are assigned here so a test's field list reads without them. */
function form(fields: (Partial<FormField> & { label: string })[]): FormField[] {
  return fields.map((f, index) => field({ handle: `f${index}`, ...f }));
}

class FakePage implements FormPage {
  readonly url = 'https://job-boards.greenhouse.io/acme/jobs/1';
  /** What was typed, by handle. */
  readonly typed = new Map<string, string>();
  readonly checked: string[] = [];
  readonly attached = new Map<string, string>();
  readonly revealed: string[] = [];
  screenshotAt: string | null = null;

  /** Handles whose write should throw, to exercise the per-field failure path. */
  breakOn = new Set<string>();
  screenshotFails = false;

  constructor(private readonly list: FormField[]) {}

  fields(): Promise<FormField[]> {
    return Promise.resolve(this.list);
  }

  fill(handle: string, value: string): Promise<void> {
    if (this.breakOn.has(handle)) {
      return Promise.reject(new Error('element is not editable'));
    }
    this.typed.set(handle, value);
    return Promise.resolve();
  }

  select(handle: string, value: string): Promise<void> {
    this.typed.set(handle, value);
    return Promise.resolve();
  }

  check(handle: string): Promise<void> {
    this.checked.push(handle);
    return Promise.resolve();
  }

  attach(handle: string, path: string): Promise<void> {
    this.attached.set(handle, path);
    return Promise.resolve();
  }

  reveal(handle: string): Promise<void> {
    this.revealed.push(handle);
    return Promise.resolve();
  }

  screenshot(path: string): Promise<void> {
    if (this.screenshotFails) return Promise.reject(new Error('disk full'));
    this.screenshotAt = path;
    return Promise.resolve();
  }
}

function application(set: AnswerSet = answers()): PreparedApplication {
  return {
    applicationId: 'app-1',
    jobId: 'job-1',
    applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/1',
    title: 'Backend Engineer',
    company: 'Acme',
    answers: set,
    screenshotPath: null,
  };
}

describe('the ordinary fields, which are the point of the phase', () => {
  it('fills the contact details from the profile', async () => {
    const page = new FakePage(
      form([
        { label: 'First name', required: true },
        { label: 'Last name', required: true },
        { label: 'Email', type: 'email', required: true },
        { label: 'Phone', type: 'tel' },
        { label: 'LinkedIn Profile', type: 'url' },
        { label: 'GitHub', type: 'url' },
      ]),
    );

    const result = await runPrefill(page, application());

    expect(page.typed.get('f0')).toBe('Astha');
    expect(page.typed.get('f1')).toBe('Niharika');
    expect(page.typed.get('f2')).toBe('astha@example.com');
    expect(page.typed.get('f3')).toBe('+91 90000 00000');
    expect(page.typed.get('f4')).toBe('https://linkedin.com/in/astha');
    expect(page.typed.get('f5')).toBe('https://github.com/astha');
    expect(result.requiredFilled).toBe(3);
    expect(result.requiredTotal).toBe(3);
  });

  it('attaches the tailored resume to the file input', async () => {
    const page = new FakePage(
      form([{ label: 'Resume/CV', type: 'file', required: true }]),
    );

    await runPrefill(page, application());

    expect(page.attached.get('f0')).toBe(
      '/tmp/Astha_Niharika_Acme_Backend.pdf',
    );
  });

  it('leaves a field the browser already filled exactly as it is', async () => {
    // The persistent profile means Chrome's autofill puts real values in these boxes,
    // and the human corrects them by hand. Overwriting is how a correction is undone
    // without anyone seeing it happen.
    const page = new FakePage(
      form([
        {
          label: 'Phone',
          type: 'tel',
          value: '+91 98765 43210',
          required: true,
        },
      ]),
    );

    const result = await runPrefill(page, application());

    expect(page.typed.has('f0')).toBe(false);
    expect(result.requiredFilled).toBe(1);
    expect(result.fields[0].reason).toMatch(/already had a value/);
  });
});

describe('the questions this system will not answer', () => {
  const eeo = [
    'Gender',
    'Race / Ethnicity',
    'Are you Hispanic or Latino?',
    'Veteran Status',
    'Voluntary Self-Identification of Disability',
    'Do you identify as LGBTQ+?',
    'What are your pronouns?',
    'Date of birth',
  ];

  it.each(eeo)('leaves "%s" blank', async (label) => {
    const page = new FakePage(
      form([{ label, type: 'select', options: ['Yes', 'No'] }]),
    );

    const result = await runPrefill(page, application());

    expect(page.typed.size).toBe(0);
    expect(result.fields[0].outcome).toBe('skipped');
    expect(result.fields[0].reason).toMatch(/demographic/);
  });

  it('leaves a demographic question blank even when the ATS maps its field name', async () => {
    // The name map is trusted over labels for everything else, so this is the one
    // ordering that has to be checked: a mapping cannot license an EEO answer.
    const page = new FakePage(
      form([{ label: 'Gender', name: 'first_name', type: 'text' }]),
    );

    const result = await runPrefill(page, application(), {
      nameMap: { first_name: 'firstName' },
    });

    expect(page.typed.size).toBe(0);
    expect(result.fields[0].outcome).toBe('skipped');
  });

  it('tells the human when a demographic question is required', async () => {
    // Blank is right, but a required blank stops the form from submitting, and the
    // human has to know that is what is holding it up.
    const page = new FakePage(
      form([
        {
          label: 'Gender',
          type: 'select',
          required: true,
          options: ['Male', 'Female'],
        },
      ]),
    );

    const result = await runPrefill(page, application());

    expect(result.needsHuman).toEqual([
      expect.stringContaining(
        'required, and left blank because it is a demographic',
      ),
    ]);
  });

  it('says nothing about an optional demographic question', async () => {
    // Left blank on purpose is not an outstanding task, and a list of things to do
    // that includes eight EEO boxes is a list nobody reads.
    const page = new FakePage(
      form([{ label: 'Veteran status', type: 'select' }]),
    );

    const result = await runPrefill(page, application());

    expect(result.needsHuman).toEqual([]);
  });

  it('refuses a combined question that is both demographic and legal', async () => {
    // Real forms merge these blocks. When a label is both, blank is the answer.
    const page = new FakePage(
      form([
        {
          label:
            'Veteran status, and are you legally authorized to work in India?',
          type: 'select',
          options: ['Yes', 'No'],
        },
      ]),
    );

    const result = await runPrefill(
      page,
      application(
        answers({
          stated: { ...NO_STATED_ANSWERS, workAuthorization: 'Indian citizen' },
        }),
      ),
    );

    expect(page.typed.size).toBe(0);
    expect(result.fields[0].reason).toMatch(/demographic/);
  });
});

describe('the legal and compensation questions', () => {
  it('answers from the stored value and from nowhere else', async () => {
    const page = new FakePage(
      form([
        { label: 'Expected CTC (LPA)', required: true },
        { label: 'Notice period (days)' },
      ]),
    );

    const result = await runPrefill(
      page,
      application(
        answers({
          stated: {
            ...NO_STATED_ANSWERS,
            expectedCtcLpa: '24.50',
            noticePeriodDays: 60,
          },
        }),
      ),
    );

    expect(page.typed.get('f0')).toBe('24.50');
    expect(page.typed.get('f1')).toBe('60');
    // The FIGURE IS NOT ECHOED into the field record. That record is printed to the
    // terminal and stored in screeningAnswers; a salary expectation does not belong in
    // either, and everything else that gets filled is already on the resume.
    expect(result.fields[0].value).toBeUndefined();
    expect(result.fields[0].outcome).toBe('filled');
  });

  it('leaves the field blank and flags it when nothing is stored', async () => {
    const page = new FakePage(
      form([{ label: 'Expected salary', required: true }]),
    );

    const result = await runPrefill(page, application());

    expect(page.typed.size).toBe(0);
    expect(result.requiredFilled).toBe(0);
    expect(result.needsHuman).toEqual([
      expect.stringContaining('Expected salary - needs your answer'),
    ]);
  });

  it('flags an unanswered compensation question even when the form says it is optional', async () => {
    // An employer reading a blank "current CTC" draws a conclusion from it, so the
    // candidate should be told it went out empty rather than find out later.
    const page = new FakePage(form([{ label: 'Current CTC' }]));

    const result = await runPrefill(page, application());

    expect(result.needsHuman).toEqual([expect.stringContaining('Current CTC')]);
  });

  it('never infers work authorization from the profile', async () => {
    // The profile says the candidate lives in India. That is not a statement about
    // their right to work anywhere, including India, and this is the field where
    // guessing produces a false statement in a hiring process.
    const page = new FakePage(
      form([
        {
          label: 'Are you legally authorized to work in the United States?',
          type: 'select',
          options: ['Yes', 'No'],
          required: true,
        },
      ]),
    );

    const result = await runPrefill(page, application());

    expect(page.typed.size).toBe(0);
    expect(result.fields[0].outcome).toBe('blank');
  });

  it('picks the negative option when the answer is no and the wording is a sentence', async () => {
    // THE CASE THAT MOTIVATED optionFor's ordering. "I do not require sponsorship"
    // contains the words a naive yes-test matches, and the two options in a real
    // sponsorship dropdown differ by exactly one word.
    const page = new FakePage(
      form([
        {
          label: 'Will you now or in the future require visa sponsorship?',
          type: 'select',
          options: ['I do require sponsorship', 'I do not require sponsorship'],
          required: true,
        },
      ]),
    );

    const result = await runPrefill(
      page,
      application(
        answers({ stated: { ...NO_STATED_ANSWERS, needsSponsorship: false } }),
      ),
    );

    expect(page.typed.get('f0')).toBe('I do not require sponsorship');
    expect(result.requiredFilled).toBe(1);
  });

  it('leaves a dropdown alone when no option can be matched to the answer', async () => {
    // Rather than choosing the first one. The wording here is deliberately not
    // yes/no; a system that picked "Requires H-1B transfer" from it would state
    // something untrue about the candidate's visa.
    const page = new FakePage(
      form([
        {
          label: 'Work authorization',
          type: 'select',
          options: ['Requires H-1B transfer', 'Requires TN status', 'Other'],
          required: true,
        },
      ]),
    );

    const result = await runPrefill(
      page,
      application(
        answers({
          stated: { ...NO_STATED_ANSWERS, workAuthorization: 'Indian citizen' },
        }),
      ),
    );

    expect(page.typed.size).toBe(0);
    expect(result.fields[0].outcome).toBe('blank');
    expect(result.needsHuman).toEqual([
      expect.stringContaining('Work authorization'),
    ]);
  });

  it('uses an answer the candidate typed for this exact question before', async () => {
    // customAnswers is the same standard as the columns: a sentence the candidate
    // wrote for this question. So it is allowed to answer a legal one.
    const page = new FakePage(
      form([
        {
          label: 'What is your notice period at your current employer?*',
          required: true,
        },
      ]),
    );

    const result = await runPrefill(
      page,
      application(
        answers({
          stated: {
            ...NO_STATED_ANSWERS,
            customAnswers: {
              'what is your notice period at your current employer':
                '2 months, negotiable',
            },
          },
        }),
      ),
    );

    expect(page.typed.get('f0')).toBe('2 months, negotiable');
    expect(result.requiredFilled).toBe(1);
  });
});

describe('free text', () => {
  it('does not write a paragraph about the company', async () => {
    const page = new FakePage(
      form([
        {
          label: 'Why do you want to work at Acme?',
          type: 'textarea',
          required: true,
        },
      ]),
    );

    const result = await runPrefill(page, application());

    expect(page.typed.size).toBe(0);
    expect(result.needsHuman).toEqual([
      expect.stringContaining('free text, for you to write'),
    ]);
  });

  it('still fills the cover letter, because the guard already read it', async () => {
    // The distinction that makes the long-form rule usable: tailoring wrote this text
    // and the provenance guard passed it, so it is not a generated paragraph in the
    // sense the rule is about.
    const page = new FakePage(
      form([{ label: 'Cover letter (optional)', type: 'textarea' }]),
    );

    await runPrefill(page, application());

    expect(page.typed.get('f0')).toMatch(/^Dear Acme,/);
  });
});

describe('the ATS name maps', () => {
  it('trusts the field name over the label', async () => {
    // The value of a tier-1 adapter. `first_name` is `first_name` on every Greenhouse
    // board; the label above it is whatever the customer typed, in whatever language.
    const page = new FakePage(
      form([{ label: 'Prénom', name: 'first_name', required: true }]),
    );

    await runPrefill(page, application(), {
      nameMap: { first_name: 'firstName' },
    });

    expect(page.typed.get('f0')).toBe('Astha');
  });

  it('matches a field name case-insensitively', async () => {
    const page = new FakePage(form([{ label: '', name: 'First_Name' }]));

    await runPrefill(page, application(), {
      nameMap: { first_name: 'firstName' },
    });

    expect(page.typed.get('f0')).toBe('Astha');
  });

  it('leaves a name mapped to null alone', async () => {
    // How Lever's "Additional information" box is excluded: it is a free-text field
    // whose label says nothing, so no rule would claim it, and an explicit exclusion
    // says that is deliberate rather than a gap.
    const page = new FakePage(
      form([
        { label: 'Additional information', name: 'comments', type: 'textarea' },
      ]),
    );

    const result = await runPrefill(page, application(), {
      nameMap: { comments: null },
    });

    expect(page.typed.size).toBe(0);
    expect(result.fields[0].reason).toMatch(/excluded by this ATS adapter/);
  });
});

describe('the generic filler, which asks a model', () => {
  it('only ever shows it fields no rule claimed', async () => {
    const page = new FakePage(
      form([
        { label: 'Email', type: 'email' },
        { label: 'Gender', type: 'select', options: ['Male', 'Female'] },
        { label: 'Expected CTC' },
        { label: 'Why do you want to work at Acme?', type: 'textarea' },
        { label: 'Your handle on our forum' },
      ]),
    );

    let shown: string[] = [];
    await runPrefill(page, application(), {
      resolve: (fields) => {
        shown = fields.map((f) => f.label);
        return Promise.resolve(new Map());
      },
    });

    // The whole safety argument for tier 3: a form full of prompt injection cannot
    // reach the EEO or salary questions, because they were never in the call.
    expect(shown).toEqual(['Your handle on our forum']);
  });

  it('discards a match whose field turns out not to be ordinary', async () => {
    // Belt and braces. `resolve` was handed only ordinary fields, but this is the one
    // place a model's output decides what gets typed, so the answer is re-checked
    // against the same rules on the way back.
    const page = new FakePage(form([{ label: 'Your gender identity' }]));

    await runPrefill(page, application(), {
      resolve: () => Promise.resolve(new Map([['f0', 'fullName']])),
    });

    expect(page.typed.size).toBe(0);
  });

  it('ignores a handle the model was not asked about', async () => {
    const page = new FakePage(
      form([
        { label: 'Your handle on our forum' },
        { label: 'Gender', type: 'select' },
      ]),
    );

    await runPrefill(page, application(), {
      resolve: () => Promise.resolve(new Map([['f1', 'fullName']])),
    });

    expect(page.typed.size).toBe(0);
  });

  it('fills the rest of the form when the model call fails', async () => {
    // A failed LLM call costs the long tail of the form, not the form.
    const page = new FakePage(
      form([
        { label: 'Email', type: 'email', required: true },
        { label: 'Your handle on our forum' },
      ]),
    );

    const result = await runPrefill(page, application(), {
      resolve: () => Promise.reject(new Error('429 rate limited')),
    });

    expect(page.typed.get('f0')).toBe('astha@example.com');
    expect(result.requiredFilled).toBe(1);
  });
});

describe('the control types', () => {
  it('ticks a checkbox for yes and leaves it alone for no', async () => {
    const yes = new FakePage(
      form([{ label: 'Willing to relocate?', type: 'checkbox' }]),
    );
    await runPrefill(
      yes,
      application(
        answers({ stated: { ...NO_STATED_ANSWERS, willingToRelocate: true } }),
      ),
    );
    expect(yes.checked).toEqual(['f0']);

    const no = new FakePage(
      form([{ label: 'Willing to relocate?', type: 'checkbox' }]),
    );
    await runPrefill(
      no,
      application(
        answers({ stated: { ...NO_STATED_ANSWERS, willingToRelocate: false } }),
      ),
    );
    // Never unticked: an untouched form already says no, and clicking a box to leave it
    // where it was is how a consent checkbox gets toggled by accident.
    expect(no.checked).toEqual([]);
  });

  it('picks an option in a radio group', async () => {
    const page = new FakePage(
      form([
        {
          label: 'Do you require visa sponsorship?',
          type: 'radio',
          name: 'sponsorship',
          options: ['Yes', 'No'],
          required: true,
        },
      ]),
    );

    await runPrefill(
      page,
      application(
        answers({ stated: { ...NO_STATED_ANSWERS, needsSponsorship: true } }),
      ),
    );

    expect(page.typed.get('f0')).toBe('Yes');
  });

  it('matches a dropdown option that contains the answer', async () => {
    const page = new FakePage(
      form([
        {
          label: 'Location',
          type: 'select',
          options: ['Remote - Bhubaneswar, India (Hybrid)', 'Bengaluru, India'],
        },
      ]),
    );

    await runPrefill(page, application());

    expect(page.typed.get('f0')).toBe('Remote - Bhubaneswar, India (Hybrid)');
  });

  it('leaves a dropdown alone when the option spells the place out differently', async () => {
    // A KNOWN LIMIT, recorded rather than fixed. The profile says "Bhubaneswar, India"
    // and the option says "Bhubaneswar, Odisha, India" - the same place, and neither
    // string contains the other. Matching this would need to compare the parts, and a
    // filler that compares parts of a location also matches "Cambridge, MA" to
    // "Cambridge, UK". The human picks the city from a dropdown that is already open.
    const page = new FakePage(
      form([
        {
          label: 'Location',
          type: 'select',
          options: [
            'Bhubaneswar, Odisha, India',
            'Bengaluru, Karnataka, India',
          ],
        },
      ]),
    );

    const result = await runPrefill(page, application());

    expect(page.typed.size).toBe(0);
    expect(result.fields[0].outcome).toBe('blank');
  });

  it('refuses to choose between two options that both contain the answer', async () => {
    // "India" reaches both of these, and a human can tell which one is meant.
    const page = new FakePage(
      form([
        {
          label: 'Country',
          type: 'select',
          options: ['India', 'India (Remote)'],
        },
      ]),
    );

    const result = await runPrefill(
      page,
      application(answers({ profile: { ...PROFILE, location: 'India' } })),
    );

    expect(page.typed.size).toBe(0);
    expect(result.fields[0].outcome).toBe('blank');
  });
});

describe('coverage and the audit trail', () => {
  it('reports the ratio of required fields that are now filled', async () => {
    const page = new FakePage(
      form([
        { label: 'Email', type: 'email', required: true },
        { label: 'Expected CTC', required: true },
        { label: 'Phone', type: 'tel' },
      ]),
    );

    const result = await runPrefill(page, application());

    expect(result).toMatchObject({ requiredTotal: 2, requiredFilled: 1 });
  });

  it('records a field that could not be written, and carries on', async () => {
    const page = new FakePage(
      form([
        { label: 'Email', type: 'email', required: true },
        { label: 'Phone', type: 'tel', required: true },
      ]),
    );
    page.breakOn.add('f0');

    const result = await runPrefill(page, application());

    expect(result.fields[0]).toMatchObject({
      outcome: 'failed',
      reason: 'element is not editable',
    });
    expect(page.typed.get('f1')).toBe('+91 90000 00000');
    expect(result.needsHuman).toEqual([
      expect.stringContaining('could not be filled'),
    ]);
  });

  it('takes the screenshot when asked', async () => {
    const page = new FakePage(form([{ label: 'Email', type: 'email' }]));

    const result = await runPrefill(page, application(), {
      screenshotPath: '/tmp/shot.png',
    });

    expect(page.screenshotAt).toBe('/tmp/shot.png');
    expect(result.screenshotPath).toBe('/tmp/shot.png');
  });

  it('keeps the filled form when the screenshot fails', async () => {
    // The screenshot is the evidence, not the work. Throwing here would discard a
    // form that is already filled and sitting in front of the human.
    const page = new FakePage(
      form([{ label: 'Email', type: 'email', required: true }]),
    );
    page.screenshotFails = true;

    const result = await runPrefill(page, application(), {
      screenshotPath: '/tmp/shot.png',
    });

    expect(result.screenshotPath).toBeNull();
    expect(result.requiredFilled).toBe(1);
  });

  it('reports every required field that is still empty', async () => {
    const page = new FakePage(
      form([{ label: 'Employee referral code', required: true }]),
    );

    const result = await runPrefill(page, application());

    expect(result.needsHuman).toEqual([
      'Employee referral code - required, still empty',
    ]);
  });

  it('does not fill anything when the form has no fields', async () => {
    // A posting that has closed, or an apply button on another page. The caller
    // screenshots and says so; it must not look like a failure of the adapter.
    const result = await runPrefill(new FakePage([]), application());

    expect(result).toMatchObject({
      requiredTotal: 0,
      requiredFilled: 0,
      fields: [],
      needsHuman: [],
    });
  });
});
