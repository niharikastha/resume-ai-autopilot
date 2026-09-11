/**
 * Adding one employer by hand, from a URL.
 *
 * The list normally grows by slug guessing: `companies:sweep` invents `acme` from a name
 * and asks five boards whether they have a board by that name. That works at volume and
 * is useless for the one company somebody has just heard about, whose careers page is open
 * in a tab. This is that path - paste the URL, see what is on it, decide, save.
 *
 * TWO STEPS, NOT ONE, AND THE SPLIT IS THE POINT. `scan` fetches and writes NOTHING;
 * `commit` writes what a scan already found. A one-shot "add this URL" would put rows into
 * the shared postings table on the strength of a URL nobody had looked at yet, and the
 * failure it invites is silent: paste a partner directory instead of a careers page and
 * forty companies that do not employ anyone appear as an employer with forty roles.
 *
 * THE ATS PATH IS TRIED FIRST AND THE MODEL IS THE FALLBACK. In order:
 *
 *   1. the URL is matched against the ATS hostnames (`board-url.ts`). A pasted
 *      `jobs.lever.co/acme` is a Lever board and there is nothing to guess.
 *   2. failing that, a slug is guessed from the hostname and probed against all five
 *      connectors. `careers.acme.com` very often turns out to be `acme` on Greenhouse.
 *   3. only if both miss is the page itself downloaded and read by an LLM.
 *
 * The ordering is not about cost. A board gives stable per-posting ids, real descriptions,
 * a link per role, and a fetch every night. A model reading HTML gives a snapshot with
 * none of those - see `WHAT THE CAREERS-PAGE PATH CANNOT DO` below.
 *
 * ADMIN-ONLY, and that is a security decision rather than a tidiness one. This is the only
 * place in the system where the server fetches a URL a human typed, and it writes to the
 * shared `companies` table that every account's job list reads. See `public-url.ts` for
 * what is done about the first part.
 */
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  AtsType,
  Company,
  CompanyTier,
  Prisma,
  RemoteType,
} from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { loadTargets } from '../config/targets';
import { LLM_PROVIDER, type LlmProvider } from '../llm/llm.types';
import { readCareersPageTask } from '../llm/tasks/read-careers-page.task';
import { screenMetadata } from '../matching/stage1.screen';
import { PrismaService } from '../prisma/prisma.service';
import {
  identifyBoardUrl,
  nameFromSlug,
  slugFromHost,
  slugify,
  type BoardIdentity,
} from './board-url';
import { connectorFor, connectorForAts, CONNECTORS } from './connectors';
import type { Connector, RawPosting } from './connectors/types';
import { DiscoveryService } from './discovery.service';
import { htmlToText, looksUnrendered } from './html';
import { DiscoveryHttpClient } from './http.client';
import { normalizeTitle, remoteType } from './normalize';
import { assertPublicUrl, UnsafeUrlError } from './public-url';

/**
 * The pseudo-connector the careers-page path writes under.
 *
 * It exists so `saveBoard` can be reused unchanged: everything after "where did these come
 * from" - validation, the content hash, closing what has vanished - is identical whether a
 * posting arrived as JSON or was read off a page, and a second copy of that logic would be
 * the copy that stops matching the first.
 *
 * `source` is DATA, not a label: it lands in `job_postings.source` and forms half of the
 * `@@unique([source, sourceJobId])` key. Renaming it orphans every posting added this way.
 *
 * `listUrl` throws because there is no list endpoint - that is the whole reason this path
 * exists. Reaching it would mean something tried to fetch this "board", and a thrown error
 * is how that gets noticed instead of silently fetching nothing.
 */
const PAGE_CONNECTOR: Connector = {
  source: 'careers-page',
  atsType: AtsType.CUSTOM,
  listUrl(): string {
    throw new Error(
      'careers-page has no list endpoint - postings come from CompanyAddService, ' +
        'not from a board fetch.',
    );
  },
  parse(): RawPosting[] {
    return [];
  },
};

