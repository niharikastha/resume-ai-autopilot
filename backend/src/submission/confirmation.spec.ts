/**
 * Whether the employer said they got it.
 *
 * WHY THIS IS THE MOST CONSEQUENTIAL SMALL FUNCTION IN PHASE 6. A SUBMITTED row is
 * permanent in effect: the unique index on (userId, companyId, normalizedTitle) means
 * this system will never offer that role again. So a false positive here is a job
 * silently deleted from the search, and it is invisible - nobody notices the posting
 * they were never shown. A false negative just means the form is offered again and the
 * index catches the duplicate.
 *
 * The asymmetry is why every pattern requires a verb of receipt, and why the "not yet"
 * list is checked first: the page immediately before the confirmation says "review your
 * application before submitting", which contains most of the words a loose test would
 * look for.
 */
import { detectConfirmation } from './confirmation';

describe('pages that confirm', () => {
  const confirmations = [
    'Thank you for applying to Acme. We have received your application.',
    'Your application has been submitted.',
    'Your application was successfully received.',
    'Application submitted! We will be in touch.',
    'Thanks for your interest in applying to the Backend Engineer role.',
    "We've received your application and will review it shortly.",
    'You have successfully applied to Backend Engineer at Acme.',
    'Application received. Reference: 4123456',
  ];

  it.each(confirmations)('reads "%s" as confirmed', (text) => {
    expect(detectConfirmation(text)).not.toBeNull();
  });

  it('returns the sentence, because that sentence is the evidence', () => {
    const text =
      'Acme Corp\nBackend Engineer\nYour application has been received. ' +
      'We review every application within two weeks.\nPrivacy policy';

    // Stored in Application.confirmationText, and read when a company later says they
    // never got anything. A boolean would record that this system believed it worked.
    expect(detectConfirmation(text)).toBe(
      'Your application has been received.',
    );
  });

  it('caps the stored sentence', () => {
    const wall = `Your application has been received ${'and '.repeat(300)}thank you`;

    expect(detectConfirmation(wall)!.length).toBeLessThanOrEqual(400);
  });
});

describe('pages that do not confirm', () => {
  const notYet = [
    // THE EXPENSIVE FALSE POSITIVE. This is the page immediately before the one being
    // looked for, and it contains "your application" and "submit".
    'Review your application before submitting.',
    'Please complete all required fields before you submit your application.',
    'Ready to submit your application? Check your answers first.',
    // The form itself. Every application form contains the word "application".
    'Apply for Backend Engineer at Acme. Submit application.',
    'Resume/CV is required. Please correct the errors above.',
    // A closed posting.
    'This job is no longer accepting applications.',
    '',
    '   \n  \t ',
  ];

  it.each(notYet)('reads "%s" as not confirmed', (text) => {
    expect(detectConfirmation(text)).toBeNull();
  });

  it('does not let one validation message veto a real confirmation', () => {
    // The other direction: a genuine confirmation page that still has a stale error
    // banner in the DOM. Sentence-wise matching is what keeps both cases right.
    const text =
      'Email is required.\nYour application has been received. Thank you.';

    expect(detectConfirmation(text)).toBe(
      'Your application has been received.',
    );
  });

  it('does not confirm from the company name and the word application alone', () => {
    // The looser version of this function matched the form on load, which would have
    // marked every prepared application as sent.
    expect(
      detectConfirmation('Acme application - Backend Engineer - your details'),
    ).toBeNull();
  });
});
