/**
 * The two routes behind "Add a company".
 *
 * ADMIN-ONLY, via `@Roles` on the CLASS so a route added here later inherits it. Two
 * reasons, and neither is about tidiness:
 *
 *   - `POST scan` makes this server fetch a URL somebody typed. That is a request forgery
 *     primitive and it belongs behind the highest privilege the app has. See
 *     `public-url.ts` for what is done about it beyond the role check.
 *   - both routes write to, or read for writing, the shared `companies` table. Every
 *     account's job list is built from it, so one candidate adding a company changes what
 *     every other candidate sees. That is an operator action.
 *
 * Under `api/admin/companies` rather than on AdminController because it needs
 * CompanyAddService, which lives in DiscoveryModule - and importing DiscoveryModule into
 * DashboardModule to reach it would be the wrong direction: the dashboard reads what
 * discovery produced, and nothing in discovery should end up depending on it.
 */
import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { CompanyTier, Role } from '@prisma/client';
import { z } from 'zod';
import { Roles } from '../auth/auth.constants';
import { CompanyAddService } from './company-add.service';

const scanBody = z.object({
  /** Validated properly in the service, which also resolves the host - see public-url.ts.
   *  The cap here is only to stop a megabyte of "URL" reaching that code at all. */
  url: z.string().trim().min(4).max(2000),
  /** Optional: overrides the name guessed from the hostname or read off the page. */
  name: z.string().trim().min(1).max(120).optional(),
  /** Optional, and the operator's judgement. Tier is the primary pay signal in this
   *  system, so it is a human decision rather than something inferred from a URL. */
  tier: z.nativeEnum(CompanyTier).optional(),
});

const commitBody = z.object({
  /** The id of a scan this server produced. The only thing commit accepts - it never
   *  takes a posting, a company or a URL from the client. */
  scanId: z.string().uuid(),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestException(
      result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    );
  }
  return result.data;
}

@Roles(Role.ADMIN)
@Controller('api/admin/companies')
export class CompanyAddController {
  constructor(private readonly companies: CompanyAddService) {}

  /**
   * Looks at a URL and reports what is on it. WRITES NOTHING.
   *
   * A POST despite reading nothing of ours, because it is not idempotent in the way GET
   * promises: it makes outbound requests and may spend an LLM call. A GET with a URL in
   * the query string would also be cached and logged by anything in front of it.
   */
  @Post('scan')
  scan(@Body() body: unknown) {
    return this.companies.scan(parse(scanBody, body));
  }

  /** Saves what a scan found. */
  @Post()
  add(@Body() body: unknown) {
    return this.companies.commit(parse(commitBody, body).scanId);
  }
}
