import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import { ApplicationStatus, Role } from '@prisma/client';
import { z } from 'zod';
import { CurrentUser, Roles, type SessionUser } from '../auth/auth.constants';
import { AuthService } from '../auth/auth.service';
import { DashboardService } from './dashboard.service';

/**
 * The company filter, as `?companyIds=a,b,c`.
 *
 * Comma-separated rather than a repeated key, because a repeated key arrives as a string
 * when there is one value and an array when there are several, and every consumer then has
 * to remember that. Each id is still validated as a uuid - the list goes into an `IN`
 * through Prisma.sql, so this is defence in depth rather than the only guard.
 *
 * The 60 cap is the point where the filter has stopped narrowing anything: there are 142
 * employers, and a selection that large is a longer URL to express "all of them".
 */
const companyIds = z
  .string()
  .max(2500)
  .transform((raw) => raw.split(',').map((id) => id.trim()))
  .pipe(z.array(z.string().uuid()).max(60))
  .optional();

/**
 * Whether a jobs-page query means "roles that suit me" or "every posting".
 *
 * Defaulting to `suits` is the decision the page is built on. A count of every open
 * posting on an employer's board is a number about the employer, not about the reader -
 * OpenAI's 780 openings are mostly sales and marketing roles outside India.
 */
const only = z.enum(['suits', 'all']).default('suits');

const jobsQuery = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  source: z.string().trim().max(40).optional(),
  tier: z.string().trim().max(40).optional(),
  /** Set when a company row on the jobs page is expanded. */
  companyId: z.string().uuid().optional(),
  companyIds,
  only,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const companyGroupsQuery = z.object({
  /** Matches a company NAME. The postings query's `q` matches a job title, and the
   *  two are deliberately not the same parameter - typing "engineer" into the company
   *  search finding nothing is correct, and would be baffling if it silently searched
   *  titles instead. */
  q: z.string().trim().min(1).max(120).optional(),
  tier: z.string().trim().max(40).optional(),
  companyIds,
  only,
  sort: z.enum(['postings', 'name', 'score']).default('postings'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const applicationsQuery = z.object({
  status: z.nativeEnum(ApplicationStatus).optional(),
});

const setActiveBody = z.object({ active: z.boolean() });

/** Zod at the HTTP boundary, same as at the LLM boundary - one validation story. */
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestException(
      result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    );
  }
  return result.data;
}

/**
 * ADMIN SURFACE. Everything about the machine: the discovery funnel, connector
 * health, the company list, run history, accounts, integration status.
 *
 * @Roles is on the CLASS, so a route added to this controller later is
 * admin-only without anyone having to remember to mark it.
 */
@Roles(Role.ADMIN)
@Controller('api/admin')
export class AdminController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly auth: AuthService,
  ) {}

  @Get('overview')
  overview() {
    return this.dashboard.adminOverview();
  }

  @Get('companies')
  companies(@Query('limit') limit?: string) {
    return this.dashboard.companies(
      parse(
        z.coerce.number().int().min(1).max(1000).default(500),
        limit ?? 500,
      ),
    );
  }

  @Get('runs')
  runs(@Query('limit') limit?: string) {
    return this.dashboard.runs(
      parse(z.coerce.number().int().min(1).max(200).default(50), limit ?? 50),
    );
  }

  /** Every account's applications, each labelled with its owner. */
  @Get('applications')
  applications(@Query() query: unknown) {
    return this.dashboard.adminApplications(
      parse(applicationsQuery, query).status,
    );
  }

  @Get('users')
  users() {
    return this.dashboard.users();
  }

  /**
   * Approve a pending signup, or suspend an account. The only write an admin has
   * over somebody else's account, and deliberately so: it toggles whether they
   * may sign in and nothing else.
   *
   * It does NOT grant a role, and there is no route here that does. Promoting
   * someone to admin stays a CLI operation, because it needs shell access to the
   * host rather than a session that a phished admin could be tricked into using.
   * It also cannot touch the personal answers that go into an application
   * (PLAN-v2 2A.1) - an admin can see those are blank and cannot fill them in.
   */
  @Patch('users/:id/active')
  @HttpCode(204)
  async setUserActive(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() actor: SessionUser,
  ): Promise<void> {
    const { active } = parse(setActiveBody, body);
    await this.auth.setActive(id, active, actor);
  }

  @Get('integrations')
  integrations() {
    return this.dashboard.integrations();
  }
}

/**
 * CANDIDATE SURFACE. Available to both roles - an admin is also a candidate, so
 * they use these same routes for their own job search rather than a parallel
 * copy.
 *
 * Every method is scoped by the session's user id. No route here takes a user id
 * as input, which is what makes horizontal access (reading someone else's data
 * by changing a parameter) not merely blocked but unexpressible.
 */
@Controller('api/me')
export class MeController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('overview')
  overview(@CurrentUser() user: SessionUser) {
    return this.dashboard.userOverview(user.id);
  }

  /** Shared postings, with this viewer's own score attached. */
  @Get('jobs')
  jobs(@CurrentUser() user: SessionUser, @Query() query: unknown) {
    return this.dashboard.jobs({
      ...parse(jobsQuery, query),
      viewerId: user.id,
    });
  }

  /**
   * The employers, each with a count of what is open there.
   *
   * The jobs page is a list of these, and expanding one calls `jobs` above with its
   * companyId. Two calls rather than one nested response, so opening the biggest
   * employer fetches its 900 postings only when somebody asks for them.
   */
  @Get('jobs/companies')
  jobCompanies(@CurrentUser() user: SessionUser, @Query() query: unknown) {
    return this.dashboard.companyGroups({
      ...parse(companyGroupsQuery, query),
      viewerId: user.id,
    });
  }

  /**
   * Every employer name, for the company filter's list.
   *
   * Above `jobs/companies` in usefulness-per-byte and unrelated to it: no counts, no
   * scores, no paging, so the filter can hold all 142 names and search them locally.
   */
  @Get('jobs/company-names')
  jobCompanyNames() {
    return this.dashboard.companyNames();
  }

  @Get('applications')
  applications(@CurrentUser() user: SessionUser, @Query() query: unknown) {
    return this.dashboard.applications(
      user.id,
      parse(applicationsQuery, query).status,
    );
  }
}
