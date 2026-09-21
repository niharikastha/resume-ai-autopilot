/**
 * The employers you will not apply to, over HTTP.
 *
 * Under /api/me and scoped by the session, like the rest of this family: no route takes
 * a user id, so one candidate's list is not reachable by changing a parameter.
 *
 * AN ADMIN CANNOT WRITE HERE EITHER, and that is the same rule PreferencesController and
 * AnswersController follow. Deciding for somebody else which employers they refuse to
 * work for is exactly the kind of guess that ends in a real application to a company
 * they left on bad terms - or in one never sent to the company they wanted most.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type SessionUser } from '../auth/auth.constants';
import { BlockedCompaniesService } from './blocked-companies.service';

/**
 * A new entry.
 *
 * FREE TEXT, deliberately, where the locations screen uses a fixed catalogue. The
 * reasoning is opposite in the two cases: a typed city would be a term handed straight
 * to the matcher with no way to tell "matched nothing" from "no jobs there", whereas an
 * employer the candidate wants to avoid is very often one this system has never heard
 * of - the company they just left has no row here until some board is crawled. A picker
 * would make the rule unstatable until exactly too late. The screen shows which
 * employers on record each entry covers, which is what makes a typo visible.
 *
 * 120 characters is longer than any real company name including its legal form; the
 * reason is capped at 200 because it is a note to self, not a paragraph.
 */
const addBody = z
  .object({
    label: z.string().trim().min(1).max(120),
    reason: z.string().trim().max(200).optional(),
  })
  .strict();

@Controller('api/me/blocked-companies')
export class BlockedCompaniesController {
  constructor(private readonly blocked: BlockedCompaniesService) {}

  @Get()
  view(@CurrentUser() user: SessionUser) {
    return this.blocked.view(user.id);
  }

  /**
   * POST and not PUT, because this list is not a form: entries are added and removed
   * one at a time, and sending the whole list back would make a stale tab able to
   * restore an employer the candidate removed on their phone.
   */
  @Post()
  add(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    const result = addBody.safeParse(body);
    if (!result.success) {
      throw new BadRequestException(
        result.error.issues.map((issue) =>
          issue.path.length > 0
            ? `${issue.path.join('.')}: ${issue.message}`
            : issue.message,
        ),
      );
    }
    return this.blocked.add(user.id, result.data);
  }

  /** Returns the list rather than 204, so the screen's counts come back with it. */
  @Delete(':id')
  remove(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.blocked.remove(user.id, id);
  }
}
