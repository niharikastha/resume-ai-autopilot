/**
 * Reading and writing the answers only the candidate can give.
 *
 * WHAT WAS MISSING UNTIL NOW. The table existed, the form filler read it and the
 * dashboard raised a blocker about it - but nothing anywhere could WRITE it. So every
 * prepared application left work authorization, notice period and both CTC boxes
 * empty, and the daily digest told the candidate to go and fill in a form that did
 * not exist.
 *
 * NOTHING HERE IS INFERRED, AND NOTHING IS DEFAULTED. Every field is nullable and an
 * absent one means "leave that box blank on the form", never "assume the common case".
 * A system that guesses "no sponsorship required" because the candidate lives in India
 * is a system that states someone's visa position for them, on a real application, in
 * writing. Blank is recoverable; wrong is not.
 *
 * NULL AND EMPTY ARE THE SAME THING ON THE WAY IN. A cleared text box arrives as ''
 * and is stored as null, because '' typed into an employer's field is not "unanswered"
 * - it is an answer that says nothing.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { classify } from '../submission/field-policy';
import {
  missingRequiredAnswers,
  normalizeQuestion,
  toStatedAnswers,
  type StatedAnswers,
} from '../submission/answers';

/** One answer to a recurring screening question, as the screen edits them. */
export interface CustomAnswer {
  question: string;
  answer: string;
}

/** What a candidate may write. Money stays a string all the way to Prisma. */
export interface AnswersInput {
  workAuthorization: string | null;
  needsSponsorship: boolean | null;
  noticePeriodDays: number | null;
  currentCtcLpa: string | null;
  expectedCtcLpa: string | null;
  willingToRelocate: boolean | null;
  /** Date only. The time of day means nothing here and would drift by timezone. */
  earliestStartDate: Date | null;
  customAnswers: CustomAnswer[];
}

/**
 * A question a real form asked that nothing here could answer.
 *
 * WHY THIS IS ON THE ANSWERS SCREEN. The library only works if it has the questions in
 * it, and until now the candidate had to guess what those were - type a question from
 * memory, word it the way the board words it, and hope it comes up again. The forms
 * already said: every prepared application records the label of every field it left
 * blank. So the screen offers those back, and answering one is a click plus a sentence.
 */
export interface AskedQuestion {
  /** As the form wrote it, so a stored answer matches the next time it is asked. */
  question: string;
  /** How many prepared applications asked it. The reason to answer this one first. */
  timesAsked: number;
  lastAskedAt: string | null;
  /** True when at least one of those forms would not send without it. */
  required: boolean;
}

/**
 * The questions Indian application forms ask over and over, as starters.
 *
 * QUESTIONS ONLY, AND NEVER AN ANSWER. Every one of these is a fact about the candidate
 * that this system has no business inventing - "willing to work from office" answered
 * "yes" on someone's behalf is a commitment they did not make. They are here because a
 * library with nothing in it is a feature nobody discovers, and because recognising the
 * question is the part a person cannot be expected to do from memory.
 *
 * The four that already have their own box above - authorisation, notice, both CTCs -
 * are deliberately absent. A question offered twice in two mechanisms is two places to
 * answer it and one of them silently losing.
 */
const COMMON_QUESTIONS: readonly string[] = [
  'How did you hear about us?',
  'Total years of professional experience',
  'Current employer',
  'Highest qualification',
  'Year of graduation',
  'Are you willing to work from the office?',
  'Do you have a valid passport?',
  'Are you currently serving your notice period?',
  'Do you have any other offers in hand?',
  'Why do you want to work here?',
];

export interface AnswersView {
  answers: {
    workAuthorization: string | null;
    needsSponsorship: boolean | null;
    noticePeriodDays: number | null;
    currentCtcLpa: string | null;
    expectedCtcLpa: string | null;
    willingToRelocate: boolean | null;
    /** yyyy-mm-dd, which is the only format a date input accepts. */
    earliestStartDate: string | null;
    customAnswers: CustomAnswer[];
  };
  /** False while nothing has ever been saved, so the screen can say so. */
  stated: boolean;
  /** When it was last written, or null. */
  updatedAt: string | null;
  /**
   * The fields that hold up an application, from the one shared rule. The screen
   * marks exactly what the dashboard's blocker is complaining about.
   */
  missing: string[];
  /** Questions this candidate's own forms asked and nothing could answer, commonest
   *  first. Empty until an application has been prepared. */
  asked: AskedQuestion[];
  /** Starters, for a library with nothing in it yet. Ones already stored or already
   *  asked by a real form are left out - see COMMON_QUESTIONS. */
  suggested: string[];
}

@Injectable()
export class AnswersService {
  private readonly logger = new Logger(AnswersService.name);

