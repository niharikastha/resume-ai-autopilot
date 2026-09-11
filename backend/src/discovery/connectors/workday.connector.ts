/**
 * Workday job boards - the big-employer source.
 *
 * WHY THIS IS WORTH THE TROUBLE. Workday is what most large employers run their
 * hiring on, and none of them were reachable before this: NVIDIA, Salesforce and
 * Adobe each have a board with hundreds to thousands of open roles, full
 * descriptions, and no login. The four boards already read here skew towards
 * venture-funded technology companies, so this is the single largest addition of
 * established employers available - which is why it was built ahead of the Indian IT
 * services firms, who each run their own unreadable portal.
 *
 * Endpoints, verified live against nvidia/wd5/NVIDIAExternalCareerSite:
 *   list   POST /wday/cxs/{tenant}/{site}/jobs   {"appliedFacets":{},"limit":20,
 *                                                 "offset":N,"searchText":""}
 *          -> { total, jobPostings: [{ title, externalPath, locationsText,
 *                                      postedOn, bulletFields }] }
 *   detail GET  /wday/cxs/{tenant}/{site}{externalPath}
 *          -> { jobPostingInfo: { id, title, jobDescription, location,
 *                                 additionalLocations, startDate, timeType,
 *                                 jobReqId, externalUrl, country } }
 *
 * THREE THINGS ABOUT THIS SOURCE ARE UNLIKE THE OTHER FIVE.
 *
 * 1. THE LIST IS A POST. The offset lives in a JSON body, not a query string, which
 *    is what put `listBody` on the Connector interface. The body is a search query
 *    and changes nothing, so it retries like a GET.
 *
 * 2. THE PAGE SIZE IS 20 AND THAT IS A HARD CEILING. Measured, not assumed: `limit`
 *    of 25, 50 or 100 all answer HTTP 400. So a 2,000-role board is 100 list requests
 *    before the descriptions are even started.
 *
 * 3. IT IS THE EXPENSIVE PATH, MORE SO THAN SMARTRECRUITERS. The list response has no
 *    description, so every posting costs a second request - a 2,000-role tenant is
 *    ~2,100 requests, which at the per-host interval is about forty minutes for one
 *    company. Acceptable because the nightly pass has until morning and because each
 *    tenant is its own hostname, so the per-host floor does not make companies queue
 *    behind each other. If it ever stops being acceptable, the fix is to skip the
 *    detail request for a posting already stored with an unchanged date - which loses
 *    nothing - and NOT to filter by the list response's location, for the reason in
 *    `parse`.
 *
 * THERE IS NO USABLE LOCATION FILTER, and this was checked properly because
 * SmartRecruiters has one and it saves five sixths of the traffic there. Workday does
 * expose a country facet, but its ids are per-TENANT: India is
 * `2fcb99c455831013ea52b82135ba3266` on NVIDIA's board and that same value answers
 * HTTP 400 on Salesforce's. Reading the facet list first would make the connector do
 * a lookup, which it is not allowed to do, and would cost a request per board anyway.
 * So the whole board is read and the India rule is applied downstream, exactly as it
 * is for Greenhouse, Lever, Ashby and Workable.
 */
import { AtsType } from '@prisma/client';
import { htmlToText } from '../html';
import { remoteType } from '../normalize';
import {
  asArray,
  asDate,
  asOptionalString,
  asRecord,
  asString,
  Connector,
  RawPosting,
} from './types';

/** The longest `location` the schema accepts, so the join below stops there. */
const LOCATION_MAX = 200;

/**
 * The one Workday domain this reads.
 *
 * `myworkdaysite.com` also exists and serves the newer sites, and it is deliberately
 * NOT handled: its paths carry `/recruiting/{tenant}/` in front of the site name, and
 * that shape has not been verified against a live board. A guessed URL layout would
 * produce a token that looks fine and fetches nothing, discovered as a 404 on some
 * later nightly pass. A URL from there falls through to the careers-page reader
 * instead, which is a worse result than a connector and a much better one than a
 * confident wrong answer.
 */
const WORKDAY_DOMAIN = 'myworkdayjobs.com';

/**
 * A Workday board's identity, which needs three parts rather than one.
 *
 * `nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite` is tenant `nvidia`, data
 * centre `wd5`, site `NVIDIAExternalCareerSite`, and all three are needed to build a
 * single URL. `Company.atsToken` is one string, so they are packed into it.
 */
export interface WorkdayBoard {
  tenant: string;
  /** The `wd{N}` label naming which Workday data centre serves this tenant. */
  dataCentre: string;
  /** CASE-SENSITIVE. `NVIDIAExternalCareerSite`, not `nvidiaexternalcareersite`. */
  site: string;
}

/**
 * Packs a board into the single string `Company.atsToken` holds.
 *
 * Colons, because none of the three parts can contain one: a tenant and a `wd5` are
 * hostname labels, and a site name is a URL path segment. A separator that cannot
 * occur inside a part is what makes the round trip exact rather than nearly exact.
 */
export function encodeWorkdayToken(board: WorkdayBoard): string {
  return `${board.tenant}:${board.dataCentre}:${board.site}`;
}

