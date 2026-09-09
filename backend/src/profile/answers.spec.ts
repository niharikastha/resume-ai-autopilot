/**
 * The application answers, read and written.
 *
 * WHAT MATTERS HERE, in order:
 *
 *   1. NOTHING IS EVER ASSUMED. `false` for "do you need sponsorship" and 0 for the
 *      notice period are ANSWERS, and a system that reads them as absent asks the
 *      candidate to fill in what they already filled in - or worse, treats "no" as
 *      "unknown" and leaves the box blank on the form.
 *   2. A CLEARED BOX IS CLEARED. This is a PUT, so an empty expected-CTC means delete
 *      the figure. A merge would type a stale salary into the next application.
 *   3. MONEY NEVER BECOMES A FLOAT. The column is numeric and the value stays a string
 *      the whole way, because these are typed verbatim into an employer's form.
 *   4. THE MISSING-FIELD LIST IS ONE LIST. The screen, the dashboard blocker and the
 *      09:00 digest all read it, and they have to agree or the candidate learns to
 *      ignore all three.
 *
 * WHAT IS FAKED. Prisma is a hand-written stub that stores what it is given and hands
 * back a row shaped like the real one, Decimals included. Nothing here checks SQL.
 */
import { BadRequestException } from '@nestjs/common';
import { Prisma, type ApplicationAnswers } from '@prisma/client';
import type { SessionUser } from '../auth/auth.constants';
import type { PrismaService } from '../prisma/prisma.service';
import { missingAnswers } from '../notify/digest.service';
import { AnswersController } from './answers.controller';
import { AnswersService, type AnswersInput } from './answers.service';

const USER = '11111111-1111-4111-8111-111111111111';
const SAVED_AT = new Date('2026-09-08T04:30:00.000Z');

function row(over: Partial<ApplicationAnswers> = {}): ApplicationAnswers {
  return {
    userId: USER,
    workAuthorization: null,
    needsSponsorship: null,
    noticePeriodDays: null,
    currentCtcLpa: null,
    expectedCtcLpa: null,
    willingToRelocate: null,
    earliestStartDate: null,
    customAnswers: null,
    updatedAt: SAVED_AT,
    ...over,
  };
}

