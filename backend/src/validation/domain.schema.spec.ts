/**
 * The service-layer schemas, tested on the values that would otherwise reach a
 * CHECK constraint and come back as a 500.
 *
 * Weighted towards the mistakes that are plausible rather than exhaustive coverage
 * of every field: a percentage where a fraction belongs, an inverted range, a
 * float where a decimal belongs, and the three application-status rules that
 * PLAN-v2 treats as guarantees.
 */
import {
  applicationAnswersInput,
  applicationWriteInput,
  candidateProfileInput,
  confidenceField,
  currencyField,
  jobPostingInput,
  lpaField,
  matchScoreInput,
  requiredText,
  sourceRunResultInput,
} from './domain.schema';

describe('requiredText', () => {
  it('rejects whitespace-only, matching length(trim(x)) > 0 in SQL', () => {
    // The case that would otherwise pass the service and fail the database.
    expect(requiredText().safeParse('   ').success).toBe(false);
  });

  it('trims on the way through, so the stored value satisfies the constraint', () => {
    expect(requiredText().parse('  Backend Engineer  ')).toBe(
      'Backend Engineer',
    );
  });
});

describe('confidenceField', () => {
  it('accepts a fraction', () => {
    expect(confidenceField.parse(0.85)).toBe(0.85);
  });

  it('rejects a percentage', () => {
    // 85 meaning "85%" is the mix-up the 0-1 bound exists to catch.
    expect(confidenceField.safeParse(85).success).toBe(false);
  });

  it.each([0, 1])('accepts the boundary %p', (v) => {
    expect(confidenceField.parse(v)).toBe(v);
  });
});

describe('lpaField', () => {
  it('keeps the value as a string, so no float rounding happens', () => {
    // 12.1 has no exact binary representation. Staying decimal end-to-end is the
    // entire reason the column is numeric rather than double precision.
    expect(lpaField.parse('12.1')).toBe('12.1');
    expect(typeof lpaField.parse(12.1)).toBe('string');
  });

  it('rejects more precision than the column holds', () => {
    expect(lpaField.safeParse('12.345').success).toBe(false);
  });

  it('rejects a figure that is obviously in rupees, not lakhs', () => {
    expect(lpaField.safeParse(1_200_000).success).toBe(false);
  });

  it('rejects a negative amount and non-numeric text', () => {
    expect(lpaField.safeParse('-5').success).toBe(false);
    expect(lpaField.safeParse('twelve').success).toBe(false);
  });
});

describe('currencyField', () => {
  it('upper-cases, so the ISO 4217 constraint is satisfied', () => {
    expect(currencyField.parse('inr')).toBe('INR');
  });

  it('rejects a symbol or a name', () => {
    expect(currencyField.safeParse('₹').success).toBe(false);
    expect(currencyField.safeParse('rupees').success).toBe(false);
  });
});