/**
 * Reads a packed token back, or null if it is not one.
 *
 * Returns null rather than throwing, and rather than guessing at a repair. A token
 * this cannot read means the company row is wrong, and the caller's job is to record
 * that board as failed and move on - not to send a request built from half of a
 * malformed identifier.
 *
 * This is the ONLY guard between a stored string and a URL, so each part is checked
 * against what it will be used for - two hostname labels and one path segment. A token
 * carrying `../`, a space, or a second hostname must not get past it.
 */
export function decodeWorkdayToken(token: string): WorkdayBoard | null {
  const parts = token.split(':');
  if (parts.length !== 3) return null;

  const [tenant, dataCentre, site] = parts;

  if (!/^[a-z0-9][a-z0-9-]{0,60}$/i.test(tenant)) return null;
  if (!/^wd\d{1,3}$/i.test(dataCentre)) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(site)) return null;

  return {
    tenant: tenant.toLowerCase(),
    dataCentre: dataCentre.toLowerCase(),
    site,
  };
}

export class WorkdayConnector implements Connector {
  readonly source = 'workday';
  readonly atsType = AtsType.WORKDAY;

  /**
   * Twenty, and Workday will not give more.
   *
   * Measured against a live board: `limit` 25, 50 and 100 each answer HTTP 400 with
   * an empty message, so this is a ceiling rather than a default worth tuning.
   */
  readonly pageSize = 20;

  /** A three-part board name cannot be guessed from a company slug. See the note in
   *  the Connector interface. */
  readonly guessable = false;

  listUrl(token: string): string {
    const board = this.board(token);
    return `${this.cxs(board)}/jobs`;
  }

  /**
   * The tenant, which is the only part of the token that names the employer.
   *
   * Returns '' for an unreadable token rather than throwing: the caller's fallback is
   * to guess a slug from the hostname, and that is a better answer than an error at
   * the moment somebody is trying to add a company.
   */
  slugFromToken(token: string): string {
    return decodeWorkdayToken(token)?.tenant ?? '';
  }

  /**
   * The search query, which is where the offset goes.
   *
   * `appliedFacets: {}` and `searchText: ''` are both required - omitting either
   * answers 400. They are the request for "everything on this board", which is what
   * this connector wants: the India rule is applied later, and the facet ids that
   * would express it here differ per tenant.
   */
  listBody(_token: string, offset = 0): unknown {
    return {
      appliedFacets: {},
      limit: this.pageSize,
      offset,
      searchText: '',
    };
  }

  totalAvailable(body: unknown): number | null {
    const total = asRecord(body).total;
    return typeof total === 'number' && Number.isFinite(total) ? total : null;
  }

  /**
   * Maps one list page. Descriptions arrive in `mergeDetail`.
   *
   * `sourceJobId` IS THE REQUISITION ID FROM THE PATH, not `bulletFields[0]`, and the
   * difference is not cosmetic. `externalPath` ends `..._JR2024594-1` where
   * `bulletFields` says `JR2024594`: Workday posts one requisition more than once when
   * it is open in several places, and the suffix is the only thing telling those two
   * postings apart. Keyed on `bulletFields` they would collide, and the upsert would
   * make each nightly pass overwrite one with the other forever.
   *
   * THE LOCATION HERE IS OFTEN A COUNT - `"5 Locations"` rather than a place - and that
   * is why nothing is filtered at this stage. Better than a quarter of a large board
   * reads that way, the real list only arrives with the detail response, and dropping
   * those would silently discard India roles under a string that names no country.
   */
  parse(body: unknown, token: string): RawPosting[] {
    const board = this.board(token);
    const postings: RawPosting[] = [];

    for (const entry of asArray(asRecord(body).jobPostings)) {
      const job = asRecord(entry);

      const title = asString(job.title).trim();
      const path = asString(job.externalPath).trim();
      if (!title || !path.startsWith('/')) continue;

      const id = requisitionId(path);
      if (!id) continue;

      const location = asString(job.locationsText).trim();

      postings.push({
        sourceJobId: id,
        title,
        location,
        // Empty until mergeDetail runs, and a posting that never gets hydrated is
        // dropped by the service rather than stored blank.
        descriptionRaw: '',
        descriptionText: '',
        // The public form of the same path, and replaced by the detail response's
        // own `externalUrl` when that arrives.
        applyUrl: `https://${this.host(board)}/${board.site}${path}`,
        remoteType: remoteType(location),
        // `postedOn` is the string "Posted 8 Days Ago" - a phrase, not a date, and
        // "Posted 30+ Days Ago" does not even bound one. The real date is
        // `startDate` in the detail response, so this stays null rather than
        // becoming a figure computed from prose.
        postedAt: null,
        // Workday has no public compensation field on either response.
        salary: null,
        department: null,
        employmentType: null,
      });
    }

    return postings;
  }