/**
 * Postings read for a preview, at most.
 *
 * The preview answers one question - "is this the right employer" - and the first
 * screenful answers it. Reading further is somebody else's server time: a Workday board
 * hands back twenty postings per request, so NVIDIA's two thousand roles are a hundred
 * requests and two minutes of waiting to learn what request one already said. The
 * nightly pass reads the whole board; this is only what gets shown before saving.
 */
const PREVIEW_MAX_POSTINGS = 200;

/** How much page text is handed to the model. */
const MAX_PAGE_TEXT_CHARS = 80_000;

/** Below this, whatever came back was a shell for client-side rendering, not a page. */
const MIN_PAGE_TEXT_CHARS = 200;

/**
 * Said when the page's openings only exist after a browser has run its JavaScript.
 *
 * One string for both detections - an all-but-empty page and a page of unfilled
 * placeholders - because they are the same problem to whoever is reading the message, and
 * two wordings would only invite them to wonder what the difference was.
 *
 * It names a way forward, which the old wording did not. TCS's iBegin portal is the case
 * this was written against: pasting the candidate portal is the obvious thing to do, the
 * page is genuinely the job list, and its own JavaScript answers 401 without a login - so
 * there is nothing this application can read there at any effort.
 */
const UNRENDERED =
  'That page loads its job list in the browser after the page arrives, so the openings ' +
  'are not in what the server sends and there is nothing here to read. Two things do ' +
  'work: the address of the underlying job board if the company has one (Greenhouse, ' +
  'Lever, Ashby, SmartRecruiters, Workable), or a page that shows the roles without ' +
  'you having to click "search". Portals that require a login cannot be read at all.';

/** How long a scan stays available to commit. */
const SCAN_TTL_MS = 15 * 60 * 1000;

/** How many scans are remembered at once. */
const MAX_HELD_SCANS = 20;

export interface ScanCompanyRequest {
  url: string;
  /** Overrides the guessed display name. */
  name?: string;
  tier?: CompanyTier;
}

/** One posting as the scan reports it, before anything is written. */
export interface ScannedPosting {
  title: string;
  location: string | null;
  applyUrl: string;
  remoteType: RemoteType;
  /** Whether it passes the same relevance rules the jobs page counts by. */
  suits: boolean;
}

export interface CompanyScan {
  /** Hand this back to `commit`. Expires - see SCAN_TTL_MS. */
  scanId: string;
  /** The URL as fetched: normalised, fragment removed. */
  url: string;
  name: string;
  slug: string;
  atsType: AtsType;
  source: string;
  /** Null on the careers-page path, where there is no board identifier. */
  token: string | null;
  via: 'ats' | 'careers-page';
  /** Set when this employer is already on the list; committing updates it. */
  existing: { id: string; name: string; slug: string } | null;
  postings: ScannedPosting[];
  /** How many of them the jobs page would show under "roles that suit me". */
  suitable: number;
  /**
   * Whether committing writes the postings immediately.
   *
   * False for SmartRecruiters, whose descriptions cost one request per posting - see
   * `skipDetails` in DiscoveryService. Those boards get the company row now and their
   * postings on the next nightly pass, with descriptions, which is the better trade.
   */
  writesPostingsNow: boolean;
  /** Plain sentences to show the operator under the result. */
  notes: string[];
}

export interface CommitResult {
  companyId: string;
  name: string;
  slug: string;
  created: number;
  updated: number;
  closed: number;
  notes: string[];
}

/** A scan held between the two requests. */
interface HeldScan {
  expiresAt: number;
  scan: CompanyScan;
  /** What would be written. Never accepted from the client - see `commit`. */
  raw: RawPosting[];
  connector: Connector | null;
  tier: CompanyTier | undefined;
  domain: string;
}

@Injectable()
export class CompanyAddService {
  private readonly logger = new Logger(CompanyAddService.name);