describe('jobPostingInput', () => {
  const valid = {
    source: 'greenhouse',
    sourceJobId: '4321',
    title: 'Backend Engineer',
    normalizedTitle: 'backend engineer',
    descriptionRaw: '<p>...</p>',
    descriptionText: '...',
    applyUrl: 'https://boards.greenhouse.io/acme/jobs/4321',
    contentHash: 'abc123',
  };

  it('accepts a minimal posting', () => {
    expect(jobPostingInput.safeParse(valid).success).toBe(true);
  });

  it('rejects an empty normalizedTitle', () => {
    // Not cosmetic: applications is UNIQUE(userId, companyId, normalizedTitle), so
    // every posting normalizing to '' collides with every other one at that
    // company. Two such rows already existed before the constraint was added.
    expect(
      jobPostingInput.safeParse({ ...valid, normalizedTitle: '  ' }).success,
    ).toBe(false);
  });

  it('rejects a non-http apply URL', () => {
    expect(
      jobPostingInput.safeParse({ ...valid, applyUrl: 'javascript:alert(1)' })
        .success,
    ).toBe(false);
  });

  it('rejects an inverted salary range', () => {
    const r = jobPostingInput.safeParse({
      ...valid,
      salaryMin: 2_000_000,
      salaryMax: 1_000_000,
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['salaryMax']);
  });

  it('rejects an inverted years-of-experience range', () => {
    expect(
      jobPostingInput.safeParse({ ...valid, yoeMin: 8, yoeMax: 3 }).success,
    ).toBe(false);
  });

  it('rejects STATED with no figure', () => {
    // The label would be a claim the row cannot support - and salary is the field
    // this system is least able to verify, so an unsupported STATED is worse than
    // UNKNOWN.
    const r = jobPostingInput.safeParse({ ...valid, salarySource: 'STATED' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['salarySource']);
  });

  it('accepts STATED when a figure is present', () => {
    expect(
      jobPostingInput.safeParse({
        ...valid,
        salarySource: 'STATED',
        salaryMin: 1_800_000,
        salaryCurrency: 'INR',
        salaryPeriod: 'YEAR',
      }).success,
    ).toBe(true);
  });
});

describe('applicationWriteInput', () => {
  const base = {
    status: 'QUEUED' as const,
    normalizedTitle: 'backend engineer',
  };

  it('refuses SUBMITTED without a detected confirmation', () => {
    // PLAN-v2: submitted is recorded only on DETECTED confirmation, never
    // optimistically. Enforced here and again by a CHECK constraint.
    const r = applicationWriteInput.safeParse({ ...base, status: 'SUBMITTED' });
    expect(r.success).toBe(false);
  });

  it('refuses SUBMITTED with a timestamp but no confirmation text', () => {
    expect(
      applicationWriteInput.safeParse({
        ...base,
        status: 'SUBMITTED',
        submittedAt: new Date(),
      }).success,
    ).toBe(false);
  });

  it('accepts SUBMITTED with both', () => {
    expect(
      applicationWriteInput.safeParse({
        ...base,
        status: 'SUBMITTED',
        submittedAt: new Date(),
        confirmationText: 'Thank you for applying',
      }).success,
    ).toBe(true);
  });

  it('refuses FAILED with no reason', () => {
    expect(
      applicationWriteInput.safeParse({ ...base, status: 'FAILED' }).success,
    ).toBe(false);
  });

  it('refuses a cover letter alongside a variant that already holds one', () => {
    const r = applicationWriteInput.safeParse({
      ...base,
      resumeVariantId: '3f1e9c7a-5b2d-4e8f-9a1b-6c4d2e8f0a13',
      coverLetter: 'Dear hiring manager',
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['coverLetter']);
  });

  it('allows a cover letter when there is no variant', () => {
    // The manual-open case: a job reached through a link, with no generated
    // variant to hold the text.
    expect(
      applicationWriteInput.safeParse({
        ...base,
        coverLetter: 'Dear hiring manager',
      }).success,
    ).toBe(true);
  });

  it('rejects coverage expressed as a percentage', () => {
    expect(
      applicationWriteInput.safeParse({ ...base, prefillCoverage: 85 }).success,
    ).toBe(false);
  });
});

describe('matchScoreInput', () => {
  const valid = {
    score: 72,
    verdict: 'GOOD' as const,
    llmProvider: 'claude',
    model: 'claude-opus-5',
  };

  it('accepts a score in range and defaults the arrays', () => {
    const parsed = matchScoreInput.parse(valid);
    expect(parsed.reasons).toEqual([]);
    expect(parsed.missingSkills).toEqual([]);
  });

  it.each([-1, 101, 7.5])('rejects score %p', (score) => {
    expect(matchScoreInput.safeParse({ ...valid, score }).success).toBe(false);
  });

  it('requires the provider and model that make a regression traceable', () => {
    expect(
      matchScoreInput.safeParse({ ...valid, llmProvider: '' }).success,
    ).toBe(false);
  });
});

describe('sourceRunResultInput', () => {
  it('rejects more new postings than were seen', () => {
    // This table exists to make a miscounting connector visible, so it must not
    // be able to record an impossible count.
    const r = sourceRunResultInput.safeParse({
      companiesTried: 20,
      postingsSeen: 100,
      postingsNew: 150,
      errors: 0,
    });
    expect(r.success).toBe(false);
  });

  it('accepts new === seen, which is what a first run looks like', () => {
    expect(
      sourceRunResultInput.safeParse({
        companiesTried: 20,
        postingsSeen: 3352,
        postingsNew: 3352,
        errors: 0,
      }).success,
    ).toBe(true);
  });
});

describe('applicationAnswersInput', () => {
  it('accepts the answers a candidate supplies', () => {
    const parsed = applicationAnswersInput.parse({
      workAuthorization: 'Indian citizen, no sponsorship required',
      needsSponsorship: false,
      noticePeriodDays: 60,
      expectedCtcLpa: '24.50',
      willingToRelocate: true,
    });
    expect(parsed.expectedCtcLpa).toBe('24.50');
  });

  it('rejects an implausible notice period', () => {
    expect(
      applicationAnswersInput.safeParse({ noticePeriodDays: 4000 }).success,
    ).toBe(false);
  });

  it('silently drops an EEO field rather than storing it', () => {
    // There is no column for these anywhere, by decision. Zod strips unknown keys,
    // so the guarantee is that one cannot arrive through this schema even if a
    // caller sends it.
    const parsed = applicationAnswersInput.parse({
      needsSponsorship: false,
      gender: 'female',
      veteranStatus: 'no',
    });
    expect(parsed).not.toHaveProperty('gender');
    expect(parsed).not.toHaveProperty('veteranStatus');
  });
});

describe('candidateProfileInput', () => {
  const atom = {
    kind: 'BULLET' as const,
    text: 'Cut p99 latency 40% by batching writes',
    ordinal: 0,
  };

  it('accepts a profile with atoms', () => {
    expect(
      candidateProfileInput.safeParse({
        label: 'primary',
        fullName: 'A Candidate',
        email: 'candidate@localhost',
        atoms: [atom, { ...atom, ordinal: 1 }],
      }).success,
    ).toBe(true);
  });

  it('reports a duplicate ordinal against the offending atom', () => {
    // The database would raise a unique-violation naming whichever row happened to
    // insert second, which does not tell the caller they sent two atoms numbered 1.
    const r = candidateProfileInput.safeParse({
      label: 'primary',
      fullName: 'A Candidate',
      email: 'candidate@localhost',
      atoms: [
        { ...atom, ordinal: 1 },
        { ...atom, ordinal: 1 },
      ],
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['atoms', 1, 'ordinal']);
  });
});
