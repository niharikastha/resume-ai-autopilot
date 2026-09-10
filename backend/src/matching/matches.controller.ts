/**
 * "Find my matches", and the list it produces.
 *
 * UNDER /api/me, so the candidate is the session's user and is never an input - the
 * same rule as DigestController. A user id in the path here would mean being able to
 * spend somebody else's LLM budget and read their shortlist.
 *
 * The run endpoint RETURNS IMMEDIATELY. It reports where the work got to; it does not
 * wait for it. Polling `GET run` is what the screen does, because the alternative is an
 * HTTP request held open for minutes and a browser tab that can abandon a paid run by
 * navigating away.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import { MatchDecision } from '@prisma/client';
import { z } from 'zod';
import { CurrentUser, type SessionUser } from '../auth/auth.constants';
import { MatchesService } from './matches.service';

const listQuery = z.object({
  /** 50 is a screenful with room to scroll; 200 is the honest ceiling of one page. */
  limit: z.coerce.number().int().min(1).max(200).default(50),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  decision: z.nativeEnum(MatchDecision).optional(),
});

/** Nothing to configure yet, and an empty body is allowed. */
const runBody = z.object({}).optional();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestException(
      result.error.issues.map(
        (issue) => `${issue.path.join('.')}: ${issue.message}`,
      ),
    );
  }
  return result.data;
}

@Controller('api/me/matches')
export class MatchesController {
  constructor(private readonly matches: MatchesService) {}

  @Get()
  list(@CurrentUser() user: SessionUser, @Query() query: unknown) {
    const { limit, minScore, decision } = parse(listQuery, query);
    return this.matches.list(user.id, { limit, minScore, decision });
  }

  /**
   * How many postings are waiting on a yes or no, right now.
   *
   * A separate call and not a field on the list, because the list is capped at 200 rows
   * and a total counted from a capped page is a total that silently stops growing.
   */
  @Get('summary')
  summary(@CurrentUser() user: SessionUser) {
    return this.matches.summary(user.id);
  }

  /** Where the current or most recent run got to. Safe to poll. */
  @Get('run')
  status(@CurrentUser() user: SessionUser) {
    return this.matches.status(user.id);
  }

  /**
   * Start a run.
   *
   * A POST because it creates work and spends money. Pressing it twice does not
   * start two runs - the second press is answered with the first run's progress and
   * `started: false`.
   */
  @Post('run')
  start(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    parse(runBody, body);
    return this.matches.run(user.id);
  }
}