/** Just enough Prisma: it remembers the last write and reports it back. */
function fakePrisma(stored: ApplicationAnswers | null) {
  const writes: { create: unknown; update: Record<string, unknown> }[] = [];

  return {
    writes,
    get stored() {
      return stored;
    },
    service: {
      applicationAnswers: {
        findUnique: () => Promise.resolve(stored),
        upsert: (args: {
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          writes.push({ create: args.create, update: args.update });
          // Shaped like the database's answer, not like the input: Decimal columns come
          // back as Decimals, which is what the view has to cope with.
          const data = args.update;
          stored = row({
            ...(data as Partial<ApplicationAnswers>),
            currentCtcLpa: decimal(data.currentCtcLpa),
            expectedCtcLpa: decimal(data.expectedCtcLpa),
            customAnswers: data.customAnswers ?? null,
          });
          return Promise.resolve(stored);
        },
      },
    } as unknown as PrismaService,
  };
}

function decimal(value: unknown): Prisma.Decimal | null {
  return typeof value === 'string' ? new Prisma.Decimal(value) : null;
}

function input(over: Partial<AnswersInput> = {}): AnswersInput {
  return {
    workAuthorization: null,
    needsSponsorship: null,
    noticePeriodDays: null,
    currentCtcLpa: null,
    expectedCtcLpa: null,
    willingToRelocate: null,
    earliestStartDate: null,
    customAnswers: [],
    ...over,
  };
}

describe('AnswersService.view', () => {
  it('reports nothing filled in, and every required field missing', async () => {
    const view = await new AnswersService(fakePrisma(null).service).view(USER);

    expect(view.stated).toBe(false);
    expect(view.updatedAt).toBeNull();
    expect(view.answers.workAuthorization).toBeNull();
    expect(view.missing).toEqual([
      'workAuthorization',
      'needsSponsorship',
      'noticePeriodDays',
      'expectedCtcLpa',
    ]);
  });

  it('treats "no, I do not need sponsorship" and a zero notice period as answers', async () => {
    const view = await new AnswersService(
      fakePrisma(
        row({
          workAuthorization: 'Indian citizen',
          needsSponsorship: false,
          noticePeriodDays: 0,
          expectedCtcLpa: new Prisma.Decimal('32'),
        }),
      ).service,
    ).view(USER);

    // The whole point. `false` and `0` are the two values a falsy check silently loses,
    // and both are ordinary answers for an Indian candidate on notice-free probation.
    expect(view.missing).toEqual([]);
    expect(view.answers.needsSponsorship).toBe(false);
    expect(view.answers.noticePeriodDays).toBe(0);
  });

  it('hands money to the screen as a string, never a number', async () => {
    const view = await new AnswersService(
      fakePrisma(
        row({
          currentCtcLpa: new Prisma.Decimal('12.35'),
          expectedCtcLpa: new Prisma.Decimal('999.99'),
        }),
      ).service,
    ).view(USER);

    expect(view.answers.currentCtcLpa).toBe('12.35');
    expect(view.answers.expectedCtcLpa).toBe('999.99');
  });

  it('gives the date as yyyy-mm-dd, which is the only thing a date box accepts', async () => {
    const view = await new AnswersService(
      fakePrisma(row({ earliestStartDate: new Date('2026-11-01T00:00:00Z') }))
        .service,
    ).view(USER);

    expect(view.answers.earliestStartDate).toBe('2026-11-01');
  });

  it('turns the stored question map into rows, and drops a junk one', async () => {
    const view = await new AnswersService(
      fakePrisma(
        row({
          customAnswers: {
            'Why this company?': 'I use the product daily.',
            'How did you hear about us?': '   ',
            // Not a string. The narrowing in toCustomAnswers is what stops this being
            // typed into a form as "[object Object]".
            Nested: { a: 'b' },
          } as Prisma.JsonValue,
        }),
      ).service,
    ).view(USER);

    expect(view.answers.customAnswers).toEqual([
      { question: 'Why this company?', answer: 'I use the product daily.' },
    ]);
  });
});

describe('AnswersService.save', () => {
  it('stores an empty text box as nothing at all', async () => {
    const prisma = fakePrisma(null);

    await new AnswersService(prisma.service).save(
      USER,
      input({ workAuthorization: '   ' }),
    );

    // '' typed into an employer's field is not "unanswered", it is an answer that says
    // nothing. So it is stored as null and the form leaves the box alone.
    expect(prisma.writes[0].update.workAuthorization).toBeNull();
  });

  it('writes every column on an update, so a cleared field is cleared', async () => {
    const prisma = fakePrisma(
      row({ expectedCtcLpa: new Prisma.Decimal('32'), noticePeriodDays: 60 }),
    );

    await new AnswersService(prisma.service).save(
      USER,
      input({ workAuthorization: 'Indian citizen' }),
    );

    // The failure this prevents: a stale expected CTC the candidate deleted from the
    // screen staying in the row and being typed into the next application.
    expect(prisma.writes[0].update).toMatchObject({
      expectedCtcLpa: null,
      noticePeriodDays: null,
      willingToRelocate: null,
    });
  });

  it('passes money through as the string it arrived as', async () => {
    const prisma = fakePrisma(null);

    const view = await new AnswersService(prisma.service).save(
      USER,
      input({ currentCtcLpa: '12.35', expectedCtcLpa: '18' }),
    );

    expect(prisma.writes[0].update.currentCtcLpa).toBe('12.35');
    expect(view.answers.currentCtcLpa).toBe('12.35');
    expect(view.answers.expectedCtcLpa).toBe('18');
  });

  it('drops half-typed question rows and keeps the last answer to a repeat', async () => {
    const prisma = fakePrisma(null);

    const view = await new AnswersService(prisma.service).save(
      USER,
      input({
        customAnswers: [
          { question: 'Why us?', answer: 'first' },
          { question: '  ', answer: 'orphan answer' },
          { question: 'No answer yet', answer: '' },
          { question: 'Why us?', answer: 'second' },
        ],
      }),
    );

    expect(prisma.writes[0].update.customAnswers).toEqual({
      // The last one wins because it is the one just typed.
      'Why us?': 'second',
    });
    expect(view.answers.customAnswers).toHaveLength(1);
  });

  it('answers with the saved state, so the screen cannot show a stale one', async () => {
    const view = await new AnswersService(fakePrisma(null).service).save(
      USER,
      input({
        workAuthorization: 'Indian citizen, no sponsorship required',
        needsSponsorship: false,
        noticePeriodDays: 30,
        expectedCtcLpa: '24',
      }),
    );

    expect(view.stated).toBe(true);
    expect(view.updatedAt).not.toBeNull();
    expect(view.missing).toEqual([]);
  });
});

describe('AnswersController', () => {
  const user = { id: USER } as SessionUser;

  function controller(stored: ApplicationAnswers | null) {
    const prisma = fakePrisma(stored);
    return {
      prisma,
      routes: new AnswersController(new AnswersService(prisma.service)),
    };
  }

  const complete = {
    workAuthorization: 'Indian citizen',
    needsSponsorship: false,
    noticePeriodDays: 30,
    currentCtcLpa: '12.5',
    expectedCtcLpa: '20',
    willingToRelocate: true,
    earliestStartDate: '2026-11-01',
    customAnswers: [{ question: 'Why us?', answer: 'The product.' }],
  };

  it('accepts a filled-in form and stores it', async () => {
    const { routes, prisma } = controller(null);

    const view = await routes.save(user, complete);

    expect(view.answers.workAuthorization).toBe('Indian citizen');
    expect(view.answers.earliestStartDate).toBe('2026-11-01');
    expect(prisma.writes[0].update.noticePeriodDays).toBe(30);
  });

  it('accepts an empty body as "I have not answered anything yet"', async () => {
    // Every field is nullish in the schema, so the empty object is valid - and it has
    // to be, because a candidate who fills in one box and clears the rest is sending
    // exactly that.
    const { routes } = controller(null);

    const view = await routes.save(user, {});

    expect(view.stated).toBe(true);
    expect(view.missing).toHaveLength(4);
  });

  // Validation refusals throw before anything async happens, hence `expect(() => ...)`.
  it('refuses a salary that is a typo rather than a salary', () => {
    const { routes } = controller(null);

    // 1200000 from someone who meant 12. The ceiling is a typo guard, not a cap.
    expect(() =>
      routes.save(user, { ...complete, expectedCtcLpa: '1200000' }),
    ).toThrow(BadRequestException);
  });

  it('refuses money with more precision than the column holds', () => {
    const { routes } = controller(null);

    expect(() =>
      routes.save(user, { ...complete, currentCtcLpa: '12.3456' }),
    ).toThrow(BadRequestException);
  });

  it('refuses a notice period longer than a year', () => {
    const { routes } = controller(null);

    expect(() =>
      routes.save(user, { ...complete, noticePeriodDays: 400 }),
    ).toThrow(BadRequestException);
  });

  it('refuses a key it does not recognise', () => {
    // Strict, so a field renamed on one side is an error rather than a box that
    // silently never saves.
    const { routes } = controller(null);

    expect(() => routes.save(user, { ...complete, gender: 'female' })).toThrow(
      BadRequestException,
    );
  });

  it('refuses an unbounded pile of saved questions', () => {
    const { routes } = controller(null);
    const many = Array.from({ length: 51 }, (_, i) => ({
      question: `Q${i}`,
      answer: 'a',
    }));

    expect(() =>
      routes.save(user, { ...complete, customAnswers: many }),
    ).toThrow(BadRequestException);
  });

  it('reads a date out of the string a date box sends', async () => {
    const { routes, prisma } = controller(null);

    await routes.save(user, { ...complete, earliestStartDate: '2027-01-15' });

    expect(prisma.writes[0].update.earliestStartDate).toEqual(
      new Date('2027-01-15'),
    );
  });
});

describe('the missing-answer list', () => {
  it('says the same thing to the screen and to the digest', () => {
    // The screen shows `missing` as marks against its own fields; the digest turns the
    // same list into a sentence. If these ever disagree, one of them is nagging about
    // a field the other says is done.
    expect(missingAnswers(null)).toEqual([
      'work authorisation',
      'whether you need sponsorship',
      'notice period',
      'expected CTC',
    ]);

    expect(
      missingAnswers({
        workAuthorization: 'Indian citizen',
        needsSponsorship: false,
        noticePeriodDays: 0,
        expectedCtcLpa: new Prisma.Decimal('20'),
      }),
    ).toEqual([]);
  });
});
