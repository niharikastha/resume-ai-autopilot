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
import {
  missingRequiredAnswers,
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
}

@Injectable()
export class AnswersService {
  private readonly logger = new Logger(AnswersService.name);

  constructor(private readonly prisma: PrismaService) {}

  async view(userId: string): Promise<AnswersView> {
    const row = await this.prisma.applicationAnswers.findUnique({
      where: { userId },
    });

    return viewOf(row, toStatedAnswers(row));
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
    // Deliberately NOT logging the values. A log line is the one place these end up
    // somewhere the candidate cannot see or delete, and "current CTC" in a log file
    // is a salary disclosed to whoever reads the server's output.
    this.logger.log(
      `${userId} saved application answers: ${countAnswered(stated)} of 7 fields, ` +
        `${Object.keys(stated.customAnswers).length} saved question(s)`,
    );

    return viewOf(row, stated);
  }
}

/** The row and its converted form, as the screen needs them. */
function viewOf(
  row: { updatedAt: Date } | null,
  stated: StatedAnswers,
): AnswersView {
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
