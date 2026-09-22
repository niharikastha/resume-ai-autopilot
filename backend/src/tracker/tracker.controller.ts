/**
 * The hand-kept tracker, over HTTP.
 *
 * Under /api/me and scoped by the session, like the rest of this family: no route takes a
 * user id, so one candidate's log is not reachable by changing a parameter.
 *
 * AN ADMIN CANNOT WRITE HERE EITHER, for the same reason PreferencesController,
 * AnswersController and BlockedCompaniesController refuse them. This is somebody's private
 * record of who they asked for a favour and how it went; an operator editing it is not a
 * support action, it is putting words in their mouth. There is deliberately no admin
 * variant of any route below.
 *
 * ONE VIEW, SIX WRITES, and every write returns the whole view - see the note on
 * TrackerService. The screen therefore never has to reconcile a response against what it
 * was already showing.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type SessionUser } from '../auth/auth.constants';
import { TrackerService } from './tracker.service';

/**
 * A link somebody pasted, made usable.
 *
 * TWO JOBS, both of them about what people actually type into a box. The transform adds
 * `https://` when the scheme is missing, because "careers.zoho.com/jobs" copied out of an
 * address bar is a link by any reasonable reading and refusing it teaches nothing. The
 * `protocol` and `hostname` constraints then do the checking that matters:
 *
 *   - `protocol` confines this to http and https. These values come back out as the href
 *     of a link the candidate clicks, and `javascript:` in an href is script execution on
 *     their own dashboard. The prefixing above already mangles most such attempts into
 *     nonsense, but "already mangled by accident" is not the same as refused.
 *   - `hostname` requires a dot, which is what separates a real host from a typo like
 *     "https://zoho" that the URL parser is otherwise perfectly happy with.
 *
 * Blank becomes null rather than an error: an empty box is "I do not have this", which for
 * every field below is a legitimate answer.
 */
const link = z
  .string()
  .trim()
  .max(500)
  .transform((raw) =>
    raw.length === 0 || /^https?:\/\//i.test(raw) ? raw : `https://${raw}`,
  )
  .refine(
    (value) =>
      value.length === 0 ||
      z.url({ protocol: /^https?$/, hostname: /\./ }).safeParse(value).success,
    { message: 'that does not look like a web address' },
  )
  .transform((value) => (value.length === 0 ? null : value));

/** `YYYY-MM-DD`. A bare date, because the column is one - see the schema. */
const day = z.iso.date();

const stage = z.enum([
  'SAVED',
  'APPLIED',
  'SCREENING',
  'INTERVIEWING',
  'OFFER',
  'REJECTED',
  'GHOSTED',
]);

/**
 * A new application.
 *
 * `company` IS THE ONLY REQUIRED FIELD, deliberately. The moment worth capturing is right
 * after hitting submit somewhere, and demanding the exact title, the date and both URLs
 * then is how a tracker stops being kept. Everything else can be filled in later by the
 * PATCH below.
 *
 * The lengths: 120 is longer than any real company name including its legal form, 160
 * covers the longest job titles anybody advertises, and notes are capped at 2000 because
 * they are a reminder rather than a diary.
 */
const applicationBody = z
  .object({
    company: z.string().trim().min(1).max(120),
    role: z.string().trim().max(160).optional(),
    jobUrl: link.optional(),
    careersUrl: link.optional(),
    stage: stage.optional(),
    appliedOn: day.optional(),
    linkedInInviteSent: z.boolean().optional(),
    referralGiven: z.boolean().optional(),
    referrerId: z.uuid().optional(),
    notes: z.string().trim().max(2_000).optional(),
  })
  .strict();

/**
 * An edit.
 *
 * `.nullable()` ON EVERY OPTIONAL FIELD, and that is the point of having a second schema
 * rather than `applicationBody.partial()`. The service reads `undefined` as "leave this
 * alone" and `null` as "clear it", which is the distinction that lets one screen both tick
 * a checkbox without resending the notes AND delete a URL that turned out to be wrong.
 * Without the nullability there would be no way to express the second one at all.
 */
const applicationPatch = z
  .object({
    company: z.string().trim().min(1).max(120).optional(),
    role: z.string().trim().max(160).nullable().optional(),
    jobUrl: link.nullable().optional(),
    careersUrl: link.nullable().optional(),
    stage: stage.optional(),
    appliedOn: day.nullable().optional(),
    linkedInInviteSent: z.boolean().optional(),
    referralGiven: z.boolean().optional(),
    referrerId: z.uuid().nullable().optional(),
    notes: z.string().trim().max(2_000).nullable().optional(),
  })
  .strict();

/** A person. Only the name is required, for the same reason as above. */
const contactBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    company: z.string().trim().max(120).optional(),
    role: z.string().trim().max(160).optional(),
    linkedInUrl: link.optional(),
    email: z.email().max(200).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

const contactPatch = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    company: z.string().trim().max(120).nullable().optional(),
    role: z.string().trim().max(160).nullable().optional(),
    linkedInUrl: link.nullable().optional(),
    email: z.email().max(200).nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

/**
 * The zod failure, as a list of "field: what is wrong with it".
 *
 * PRIVATE TO THIS FILE, on purpose. The other controllers here inline this block because
 * they validate one or two bodies each; this one validates four across six routes, which is
 * where four copies stop being honest duplication and start being four chances to word the
 * same failure differently. Kept local rather than promoted to a shared utility because
 * hoisting it would leave the codebase with two conventions for reporting a bad body and
 * nothing saying which one is current - the version that got it wrong would then be
 * whichever one was read second.
 */
function parsed<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException(
      result.error.issues.map((issue) =>
        issue.path.length > 0
          ? `${issue.path.join('.')}: ${issue.message}`
          : issue.message,
      ),
    );
  }
  return result.data;
}

@Controller('api/me/tracker')
export class TrackerController {
  constructor(private readonly tracker: TrackerService) {}

  @Get()
  view(@CurrentUser() user: SessionUser) {
    return this.tracker.view(user.id);
  }

  @Post('applications')
  addApplication(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    return this.tracker.addApplication(user.id, parsed(applicationBody, body));
  }

  @Patch('applications/:id')
  editApplication(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.tracker.editApplication(
      user.id,
      id,
      parsed(applicationPatch, body),
    );
  }

  /** Returns the list rather than 204, so the screen's counts come back with it. */
  @Delete('applications/:id')
  removeApplication(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tracker.removeApplication(user.id, id);
  }

  @Post('contacts')
  addContact(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    return this.tracker.addContact(user.id, parsed(contactBody, body));
  }

  @Patch('contacts/:id')
  editContact(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.tracker.editContact(user.id, id, parsed(contactPatch, body));
  }

  @Delete('contacts/:id')
  removeContact(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tracker.removeContact(user.id, id);
  }
}
