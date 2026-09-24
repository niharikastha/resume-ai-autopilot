/**
 * Employers' own careers-site JSON, for the ones whose ATS has no public board.
 *
 * Some large employers sit behind an ATS nothing can read - Atlassian on iCIMS - while
 * their own careers page fetches a perfectly good JSON listing to render itself. That
 * listing is the board. Found by reading the page's JS bundle for the endpoint, which
 * answers unauthenticated.
 *
 * ONE CONNECTOR, A TABLE OF EMPLOYERS. The token is the employer key below, and each
 * entry is that employer's endpoint and field mapping. These payloads share nothing,
 * so there is no generic parse to write - but they share everything around the parse
 * (never guessable, applied to by hand, fetched nightly), and one AtsType per employer
 * would be a migration per company.
 *
 * NOT GUESSABLE. An unknown key is not a board to ask about, it is a missing mapping.
 * These enter through companies.yaml's object form, where the token is a checked fact.
 *
 * WHAT THEY CANNOT DO: be prefilled. The apply links go to iCIMS, an account-gated
 * multi-step flow - see ManualOnlyAdapter.
 *
 * TRIED AND REFUSED: MakeMyTrip (careers.makemytrip.com/api/jobs, Darwinbox behind it).
 * The feed answers curl in two seconds and silently drops any request whose User-Agent
 * names itself a job-discovery bot. That is the operator saying no, and the honest UA in
 * http.client.ts exists so we hear it rather than route around it.
 */
import { AtsType } from '@prisma/client';
import { htmlToText } from '../html';
import { remoteType } from '../normalize';
import {
  asArray,
  asOptionalString,
  asRecord,
  asString,
  Connector,
  RawPosting,
} from './types';

interface EmployerApi {
  listUrl: string;
  parse(body: unknown): RawPosting[];
}

/**
 * atlassian.com/company/careers/all-jobs. Verified 2026-09-24: 287 postings, 48 in
 * India, full descriptions in the list - one request for the whole board.
 */
const ATLASSIAN: EmployerApi = {
  listUrl: 'https://www.atlassian.com/endpoint/careers/listings',

  parse(body) {
    const postings: RawPosting[] = [];
    // The feed repeats some postings verbatim - 287 entries, 271 ids on 2026-09-24.
    const seen = new Set<string>();
    for (const entry of asArray(body)) {
      const job = asRecord(entry);
      const id = job.id;
      const title = asString(job.title).trim();
      if (!title || (typeof id !== 'number' && typeof id !== 'string'))
        continue;
      if (seen.has(String(id))) continue;
      seen.add(String(id));

      // portalUrl is the posting's own iCIMS page; applyUrl is the same with
      // `?mode=apply`, which drops the reader straight into the account wall.
      const url = asString(asRecord(job.portalJobPost).portalUrl).trim();
      if (!/^https?:\/\//.test(url)) continue;

      const location = joinLocations(asArray(job.locations));

      // Compensation is left out of the scoring text for the same reason Lever's
      // `additional` is: it is identical boilerplate on every posting.
      const body = ['overview', 'responsibilities', 'qualifications']
        .map((k) => asString(job[k]))
        .filter(Boolean)
        .join('\n');
      const raw = [body, asString(job.compensation)].filter(Boolean).join('\n');

      postings.push({
        sourceJobId: String(id),
        title,
        location,
        descriptionRaw: raw,
        descriptionText: htmlToText(body),
        applyUrl: url,
        remoteType: remoteType(location),
        // Only `updatedDate` is published, and an edit date is not a posting date -
        // see the Greenhouse note on updated_at.
        postedAt: null,
        salary: null,
        department: asOptionalString(job.category),
        employmentType: null,
      });
    }
    return postings;
  },
};

/** The `location` column's limit, from jobPostingInput. */
const LOCATION_MAX = 200;

/**
 * Atlassian lists every office a role is open in, up to a couple of dozen, and joined
 * whole that overflows the column and the posting is rejected - 41 of them on the
 * first run. India entries go first so remoteType and the India filter still see them,
 * and whatever does not fit is counted rather than silently cut mid-word.
 */
function joinLocations(raw: unknown[]): string {
  const all = [
    ...new Set(
      raw.map((l) => asString(l).replace(/\s+/g, ' ').trim()).filter(Boolean),
    ),
  ].sort((a, b) => Number(/india/i.test(b)) - Number(/india/i.test(a)));

  const kept: string[] = [];
  for (const [i, loc] of all.entries()) {
    const rest = all.length - i - 1;
    const next = [...kept, loc].join('; ');
    const suffix = rest > 0 ? `; +${rest} more` : '';
    if ((next + suffix).length > LOCATION_MAX) {
      return kept.length > 0
        ? `${kept.join('; ')}; +${all.length - kept.length} more`
        : loc.slice(0, LOCATION_MAX);
    }
    kept.push(loc);
  }
  return kept.join('; ');
}

/** Keyed by atsToken. Adding an employer is an entry here plus a companies.yaml row. */
const EMPLOYERS: Record<string, EmployerApi> = {
  atlassian: ATLASSIAN,
};

function employer(token: string): EmployerApi {
  const found = EMPLOYERS[token];
  if (!found) {
    throw new Error(
      `careers-api has no mapping for "${token}" - known: ${Object.keys(EMPLOYERS).join(', ')}`,
    );
  }
  return found;
}

export class CareersApiConnector implements Connector {
  readonly source = 'careers-api';
  readonly atsType = AtsType.CAREERS_API;
  readonly guessable = false;

  listUrl(token: string): string {
    return employer(token).listUrl;
  }

  parse(body: unknown, token: string): RawPosting[] {
    return employer(token).parse(body);
  }
}
