/**
 * Finding out which ATS a company uses, by asking.
 *
 * There is no directory mapping "company" to "job board", so the only way to learn
 * that Acme is on Lever is to try Acme's slug against each ATS and see which one
 * answers with jobs. That is what this does, and the results are cached in
 * `company_probes` so a slug is never tried twice.
 *
 * ABSENCE IS DETECTED BY BODY CONTENT, NOT BY STATUS CODE. This is the rule the
 * whole file is shaped around. Several ATS vendors - Keka, Zoho People and
 * Darwinbox among them - return HTTP 200 for a tenant that does not exist, serving a
 * generic page or an empty envelope. Lever does the same thing in its own way: a
 * wrong token yields 200 with `{"ok":false,"error":...}` instead of the array a real
 * board returns. Trusting the status code means recording a HIT for every slug ever
 * tried, which would fill the company list with boards that are not there.
 */
import { Injectable, Logger } from '@nestjs/common';
import { AtsType, ProbeResult } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { companyProbeInput } from '../validation/domain.schema';
import { CONNECTORS } from './connectors';
import { Connector } from './connectors/types';
import { DiscoveryHttpClient, FetchError } from './http.client';

export interface ProbeOutcome {
  slug: string;
  atsType: AtsType;
  result: ProbeResult;
  httpStatus: number | null;
  jobsFound: number | null;
  notes: string | null;
}

@Injectable()
export class CompanyProbeService {
  private readonly logger = new Logger(CompanyProbeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: DiscoveryHttpClient,
  ) {}

  /**
   * Probes each slug against every ATS, skipping combinations already recorded.
   *
   * `createCompanies` turns a HIT into a Company row. Off by default: adding a
   * company puts it into the daily pass, and that should be a decision rather than a
   * side effect of looking.
   */
  async probeMany(
    slugs: string[],
    options: { createCompanies?: boolean; recheck?: boolean } = {},
  ): Promise<ProbeOutcome[]> {
    if (!this.http.isConfigured()) {
      throw new FetchError(
        'DISCOVERY_CONTACT_EMAIL is not set - refusing to probe. Every outbound ' +
          'request carries a contact address so a site operator can reach a human.',
        null,
      );
    }

    const outcomes: ProbeOutcome[] = [];

    for (const raw of slugs) {
      const slug = raw.trim().toLowerCase();
      if (!slug) continue;

      for (const connector of CONNECTORS) {
        if (!options.recheck) {
          const seen = await this.prisma.companyProbe.findUnique({
            where: {
              slugTried_atsType: {
                slugTried: slug,
                atsType: connector.atsType,
              },
            },
            select: { result: true },
          });
          // Already answered. Re-asking wastes a request on a question whose answer
          // does not change - a company's ATS is not a daily variable.
          if (seen) continue;
        }

        const outcome = await this.probeOne(slug, connector);
        outcomes.push(outcome);
        await this.record(outcome);

        if (outcome.result === ProbeResult.HIT) {
          this.logger.log(
            `HIT ${connector.source}/${slug} - ${outcome.jobsFound} postings`,
          );
          if (options.createCompanies)
            await this.ensureCompany(slug, connector);
          // Stop at the first hit: a company is on one ATS, and continuing would
          // send four more requests to learn nothing.
          break;
        }
      }
    }

    return outcomes;
  }