  /**
   * The same posting under the API root.
   *
   * `externalPath` is recovered from the apply URL rather than carried as an extra
   * field on RawPosting, so there is one copy of it and not two to drift apart. Plain
   * string arithmetic and not `new URL().pathname`, because a URL round trip
   * re-encodes what it parses and the path has to be handed back byte for byte -
   * Workday slugs a non-ASCII title into percent escapes, and those must survive.
   */
  detailUrl(posting: RawPosting, token: string): string {
    const board = this.board(token);
    const prefix = `https://${this.host(board)}/${board.site}`;

    const path = posting.applyUrl.startsWith(prefix)
      ? posting.applyUrl.slice(prefix.length)
      : '';
    if (!path.startsWith('/')) {
      throw new Error(
        `apply URL is not on ${prefix}: ${posting.applyUrl}. The detail endpoint is ` +
          'the same path under /wday/cxs, so there is nothing to ask for.',
      );
    }

    return `${this.cxs(board)}${path}`;
  }

  /**
   * Folds in the description, the full location list, and the real posted date.
   *
   * `additionalLocations` is the field that makes this worth doing beyond the
   * description: the list response said `"5 Locations"` and this says which five, so a
   * role open in Bengaluru among them is recognisable as an Indian job instead of
   * being unplaceable.
   */
  mergeDetail(posting: RawPosting, body: unknown): RawPosting {
    const info = asRecord(asRecord(body).jobPostingInfo);

    const html = asString(info.jobDescription);
    const location = joinLocations(
      asString(info.location).trim() || posting.location,
      asArray(info.additionalLocations).map((value) => asString(value).trim()),
    );

    const url = asString(info.externalUrl).trim();

    return {
      ...posting,
      // The detail response's title is the authoritative one; the list's is
      // occasionally an older wording of it.
      title: asString(info.title).trim() || posting.title,
      location,
      descriptionRaw: html,
      descriptionText: htmlToText(html),
      applyUrl: /^https?:\/\//.test(url) ? url : posting.applyUrl,
      remoteType: remoteType(location),
      // `startDate` is an ISO date and matches what `postedOn` says in words - a
      // posting reading "Posted 8 Days Ago" carries a startDate eight days back.
      postedAt: asDate(info.startDate),
      // "Full time" / "Part time". Workday states no department anywhere public;
      // `hiringOrganization.name` is a legal entity ("IN01 NVIDIA Graphics
      // Bengaluru"), which is a different fact and would read as nonsense in a
      // department column.
      employmentType: asOptionalString(info.timeType),
    };
  }

  /** `nvidia.wd5.myworkdayjobs.com`. */
  private host(board: WorkdayBoard): string {
    return `${board.tenant}.${board.dataCentre}.${WORKDAY_DOMAIN}`;
  }

  /** The API root both endpoints hang off. */
  private cxs(board: WorkdayBoard): string {
    return `https://${this.host(board)}/wday/cxs/${board.tenant}/${board.site}`;
  }

  /**
   * The board, or a thrown error.
   *
   * Throwing is right here even though connectors are otherwise quiet about bad
   * input: an unreadable token is not a posting that failed to map, it is a company
   * row that cannot be fetched at all, and the discovery pass already treats a thrown
   * error as "record this board as failed and continue with the next one".
   */
  private board(token: string): WorkdayBoard {
    const board = decodeWorkdayToken(token);
    if (!board) {
      throw new Error(
        `not a Workday board token: ${JSON.stringify(token)}. Expected ` +
          'tenant:wdN:SiteName, as in nvidia:wd5:NVIDIAExternalCareerSite.',
      );
    }
    return board;
  }
}

/**
 * The requisition id at the end of an `externalPath`.
 *
 * `/job/India-Bengaluru/Senior-Manager_JR2024311` -> `JR2024311`, and
 * `..._JR2024594-1` -> `JR2024594-1`. Taken from after the LAST underscore, because
 * everything before it is the title turned into a slug - so this id survives a
 * posting being retitled, which the full segment would not.
 *
 * Falls back to the whole segment when there is no underscore. That is still stable
 * and still the ATS's own string; it is only less durable across a rename.
 */
export function requisitionId(externalPath: string): string {
  const segment = externalPath.split('/').filter(Boolean).pop() ?? '';
  const underscore = segment.lastIndexOf('_');
  const id = underscore >= 0 ? segment.slice(underscore + 1) : segment;
  return id.trim();
}

/**
 * The primary location plus the extra ones, within the column's 200 characters.
 *
 * Whole entries only. Truncating mid-string would leave `"India, Bengal"`, which
 * reads as a place that is not the place - and `IN_LOCATION` matching on a chopped
 * city name is a wrong location rather than a missing one.
 */
export function joinLocations(primary: string, extra: string[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];

  for (const value of [primary, ...extra]) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    parts.push(trimmed);
  }

  const kept: string[] = [];
  let length = 0;
  for (const part of parts) {
    const cost = kept.length === 0 ? part.length : part.length + 2;
    // Leaves room for the "+N more" that follows, so adding it cannot push the
    // finished string past the limit.
    if (length + cost > LOCATION_MAX - 12) break;
    kept.push(part);
    length += cost;
  }

  if (kept.length === 0) return parts[0]?.slice(0, LOCATION_MAX) ?? '';

  const dropped = parts.length - kept.length;
  return dropped > 0 ? `${kept.join('; ')} +${dropped} more` : kept.join('; ');
}
