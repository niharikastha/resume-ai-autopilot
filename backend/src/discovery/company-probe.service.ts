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
import { AtsType, CompanyTier, ProbeResult } from '@prisma/client';
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
  /**
   * The identifier that actually answered, when it is not the slug.
   *
   * Set on a HIT only. This is what goes into `Company.atsToken` and therefore what
   * the daily fetch uses - the slug is the question that was asked, the token is the
   * board that was found, and for SmartRecruiters they differ.
   */
  token?: string;
}

/**
 * What a curated list says about a company, beyond its slug.
 *
 * Passed in rather than derived, because tier is the primary pay signal in this
 * system and a human judgement about an employer. `ensureCompany` will not invent
 * one: absent this, a discovered company is created UNKNOWN and ranks below
 * everything with a tier, which is the failure that loses nothing.
 */
export interface CompanyFacts {
  name?: string;
  tier?: CompanyTier;
  isAgency?: boolean;
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
    options: {
      createCompanies?: boolean;
      recheck?: boolean;
      /** Curated name/tier per slug, from the company list. */
      facts?: Map<string, CompanyFacts>;
    } = {},
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
            `HIT ${connector.source}/${outcome.token ?? slug} - ${outcome.jobsFound} postings`,
          );
          if (options.createCompanies) {
            await this.ensureCompany(
              slug,
              connector,
              outcome.token ?? slug,
              options.facts?.get(slug),
            );
          }
          // Stop at the first hit: a company is on one ATS, and continuing would
          // send four more requests to learn nothing.
          break;
        }
      }
    }

    return outcomes;
  }

  /**
   * Records a board whose ATS and token are already known, without probing.
   *
   * The company list carries these for boards whose identifier is not guessable -
   * SmartRecruiters' `BoschGroup` being the case that forced the field to exist. It
   * is not an optimisation: no sequence of slug guesses finds that board, so without
   * a way to state it outright the 543 India postings on it are unreachable.
   *
   * Returns false when the named ATS has no connector, which is the WORKDAY and
   * CUSTOM case. Those are real boards this system deliberately cannot fetch (PLAN-v2
   * phase 6 drops Workday), so creating a Company row for one would put a board into
   * the daily pass that nothing knows how to read.
   */
  async adoptKnownBoard(input: {
    slug: string;
    atsType: AtsType;
    token: string;
    facts?: CompanyFacts;
  }): Promise<boolean> {
    const connector = CONNECTORS.find((c) => c.atsType === input.atsType);
    if (!connector) {
      this.logger.warn(
        `${input.slug}: no connector for ${input.atsType} - skipped. A board this ` +
          'system cannot fetch does not belong in the daily pass.',
      );
      return false;
    }

    await this.ensureCompany(
      input.slug,
      connector,
      input.token,
      input.facts,
    );
    return true;
  }

  /**
   * One slug against one ATS, across every identifier form that ATS might use.
   *
   * Never throws. A probe is a question whose answer includes "it broke", and a
   * thrown error would end a sweep of hundreds of slugs on the first bad one.
   *
   * With more than one candidate the FIRST HIT wins and the rest are not tried. The
   * recorded outcome is the hit if there was one, otherwise the last candidate's
   * answer - a MISS on `Bosch` and a MISS on `bosch` are the same fact about the
   * slug, and `company_probes` is keyed by slug rather than by token because the
   * question it answers is "is this company on this ATS".
   */
  private async probeOne(
    slug: string,
    connector: Connector,
  ): Promise<ProbeOutcome> {
    const candidates = connector.tokenCandidates?.(slug) ?? [slug];
    let last: ProbeOutcome | undefined;

    for (const token of candidates) {
      const outcome = await this.probeToken(slug, token, connector);
      if (outcome.result === ProbeResult.HIT) return outcome;
      // A FORBIDDEN board exists but cannot be read, so trying another spelling of
      // its name is asking a question that has already been answered.
      if (outcome.result === ProbeResult.FORBIDDEN) return outcome;
      last = outcome;
    }

    return last as ProbeOutcome;
  }

  /** One slug against one ATS under one specific identifier. */
  private async probeToken(
    slug: string,
    token: string,
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
        connector.listUrl(token, 0),
        `probe ${connector.source}/${token}`,
      );

      // The body test. A 200 has been received; whether a board exists is a separate
      // question that only the payload can answer.
      const postings = connector.parse(body, token);

      if (postings.length > 0) {
        return {
          ...base,
          httpStatus: 200,
          jobsFound: postings.length,
          result: ProbeResult.HIT,
          notes: null,
          token,
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
    // A hit under a different identifier records WHICH one, so the row explains
    // itself later: `bosch` hit on SmartRecruiters is a puzzle, `bosch` hit as
    // `BoschGroup` is an answer.
    const notes =
      outcome.token && outcome.token !== outcome.slug
        ? `board token: ${outcome.token}`
        : outcome.notes;

    const parsed = companyProbeInput.safeParse({
      slugTried: outcome.slug,
      atsType: outcome.atsType,
      result: outcome.result,
      httpStatus: outcome.httpStatus,
      jobsFound: outcome.jobsFound,
      notes,
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
   * Tier comes from the curated list or is left UNKNOWN. It is never derived from the
   * slug: tier is the primary pay signal in this system and a human judgement about
   * an employer, so guessing it would put a made-up number into the one field the
   * ranking leans on hardest. UNKNOWN ranks last, which is the honest position for a
   * company nobody has classified.
   */
  private async ensureCompany(
    slug: string,
    connector: Connector,
    token: string,
    facts?: CompanyFacts,
  ): Promise<void> {
    const name = facts?.name ?? slug.charAt(0).toUpperCase() + slug.slice(1);
    const tier = facts?.tier ?? CompanyTier.UNKNOWN;

    // Read before write, because the tier rule cannot be expressed in an upsert: the
    // list may FILL an unclassified tier but must not overwrite one. A tier set by
    // hand in the dashboard is a correction based on something real - an actual offer,
    // a published range - and a sweep re-reading a months-old YAML file should not
    // quietly undo it. Only the tier is protected this way; name and token are facts
    // about the board that the list is the better authority on.
    const existing = await this.prisma.company.findUnique({
      where: { slug },
      select: { tier: true },
    });

    const keepTier =
      existing && existing.tier !== CompanyTier.UNKNOWN
        ? existing.tier
        : (facts?.tier ?? CompanyTier.UNKNOWN);

    await this.prisma.company.upsert({
      where: { slug },
      update: {
        name,
        atsType: connector.atsType,
        atsToken: token,
        active: true,
        tier: keepTier,
        ...(facts?.isAgency !== undefined ? { isAgency: facts.isAgency } : {}),
      },
      create: {
        name,
        slug,
        atsType: connector.atsType,
        atsToken: token,
        tier,
        isAgency: facts?.isAgency ?? tier === CompanyTier.T4_SERVICES_STAFFING,
      },
    });
  }
}