  /**
   * One slug against one ATS.
   *
   * Never throws. A probe is a question whose answer includes "it broke", and a
   * thrown error would end a sweep of hundreds of slugs on the first bad one.
   */
  private async probeOne(
    slug: string,
    connector: Connector,
  ): Promise<ProbeOutcome> {
    const base = {
      slug,
      atsType: connector.atsType,
      httpStatus: null as number | null,
      jobsFound: null as number | null,
    };

    try {
      const body = await this.http.fetchJson<unknown>(
        connector.listUrl(slug, 0),
        `probe ${connector.source}/${slug}`,
      );

      // The body test. A 200 has been received; whether a board exists is a separate
      // question that only the payload can answer.
      const postings = connector.parse(body, slug);

      if (postings.length > 0) {
        return {
          ...base,
          httpStatus: 200,
          jobsFound: postings.length,
          result: ProbeResult.HIT,
          notes: null,
        };
      }

      const declared = connector.totalAvailable?.(body) ?? null;
      if (declared !== null && declared > 0) {
        // The board exists and says it has roles, but nothing survived parsing. That
        // is a mapping bug in our connector, not an absent tenant, and conflating the
        // two would hide it.
        return {
          ...base,
          httpStatus: 200,
          jobsFound: 0,
          result: ProbeResult.ERROR,
          notes: `board declares ${declared} postings but none parsed - connector mapping may be wrong`,
        };
      }

      return {
        ...base,
        httpStatus: 200,
        jobsFound: 0,
        // 200 with nothing in it. MISS rather than TENANT_NOT_FOUND: a real board
        // that currently has no openings looks exactly like this, and the two are
        // genuinely indistinguishable from here.
        result: ProbeResult.MISS,
        notes: '200 with no postings - either an empty board or no such tenant',
      };
    } catch (err) {
      const error = err instanceof FetchError ? err : null;
      const status = error?.status ?? null;
      const message = err instanceof Error ? err.message : String(err);

      if (status === 404 || status === 410) {
        return {
          ...base,
          httpStatus: status,
          result: ProbeResult.TENANT_NOT_FOUND,
          notes: null,
        };
      }
      if (status === 401 || status === 403) {
        // Not "no board" - a board we are not allowed to read. Worth distinguishing,
        // because the answer is to stop asking rather than to try a different slug.
        return {
          ...base,
          httpStatus: status,
          result: ProbeResult.FORBIDDEN,
          notes: message.slice(0, 200),
        };
      }

      return {
        ...base,
        httpStatus: status,
        result: ProbeResult.ERROR,
        notes: message.slice(0, 200),
      };
    }
  }

  /** Writes the probe, validated by the same schema the API would use. */
  private async record(outcome: ProbeOutcome): Promise<void> {
    const parsed = companyProbeInput.safeParse({
      slugTried: outcome.slug,
      atsType: outcome.atsType,
      result: outcome.result,
      httpStatus: outcome.httpStatus,
      jobsFound: outcome.jobsFound,
      notes: outcome.notes,
    });

    if (!parsed.success) {
      this.logger.warn(
        `probe result for ${outcome.slug}/${outcome.atsType} failed validation: ` +
          parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; '),
      );
      return;
    }

    const v = parsed.data;
    await this.prisma.companyProbe.upsert({
      where: {
        slugTried_atsType: { slugTried: v.slugTried, atsType: outcome.atsType },
      },
      create: {
        slugTried: v.slugTried,
        atsType: outcome.atsType,
        result: outcome.result,
        httpStatus: v.httpStatus ?? null,
        jobsFound: v.jobsFound ?? null,
        notes: v.notes ?? null,
      },
      update: {
        result: outcome.result,
        httpStatus: v.httpStatus ?? null,
        jobsFound: v.jobsFound ?? null,
        notes: v.notes ?? null,
        probedAt: new Date(),
      },
    });
  }

  /**
   * Creates the Company row for a hit, if it is not already there.
   *
   * Tier is left UNKNOWN. It is the primary pay signal in this system and it is a
   * human judgement about an employer - guessing it from a slug would put a made-up
   * number into the one field the ranking leans on hardest.
   */
  private async ensureCompany(
    slug: string,
    connector: Connector,
  ): Promise<void> {
    await this.prisma.company.upsert({
      where: { slug },
      update: { atsType: connector.atsType, atsToken: slug, active: true },
      create: {
        name: slug.charAt(0).toUpperCase() + slug.slice(1),
        slug,
        atsType: connector.atsType,
        atsToken: slug,
      },
    });
  }
}
