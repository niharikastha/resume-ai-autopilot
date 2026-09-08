/**
 * The in-app digest, and the yes/no it exists to collect.
 *
 * UNDER /api/me, so every route is scoped by the session's user id and none of them
 * takes a user id as input - the same rule as MeController. Horizontal access here would
 * mean reading which jobs somebody else is applying for, which is about as personal as
 * this system gets.
 *
 * THE DECISION ROUTE IS A PATCH ON A SCORE, not a POST that creates something. Saying
 * "not for me" records an opinion about a posting; it does not create an application,
 * and the application table is not where it goes. See MatchDecision in schema.prisma.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { MatchDecision } from '@prisma/client';
import { z } from 'zod';
import { CurrentUser, type SessionUser } from '../auth/auth.constants';
import { DigestService } from './digest.service';
import { NotifyService } from './notify.service';

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(60).default(14),
});

const decisionBody = z.object({
  decision: z.nativeEnum(MatchDecision),
});

/** Zod at the HTTP boundary, same as everywhere else - one validation story. */
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

@Controller('api/me')
export class DigestController {
  constructor(
    private readonly digests: DigestService,
    private readonly notify: NotifyService,
  ) {}

  /** This morning's digest, or null before the first one has been built. */
  @Get('digest')
  latest(@CurrentUser() user: SessionUser) {
    return this.digests.latest(user.id);
  }

  @Get('digests')
  list(@CurrentUser() user: SessionUser, @Query() query: unknown) {
    return this.digests.list(user.id, parse(listQuery, query).limit);
  }

  @Get('digests/unread')
  async unread(@CurrentUser() user: SessionUser) {
    return { count: await this.digests.unreadCount(user.id) };
  }

  @Get('digests/:id')
  one(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.digests.one(user.id, id);
  }

  @Patch('digests/:id/read')
  @HttpCode(204)
  async markRead(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
  ): Promise<void> {
    await this.digests.markRead(user.id, id);
  }

  /**
   * Wanted, or not for me.
   *
   * The point of the whole phase: tailoring and submission both skip NOT_WANTED, so this
   * is the tap that stops a deep-tier LLM call and a browser session from happening at
   * all. It is reversible - the same route sets it back to UNDECIDED.
   */
  @Patch('jobs/:jobId/decision')
  @HttpCode(204)
  async decide(
    @CurrentUser() user: SessionUser,
    @Param('jobId') jobId: string,
    @Body() body: unknown,
  ): Promise<void> {
    await this.digests.decide(
      user.id,
      jobId,
      parse(decisionBody, body).decision,
    );
  }

  /**
   * Build and send this candidate's digest now, without waiting for 09:00.
   *
   * Scoped to the caller - it cannot be aimed at anybody else, so the worst it can do is
   * mail its own owner. That is also what makes it safe to leave out of the admin
   * surface: an operator testing SMTP does not need to send somebody else's shortlist to
   * do it.
   */
  @Post('digest/send')
  async sendNow(@CurrentUser() user: SessionUser) {
    // `resend: true`: pressing this button is a deliberate request for a copy, so it is
    // the one path allowed to mail a morning that has already been mailed.
    const { built, outcome } = await this.notify.sendFor(user.id, {
      resend: true,
    });
    return { id: built.id, day: built.day, ...outcome };
  }
}