  /**
   * Scans awaiting a decision, in memory.
   *
   * IN MEMORY ON PURPOSE, and the alternative is worse in two ways. Passing the posting
   * list back through the browser would mean `commit` writes rows the client supplied,
   * so an admin session could write any posting at any company by editing the request -
   * the URL check and the schema would both be bypassed. Re-fetching on commit would
   * instead mean the list that gets written is not the list that was reviewed, which is
   * what the review was for, and on the careers-page path it pays for a second LLM read.
   *
   * The cost of holding it here is that a scan does not survive a restart, and that is
   * exactly what the "scan again" message covers. Bounded by MAX_HELD_SCANS.
   */
  private readonly held = new Map<string, HeldScan>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly discovery: DiscoveryService,
    private readonly http: DiscoveryHttpClient,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
  ) {}

  /**
   * Looks at a URL and reports what is on it. WRITES NOTHING.
   *
   * Every failure here is the operator's to fix - a typo, a private address, a page with
   * no jobs on it - so they all arrive as a 400 with a sentence, not as a 500.
   */
  async scan(request: ScanCompanyRequest): Promise<CompanyScan> {
    if (!this.http.isConfigured()) {
      throw new BadRequestException(
        'DISCOVERY_CONTACT_EMAIL is not set in .env. Outbound requests carry a contact ' +
          'address so a site operator can reach a human, and none are sent without one.',
      );
    }

    const url = await this.publicUrl(request.url);
    const notes: string[] = [];

    // 1 and 2: the board paths.
    const identity =
      identifyBoardUrl(url) ?? (await this.probeForBoard(url, notes));

    const found = identity
      ? await this.fromBoard(url, identity, notes)
      : await this.fromCareersPage(url, request.name, notes);

    const slug = request.name ? slugify(request.name) : found.slug;
    if (!slug) {
      throw new BadRequestException(
        'Could not work out a short name for this company from that address. ' +
          'Type the company name and try again.',
      );
    }

    const existing = await this.findExisting(slug, found.atsType, found.token);

    if (existing && found.via === 'careers-page') {
      const connector = connectorForAts(existing.atsType);
      if (connector) {
        notes.push(
          `${existing.name} is already on the list and is fetched from ${connector.source} ` +
            'every night. Saving will keep that and only add what this page lists.',
        );
      }
    }

    const targets = loadTargets();
    const postings: ScannedPosting[] = found.raw.map((posting) => ({
      title: posting.title,
      location: posting.location || null,
      applyUrl: posting.applyUrl,
      remoteType: posting.remoteType,
      suits: this.suits(posting, targets),
    }));

    const scan: CompanyScan = {
      scanId: randomUUID(),
      url: url.href,
      name: request.name?.trim() || existing?.name || found.name,
      slug: existing?.slug ?? slug,
      atsType: found.atsType,
      source: found.source,
      token: found.token,
      via: found.via,
      existing: existing
        ? { id: existing.id, name: existing.name, slug: existing.slug }
        : null,
      postings,
      suitable: postings.filter((posting) => posting.suits).length,
      writesPostingsNow: found.writesPostingsNow,
      notes,
    };

    this.hold({
      expiresAt: Date.now() + SCAN_TTL_MS,
      scan,
      raw: found.writesPostingsNow ? found.raw : [],
      connector: found.connector,
      tier: request.tier,
      domain: url.hostname.replace(/^www\./, ''),
    });

    return scan;
  }

  /**
   * Writes a scan: the company row, and its postings when they were fetched with
   * descriptions.
   *
   * Takes a scan ID and nothing else. The postings written are the ones this service
   * fetched itself and showed to the operator - the request cannot name a posting, a
   * company or a URL, so there is no version of this call that writes something nobody
   * reviewed.
   */
  async commit(scanId: string): Promise<CommitResult> {
    const held = this.held.get(scanId);
    if (!held || held.expiresAt < Date.now()) {
      this.held.delete(scanId);
      throw new BadRequestException(
        'That scan has expired. Scan the address again and save from the fresh result.',
      );
    }

    const { scan } = held;
    const company = await this.writeCompany(held);
    const notes = [...scan.notes];

    let created = 0;
    let updated = 0;
    let closed = 0;

    if (held.raw.length > 0 && held.connector) {
      const result = await this.discovery.saveBoard(
        company,
        held.connector,
        held.raw,
      );
      created = result.created;
      updated = result.updated;
      closed = result.closed;
    }

    if (!scan.writesPostingsNow) {
      notes.push(
        `${company.name} is on the list now. Its ${scan.postings.length} openings ` +
          'arrive with their full descriptions on tonight’s run, because this board ' +
          'needs one request per posting to read them.',
      );
    }

    // Consumed, not just expired: a second press of the button would otherwise re-run
    // the same write, and on the careers-page path re-run the closure pass against a
    // list that is now a day old.
    this.held.delete(scanId);

    this.logger.log(
      `added ${company.slug} (${scan.source}${scan.token ? `/${scan.token}` : ''}) - ` +
        `${created} new, ${updated} updated, ${closed} closed`,
    );

    return {
      companyId: company.id,
      name: company.name,
      slug: company.slug,
      created,
      updated,
      closed,
      notes,
    };
  }

  // -------------------------------------------------------------------------
  // THE THREE WAYS A BOARD IS FOUND
  // -------------------------------------------------------------------------

  /** Fetches a recognised board. */
  private async fromBoard(
    url: URL,
    identity: BoardIdentity,
    notes: string[],
  ): Promise<Found> {
    const connector = connectorFor(identity.source);
    if (!connector) {
      // Unreachable: identifyBoardUrl only names sources that exist. Checked because a
      // connector removed from the registry later should fail here, not at the fetch.
      throw new BadRequestException(
        `No connector for ${identity.source}, so that board cannot be read.`,
      );
    }

    // Descriptions cost one request per posting on SmartRecruiters, which is minutes for
    // a large board. Skipped for the preview and left to the nightly pass.
    // `!== undefined` rather than `Boolean(...)`: the lint rule about unbound methods is
    // right that naming a method without calling it is usually a mistake, and here the
    // question really is only whether the connector defines one.
    const skipDetails = connector.detailUrl !== undefined;

    let raw: RawPosting[];
    try {
      raw = await this.discovery.previewBoard(connector, identity.token, {
        skipDetails,
        maxPostings: PREVIEW_MAX_POSTINGS,
      });
    } catch (err) {
      throw new BadRequestException(
        `Could not read the ${connector.source} board "${identity.token}" - ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (raw.length === 0) {
      throw new BadRequestException(
        `That is a ${connector.source} board, but it lists no open jobs right now. ` +
          'Nothing was added.',
      );
    }

    notes.push(
      `Read from ${connector.source}, so these openings refresh every night on their own.`,
    );

    if (raw.length >= PREVIEW_MAX_POSTINGS) {
      // Said out loud, because otherwise the count below reads as the size of the
      // board and it is only the size of the sample.
      notes.push(
        `This board has more than ${PREVIEW_MAX_POSTINGS} openings. Only the first ` +
          `${PREVIEW_MAX_POSTINGS} were read to show you here; tonight's run reads ` +
          'all of them.',
      );
    }

    // The connector gets first say, because for Workday the token is three fields
    // joined and only the tenant is the company. Everywhere else this is the token.
    const slug =
      slugify(connector.slugFromToken?.(identity.token) ?? identity.token) ||
      slugFromHost(url.hostname);

    return {
      via: 'ats',
      atsType: identity.atsType,
      source: connector.source,
      token: identity.token,
      connector,
      raw,
      slug,
      name: nameFromSlug(slug),
      writesPostingsNow: !skipDetails,
    };
  }

  /**
   * Tries the hostname's slug against every connector.
   *
   * Up to one request per connector per candidate identifier - about six - and each one
   * that misses is a clean 404. Worth it: a company's own careers page is usually a
   * rendered view of a board that answers with JSON, and finding that board turns a
   * one-off snapshot into a nightly fetch.
   *
   * Not routed through CompanyProbeService, which records every attempt in
   * `company_probes` so a sweep never asks twice. That memory is what makes a sweep of
   * hundreds of slugs affordable and is the wrong behaviour here: an operator retrying a
   * URL after fixing a typo would be told the cached MISS instead of asking again.
   */
  private async probeForBoard(
    url: URL,
    notes: string[],
  ): Promise<BoardIdentity | null> {
    const slug = slugFromHost(url.hostname);
    if (!slug) return null;

    for (const connector of CONNECTORS) {
      // Workday boards are named by a tenant, a data-centre number and a site, so
      // there is nothing here to try. They are recognised from a pasted URL instead.
      if (connector.guessable === false) continue;

      for (const token of connector.tokenCandidates?.(slug) ?? [slug]) {
        try {
          const raw = await this.discovery.previewBoard(connector, token, {
            skipDetails: true,
          });
          if (raw.length === 0) continue;
          notes.push(
            `That page is not a job board, but "${token}" is a real board on ` +
              `${connector.source}, so the openings are being read from there instead.`,
          );
          return {
            atsType: connector.atsType,
            source: connector.source,
            token,
          };
        } catch {
          // A miss is the normal outcome here - four of the five guessable connectors
          // will not have this company. Silent by design; a log line per miss would be
          // six warnings for every successful add.
        }
      }
    }
    return null;
  }

  /**
   * WHAT THE CAREERS-PAGE PATH CANNOT DO, stated once so nobody has to find out.
   *
   *   - it does not refresh. `connectorForAts(CUSTOM)` returns nothing, so the nightly
   *     pass skips these companies. A role taken down stays listed until somebody scans
   *     the page again.
   *   - the postings usually have no description, because most listing pages carry a
   *     title and a city and nothing else. Stage 1 of matching refuses a posting with an
   *     empty description, so THESE POSTINGS WILL NOT BE SCORED. They still appear in the
   *     jobs list and still count as "suits me", because that test reads the title,
   *     location and seniority only.
   *   - the ids are hashes of title and location, not the employer's own ids, so a
   *     retitled role reads as a new posting and the old one closes.
   *
   * All three are consequences of the page being the only source. They are why the two
   * board paths are tried first, and why the note below says so out loud.
   */
  private async fromCareersPage(
    url: URL,
    typedName: string | undefined,
    notes: string[],
  ): Promise<Found> {
    const slug = typedName ? slugify(typedName) : slugFromHost(url.hostname);
    const guessedName = typedName?.trim() || nameFromSlug(slug);

    let html: string;
    try {
      html = await this.http.fetchText(
        url.href,
        `careers/${slug || url.hostname}`,
      );
    } catch (err) {
      throw new BadRequestException(
        `Could not open that page - ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const text = htmlToText(html).slice(0, MAX_PAGE_TEXT_CHARS);
    if (text.length < MIN_PAGE_TEXT_CHARS) {
      throw new BadRequestException(UNRENDERED);
    }

    // Before the model, not after. A page whose openings only exist once a browser has
    // run its code cannot be read no matter how good the model is, so paying for an Opus
    // call to be told so is money spent to arrive at the answer already in hand.
    if (looksUnrendered(text, html.length)) {
      throw new BadRequestException(UNRENDERED);
    }

    const answer = await this.llm.complete(
      readCareersPageTask,
      { version: 1 },
      { companyName: guessedName, pageUrl: url.href, pageText: text },
    );

    if (answer.value.postings.length === 0) {
      // Both causes named, because `looksUnrendered` above does not catch every shell -
      // one that ships its data as JSON inside a script tag leaves plenty of text and no
      // placeholders. Naming only the operator's mistake would send them to re-check an
      // address that was right all along.
      throw new BadRequestException(
        'Nothing on that page looks like an open role. Either it is not the list of ' +
          'jobs - an "about us" or "life here" page - or the list is loaded by the ' +
          'browser after the page arrives, which leaves nothing to read.',
      );
    }

    notes.push(
      'Read off the page by AI, because no job board answered for this company. ' +
        'These openings do not refresh on their own - scan the page again to update them.',
    );
    notes.push(
      'Most of them will have no job description, so they cannot be scored or tailored ' +
        'against - they will show in the list with their title and city only.',
    );

    const raw = answer.value.postings.map((posting) =>
      this.pagePosting(posting, url, slug),
    );

    return {
      via: 'careers-page',
      atsType: AtsType.CUSTOM,
      source: PAGE_CONNECTOR.source,
      // The page URL IS the board identifier for an in-house listing, which is what the
      // column means for AtsType.CUSTOM. It also makes @@unique([atsType, atsToken])
      // stop the same page being added twice under two names.
      token: url.href,
      connector: PAGE_CONNECTOR,
      raw,
      slug,
      name: answer.value.companyName?.trim() || guessedName,
      writesPostingsNow: true,
    };
  }

  /** One LLM-reported listing as a RawPosting. */
  private pagePosting(
    posting: {
      title: string;
      location: string | null;
      url: string | null;
      summary: string | null;
    },
    pageUrl: URL,
    slug: string,
  ): RawPosting {
    const location = posting.location ?? '';
    const summary = posting.summary ?? '';

    return {
      // Deterministic, so scanning the same page twice updates its postings instead of
      // inserting a second copy of each. Hashed rather than a counter for the same
      // reason: a page that reorders its list must not renumber every role.
      sourceJobId: `page:${slug}:${createHash('sha256')
        .update(
          `${normalizeTitle(posting.title)}|${location.toLowerCase().trim()}`,
        )
        .digest('hex')
        .slice(0, 32)}`,
      title: posting.title,
      location,
      // The summary is stored as both, and it is not markup: `descriptionRaw` is meant to
      // be what the source gave us so a parsing change can be re-run against it, and here
      // the text IS what the source gave us.
      descriptionRaw: summary,
      descriptionText: summary,
      applyUrl: this.samePageUrl(posting.url, pageUrl) ?? pageUrl.href,
      remoteType: remoteType(location),
      // A listing page states a date about as often as it states a salary. Null rather
      // than "today", which would put every added company at the top of a date sort.
      postedAt: null,
      salary: null,
      department: null,
      employmentType: null,
    };
  }

  /**
   * A per-posting link, but only if it stays on the page's own site.
   *
   * THE URL RE-VALIDATION THE LLM TASK'S HEADER PROMISES. The model is reading an
   * untrusted document, and a document can say "apply at https://evil.example/login" -
   * which would then be rendered as this employer's apply button and clicked. A link off
   * the page's own host is dropped and the page URL is used instead: the operator lands on
   * the careers page and finds the role, which is a worse link and not a dangerous one.
   *
   * Subdomains are allowed in both directions because a real listing at
   * `acme.com/careers` links to `jobs.acme.com/123` constantly. That does mean trusting
   * everything under the pasted domain, which is the same trust already extended by
   * fetching the page at all.
   */
  private samePageUrl(candidate: string | null, pageUrl: URL): string | null {
    if (!candidate) return null;

    let resolved: URL;
    try {
      resolved = new URL(candidate, pageUrl);
    } catch {
      return null;
    }

    if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:')
      return null;

    const host = resolved.hostname.toLowerCase().replace(/^www\./, '');
    const page = pageUrl.hostname.toLowerCase().replace(/^www\./, '');
    const related =
      host === page || host.endsWith(`.${page}`) || page.endsWith(`.${host}`);
    if (!related) {
      this.logger.warn(
        `careers page ${pageUrl.hostname} listed an apply link at ${host} - dropped`,
      );
      return null;
    }

    return resolved.href;
  }

  // -------------------------------------------------------------------------
  // WRITES AND LOOKUPS
  // -------------------------------------------------------------------------

  /**
   * Creates or updates the company row.
   *
   * The one subtlety is the guard on `atsType`. A company already fetched nightly from
   * Greenhouse must not be turned into a CUSTOM careers-page company by somebody pasting
   * its marketing careers URL - that would silently end its nightly refresh, and the
   * postings would look fine for a week before going stale.
   */
  private async writeCompany(held: HeldScan): Promise<Company> {
    const { scan } = held;

    // Empty when the existing row must keep the board it already has.
    const board =
      scan.via === 'careers-page' &&
      (await this.alreadyHasABoard(scan.existing))
        ? {}
        : { atsType: scan.atsType, atsToken: scan.token };

    try {
      return await this.prisma.company.upsert({
        where: { slug: scan.slug },
        create: {
          name: scan.name,
          slug: scan.slug,
          domain: held.domain,
          atsType: scan.atsType,
          atsToken: scan.token,
          tier: held.tier ?? CompanyTier.UNKNOWN,
          active: true,
        },
        update: {
          name: scan.name,
          domain: held.domain,
          ...board,
          // Only ever set, never cleared: an operator who leaves the tier blank on a
          // company already classified T1 should not demote it to UNKNOWN, because tier
          // is the primary pay signal and a human put that value there.
          ...(held.tier ? { tier: held.tier } : {}),
          // A company added by hand is one somebody wants fetched, including one that a
          // previous sweep had switched off.
          active: true,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new BadRequestException(
          `That board is already on the list under a different company name. ` +
            'Open the companies list and edit that one instead.',
        );
      }
      throw err;
    }
  }

  /**
   * True when an existing company is already fetched from a real board.
   *
   * Read from the database rather than from the scan, because the scan is up to fifteen
   * minutes old by the time it is committed and a nightly pass may have run in between.
   */
  private async alreadyHasABoard(
    existing: { id: string } | null,
  ): Promise<boolean> {
    if (!existing) return false;
    const row = await this.prisma.company.findUnique({
      where: { id: existing.id },
      select: { atsType: true },
    });
    if (!row) return false;
    return connectorForAts(row.atsType) !== undefined;
  }

  /**
   * The company this scan would touch, if any.
   *
   * Checked by board identity FIRST and by slug second. The slug is a guess and the board
   * identity is a fact: `careers.zeta.tech` guesses `zeta` while the existing row may be
   * `zetasuite`, and matching only on the slug would create a duplicate employer holding
   * the same Greenhouse board - which the unique constraint then refuses at write time,
   * after the operator has already been shown a clean-looking scan.
   */
  private async findExisting(
    slug: string,
    atsType: AtsType,
    token: string | null,
  ): Promise<Company | null> {
    if (token) {
      const byBoard = await this.prisma.company.findFirst({
        where: { atsType, atsToken: token },
      });
      if (byBoard) return byBoard;
    }
    return this.prisma.company.findUnique({ where: { slug } });
  }

  /**
   * Whether the jobs page would count this posting under "roles that suit me".
   *
   * `screenMetadata` is stage 1 of matching minus the parts that need a description or a
   * database - the same function `relevance.sql.ts` mirrors into SQL. Calling it here
   * rather than re-deriving the rules is the point: a scan that promised 12 suitable roles
   * and a jobs page that then showed 3 would be a bug nobody could explain.
   */
  private suits(
    posting: RawPosting,
    targets: ReturnType<typeof loadTargets>,
  ): boolean {
    return screenMetadata(
      {
        title: posting.title,
        normalizedTitle: normalizeTitle(posting.title),
        location: posting.location || null,
        remoteType: posting.remoteType,
        // Both null, and stage 1 treats an unknown bound as "does not disqualify". The
        // years-of-experience figures are read out of the description by phase 4, which
        // has not run on a posting that does not exist yet.
        seniority: null,
        yoeMin: null,
        yoeMax: null,
        postedAt: posting.postedAt,
      },
      targets,
    ).pass;
  }

  /** Parses and refuses a URL, as an operator-facing 400. */
  private async publicUrl(raw: string): Promise<URL> {
    try {
      return await assertPublicUrl(raw);
    } catch (err) {
      if (err instanceof UnsafeUrlError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  /** Remembers a scan, dropping expired and then oldest entries to stay under the cap. */
  private hold(entry: HeldScan): void {
    const now = Date.now();
    for (const [id, existing] of this.held) {
      if (existing.expiresAt < now) this.held.delete(id);
    }
    // Map iterates in insertion order, so the first key is the oldest.
    while (this.held.size >= MAX_HELD_SCANS) {
      const oldest = this.held.keys().next();
      if (oldest.done) break;
      this.held.delete(oldest.value);
    }
    this.held.set(entry.scan.scanId, entry);
  }
}

/** What one of the three lookup paths found. Internal to this file. */
interface Found {
  via: 'ats' | 'careers-page';
  atsType: AtsType;
  source: string;
  token: string | null;
  connector: Connector | null;
  raw: RawPosting[];
  slug: string;
  name: string;
  writesPostingsNow: boolean;
}