  constructor(private readonly prisma: PrismaService) {}

  async view(userId: string): Promise<AnswersView> {
    const [row, asked] = await Promise.all([
      this.prisma.applicationAnswers.findUnique({ where: { userId } }),
      this.askedQuestions(userId),
    ]);

    return viewOf(row, toStatedAnswers(row), asked);
  }

  /**
   * Every question this candidate's prepared applications left unanswered.
   *
   * READ BACK OUT OF THE AUDIT JSON, which is where the form filler already writes one
   * entry per field. Nothing new is stored for this, and nothing here is a second
   * opinion about what happened - it is the same record the run log printed.
   *
   * WHAT IS EXCLUDED, AND WHY EACH ONE WOULD BE WRONG TO OFFER:
   *
   *   a key was found       That question belongs to one of the boxes above. Offering
   *                         "Expected CTC" as a library entry too gives the candidate
   *                         two places to answer it, and the form filler reads the
   *                         column first - so the library copy would look answered and
   *                         do nothing.
   *   demographic           Not a gap. Blank is the intended, permanent answer.
   *   consent               A box to tick at the keyboard, not a sentence to store.
   *   (unlabelled)          Not a question, just a field whose label could not be read.
   *                         Storing an answer against that string would match nothing.
   *   already answered      It is in the library. `normalizeQuestion` decides, the same
   *                         way the filler decides at fill time - see viewOf.
   */
  private async askedQuestions(userId: string): Promise<AskedQuestion[]> {
    const rows = await this.prisma.application.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: APPLICATIONS_READ,
      select: { screeningAnswers: true, updatedAt: true },
    });

    /** Keyed on the NORMALIZED question, so one question asked three ways is one row. */
    const byQuestion = new Map<string, AskedQuestion>();

    for (const row of rows) {
      const when = preparedAt(row.screeningAnswers) ?? row.updatedAt.toISOString();

      for (const field of unansweredFields(row.screeningAnswers)) {
        const key = normalizeQuestion(field.question);
        const seen = byQuestion.get(key);
        if (!seen) {
          byQuestion.set(key, {
            question: field.question,
            timesAsked: 1,
            lastAskedAt: when,
            required: field.required,
          });
          continue;
        }
        seen.timesAsked += 1;
        seen.required = seen.required || field.required;
        // Rows arrive newest-first, so the first date seen is the latest one.
        seen.lastAskedAt = seen.lastAskedAt ?? when;
      }
    }

    return [...byQuestion.values()]
      .sort(
        (a, b) =>
          b.timesAsked - a.timesAsked ||
          (b.lastAskedAt ?? '').localeCompare(a.lastAskedAt ?? ''),
      )
      .slice(0, ASKED_MAX);
  }

  /**
   * Saves the whole set.
   *
   * Upsert, and the update writes every column: this is a PUT, so a field the screen
   * left empty is a field the candidate cleared. Merging instead would make deleting
   * a stale expected-CTC impossible from the form that shows it.
   */
  async save(userId: string, input: AnswersInput): Promise<AnswersView> {
    const data = {
      workAuthorization: blankToNull(input.workAuthorization),
      needsSponsorship: input.needsSponsorship,
      noticePeriodDays: input.noticePeriodDays,
      currentCtcLpa: input.currentCtcLpa,
      expectedCtcLpa: input.expectedCtcLpa,
      willingToRelocate: input.willingToRelocate,
      earliestStartDate: input.earliestStartDate,
      customAnswers: toJson(input.customAnswers),
    };

    const row = await this.prisma.applicationAnswers.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });

    const stated = toStatedAnswers(row);
    const asked = await this.askedQuestions(userId);
    // Deliberately NOT logging the values. A log line is the one place these end up
    // somewhere the candidate cannot see or delete, and "current CTC" in a log file
    // is a salary disclosed to whoever reads the server's output.
    this.logger.log(
      `${userId} saved application answers: ${countAnswered(stated)} of 7 fields, ` +
        `${Object.keys(stated.customAnswers).length} saved question(s)`,
    );

    return viewOf(row, stated, asked);
  }
}

/** How many of this candidate's applications the question list is read out of. */
const APPLICATIONS_READ = 100;

/** How many unanswered questions the screen is offered at once. */
const ASKED_MAX = 20;

/**
 * The unanswerable-but-answerable questions in one application's audit record.
 *
 * WRITTEN BY A DIFFERENT PROCESS AND PARSED DEFENSIVELY. It is a Json column, so what
 * comes back is whatever was put in - including records written before `fieldClass`
 * existed on a field. Those are classified from their label here instead, by the same
 * function that classified them then.
 */
