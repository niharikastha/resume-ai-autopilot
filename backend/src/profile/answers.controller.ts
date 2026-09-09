/**
 * The application answers, over HTTP.
 *
 * NO USER ID IN ANY ROUTE, and no admin variant of these routes anywhere. Section 2A.5
 * of the plan makes this the one class of data an administrator cannot write, and the
 * reason is not access control in the abstract: someone else filling in your notice
 * period or your visa status puts a statement in your name on a real employer's form.
 * An admin who needs a candidate's answers changed asks the candidate.
 *
 * The body schema is `applicationAnswersInput`, which has lived in validation/ since
 * phase 6 waiting for a writer. It carries money as a STRING - see decimalString - so
 * 12.10 LPA stays 12.10 rather than becoming 12.099999999999999 on the way through a
 * float.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Put,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type SessionUser } from '../auth/auth.constants';
import { CUSTOM_ANSWERS_MAX } from '../validation/domain.constants';
import { applicationAnswersInput } from '../validation/domain.schema';
import { AnswersService, type AnswersInput } from './answers.service';

/**
 * The wire body: the stored fields, plus the saved questions as a LIST.
 *
 * A list and not the `{question: answer}` object the column holds, because the screen
 * edits rows and a half-typed row has no key yet. Two blank rows in an object are one
 * blank row.
 */
const answersBody = applicationAnswersInput
  .extend({
    customAnswers: z
      .array(
        z
          .object({
            question: z.string().trim().max(500),
            answer: z.string().trim().max(2_000),
          })
          .strict(),
      )
      // Capped, because this is free text the candidate keeps forever and an unbounded
      // list is an unbounded JSON column.
      .max(CUSTOM_ANSWERS_MAX)
      .default([]),
  })
  .strict();

@Controller('api/me/answers')
export class AnswersController {
  constructor(private readonly answers: AnswersService) {}

  @Get()
  view(@CurrentUser() user: SessionUser) {
    return this.answers.view(user.id);
  }

  /**
   * PUT, so the body is the whole set.
   *
   * A PATCH here would make clearing a field impossible: an expected CTC the candidate
   * deleted from the form arrives as absent, and "absent" in a merge means "keep what
   * you had". The stale figure would then be typed into the next application.
   */
  @Put()
  save(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    const result = answersBody.safeParse(body);
    if (!result.success) {
      throw new BadRequestException(
        result.error.issues.map((issue) =>
          issue.path.length > 0
            ? `${issue.path.join('.')}: ${issue.message}`
            : issue.message,
        ),
      );
    }

    const parsed = result.data;
    // `nullish` in the schema means a key may be absent; the service takes an explicit
    // null for every one of them, because absent and cleared are the same instruction
    // to a PUT and only one of them can reach the database.
    const input: AnswersInput = {
      workAuthorization: parsed.workAuthorization ?? null,
      needsSponsorship: parsed.needsSponsorship ?? null,
      noticePeriodDays: parsed.noticePeriodDays ?? null,
      currentCtcLpa: parsed.currentCtcLpa ?? null,
      expectedCtcLpa: parsed.expectedCtcLpa ?? null,
      willingToRelocate: parsed.willingToRelocate ?? null,
      earliestStartDate: parsed.earliestStartDate ?? null,
      customAnswers: parsed.customAnswers,
    };

    return this.answers.save(user.id, input);
  }
}