function unansweredFields(
  value: Prisma.JsonValue | null,
): { question: string; required: boolean }[] {
  const fields = asRecord(value)?.fields;
  if (!Array.isArray(fields)) return [];

  const out: { question: string; required: boolean }[] = [];
  for (const entry of fields) {
    const field = asRecord(entry);
    if (!field) continue;

    const outcome = field.outcome;
    if (outcome !== 'blank' && outcome !== 'skipped') continue;
    // A key means one of the boxes above owns this question.
    if (field.key !== null && field.key !== undefined) continue;

    const question = typeof field.label === 'string' ? field.label.trim() : '';
    // '(unlabelled)' is the filler's own placeholder for a field whose label could not
    // be read. There is no question there to answer.
    if (question.length === 0 || question === '(unlabelled)') continue;
    if (question.length > QUESTION_MAX) continue;

    // A record written before `fieldClass` existed is classified from its label now,
    // through the same function that classified it then. Cheaper than a migration over
    // a Json column, and it cannot disagree with the filler about what a declaration is
    // the way a second copy of the pattern here would.
    const fieldClass =
      typeof field.fieldClass === 'string'
        ? field.fieldClass
        : classify(question, 'other').fieldClass;
    if (fieldClass === 'demographic' || fieldClass === 'consent') continue;

    out.push({ question, required: field.required === true });
  }
  return out;
}

/** When that application's form was read, from the record itself. */
function preparedAt(value: Prisma.JsonValue | null): string | null {
  const at = asRecord(value)?.preparedAt;
  return typeof at === 'string' && at.length > 0 ? at : null;
}

function asRecord(
  value: Prisma.JsonValue | null | undefined,
): Record<string, Prisma.JsonValue> | null {
  return value !== null &&
    value !== undefined &&
    typeof value === 'object' &&
    !Array.isArray(value)
    ? (value as Record<string, Prisma.JsonValue>)
    : null;
}

/** The same cap the question input on the screen carries. A label longer than this is
 *  a paragraph of instructions, not a question to file an answer under. */
const QUESTION_MAX = 500;

/** The row and its converted form, as the screen needs them. */
function viewOf(
  row: { updatedAt: Date } | null,
  stated: StatedAnswers,
  asked: AskedQuestion[],
): AnswersView {
  // Answered is answered, by whichever wording. Compared the way the form filler
  // compares at fill time, so a question this hides is one it would really answer.
  const answered = new Set(
    Object.keys(stated.customAnswers).map((question) =>
      normalizeQuestion(question),
    ),
  );
  const outstanding = asked.filter(
    (entry) => !answered.has(normalizeQuestion(entry.question)),
  );
  const alreadyOffered = new Set(
    outstanding.map((entry) => normalizeQuestion(entry.question)),
  );

  return {
    answers: {
      workAuthorization: stated.workAuthorization,
      needsSponsorship: stated.needsSponsorship,
      noticePeriodDays: stated.noticePeriodDays,
      currentCtcLpa: stated.currentCtcLpa,
      expectedCtcLpa: stated.expectedCtcLpa,
      willingToRelocate: stated.willingToRelocate,
      earliestStartDate:
        stated.earliestStartDate?.toISOString().slice(0, 10) ?? null,
      customAnswers: Object.entries(stated.customAnswers).map(
        ([question, answer]) => ({ question, answer }),
      ),
    },
    stated: row !== null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
    missing: missingRequiredAnswers(stated),
    asked: outstanding,
    // A starter is only a starter. One a real form has already asked is offered from
    // that list instead, where it carries a count and a date.
    suggested: COMMON_QUESTIONS.filter((question) => {
      const key = normalizeQuestion(question);
      return !answered.has(key) && !alreadyOffered.has(key);
    }),
  };
}

/**
 * `[{question, answer}]` from the screen to the `{question: answer}` the filler reads.
 *
 * A list on the wire because two rows can be half-typed at once and an object cannot
 * hold two blank keys. Blank rows are dropped and a repeated question keeps its LAST
 * answer, which is the one the candidate just typed.
 */
function toJson(entries: CustomAnswer[]): Prisma.InputJsonValue {
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const question = entry.question.trim();
    const answer = entry.answer.trim();
    if (question.length > 0 && answer.length > 0) out[question] = answer;
  }
  return out;
}

/** '' is a cleared box, not an answer that says nothing. */
function blankToNull(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/** For the log line, so it reports progress without reporting content. */
function countAnswered(stated: StatedAnswers): number {
  return [
    stated.workAuthorization,
    stated.needsSponsorship,
    stated.noticePeriodDays,
    stated.currentCtcLpa,
    stated.expectedCtcLpa,
    stated.willingToRelocate,
    stated.earliestStartDate,
  ].filter((value) => value !== null && value !== undefined).length;
}
