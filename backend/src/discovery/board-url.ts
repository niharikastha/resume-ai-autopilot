/**
 * Reading a pasted URL: which ATS is this, and what is the company called?
 *
 * PURE, and separate from the service for that reason. Every interesting case here is a
 * string, so the whole of this file is exercisable from a table of real URLs without a
 * network or a database - and the cases are numerous enough that it needs to be.
 * Greenhouse alone serves boards from three hostnames and an embed URL with the token in
 * a query parameter.
 *
 * THE POINT OF RECOGNISING THE ATS IS TO AVOID THE LLM. A board that answers with JSON
 * gives stable per-posting ids, real descriptions, a link per role and a nightly refresh.
 * A model reading HTML gives a snapshot with none of those. So the URL is matched here
 * first, and `read-careers-page.task` only runs when nothing matches.
 */
import { AtsType } from '@prisma/client';
import {
  decodeWorkdayToken,
  encodeWorkdayToken,
} from './connectors/workday.connector';

export interface BoardIdentity {
  atsType: AtsType;
  /** The connector `source`, which is what `job_postings.source` stores. */
  source: string;
  /** The board identifier, exactly as the ATS spells it. */
  token: string;
}

/** First non-empty path segment, decoded. */
function firstSegment(url: URL): string | null {
  const segment = url.pathname.split('/').find((part) => part.length > 0);
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The leading label of a hostname, when the rest matches a suffix.
 *
 * `acme.workable.com` -> `acme`. Returns null for the vendor's own www and api hosts,
 * which are not boards and whose tokens would be nonsense.
 */
function subdomain(host: string, suffix: string): string | null {
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  if (!label || label.includes('.')) return null;
  if (['www', 'api', 'app', 'boards-api', 'help', 'status'].includes(label))
    return null;
  return label;
}

/**
 * The board this URL points at, or null if it is not a board URL we recognise.
 *
 * Order matters only in that each vendor's checks are grouped; the host tests are
 * mutually exclusive, so no URL can match two vendors.
 */
export function identifyBoardUrl(url: URL): BoardIdentity | null {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const segment = firstSegment(url);

  // --- Greenhouse ---------------------------------------------------------------
  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') {
    // The embed form puts the token in `?for=`, and `/embed/job_board` is the path -
    // so reading the first segment would yield the literal string "embed".
    const embedded = url.searchParams.get('for');
    const token = embedded?.trim() || (segment === 'embed' ? null : segment);
    if (token) return greenhouse(token);
  }
  {
    const label = subdomain(host, '.greenhouse.io');
    if (label) return greenhouse(label);
  }

  // --- Lever -------------------------------------------------------------------
  // `jobs.eu.lever.co` is the EU-hosted variant and serves the same tokens.
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
    if (segment)
      return { atsType: AtsType.LEVER, source: 'lever', token: segment };
  }

  // --- Ashby -------------------------------------------------------------------
  if (host === 'jobs.ashbyhq.com') {
    if (segment)
      return { atsType: AtsType.ASHBY, source: 'ashby', token: segment };
  }

  // --- SmartRecruiters ---------------------------------------------------------
  // NOT lower-cased. SmartRecruiters ids are case-sensitive - the board is
  // `BoschGroup`, and `boschgroup` answers 200 with zero postings. A URL is the one
  // place the exact spelling is known for free, so it is kept exactly as pasted.
  if (
    host === 'careers.smartrecruiters.com' ||
    host === 'jobs.smartrecruiters.com'
  ) {
    if (segment) {
      return {
        atsType: AtsType.SMARTRECRUITERS,
        source: 'smartrecruiters',
        token: segment,
      };
    }
  }

  // --- Workable ----------------------------------------------------------------
  if (host === 'apply.workable.com') {
    // `/j/<id>` is a single posting on the shared host, with no company in the path.
    if (segment && segment !== 'j') {
      return { atsType: AtsType.WORKABLE, source: 'workable', token: segment };
    }
  }
  {
    const label = subdomain(host, '.workable.com');
    if (label && label !== 'apply') {
      return { atsType: AtsType.WORKABLE, source: 'workable', token: label };
    }
  }

  // --- Workday -----------------------------------------------------------------
  const workday = workdayToken(host, url);
  if (workday) {
    return { atsType: AtsType.WORKDAY, source: 'workday', token: workday };
  }

  return null;
}

/**
 * Workday's three-part board name, packed, or null.
 *
 * `https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/...` is
 * tenant `nvidia`, data centre `wd5`, site `NVIDIAExternalCareerSite` - and this is
 * the ONE place all three are known for free, which is why pasting the URL is the
 * only way a Workday board is added. Nothing probes for these.
 *
 * THE LOCALE SEGMENT IS THE TRAP. Workday puts `/en-US` (or `/de-DE`, `/fr-FR`) in
 * front of the site name about half the time, so reading the first path segment gives
 * the token `en-US` for that half - a board name that does not exist, on a host that
 * does, which fails as a 404 hours later on the nightly pass rather than at the moment
 * of pasting.
 *
 * THE SITE NAME IS NOT LOWER-CASED, for the same reason SmartRecruiters' is not:
 * `nvidiaexternalcareersite` is not a board.
 *
 * Only `myworkdayjobs.com` is recognised. `myworkdaysite.com` serves the newer sites
 * with a different path layout that has not been verified, and the note in the
 * connector says why guessing at it would be worse than not reading it.
 */
function workdayToken(host: string, url: URL): string | null {
  // Anchored at both ends, so `nvidia.wd5.myworkdayjobs.com.evil.test` is not a match.
  // `myworkdaysite.com` is deliberately absent - see the note in the connector.
  const match = /^([a-z0-9][a-z0-9-]*)\.(wd\d{1,3})\.myworkdayjobs\.com$/.exec(
    host,
  );
  if (!match) return null;

  const [, tenant, dataCentre] = match;

  const segments = url.pathname.split('/').filter((part) => part.length > 0);
  // A language tag, not a site. Two letters, a hyphen, two letters - and it is only
  // ever the first segment, so one shift is enough.
  if (segments[0] && /^[a-z]{2}-[A-Z]{2}$/.test(segments[0])) segments.shift();

  const site = segments[0];
  if (!site) return null;

  // Packed by the connector's own encoder and then read back by its own decoder,
  // rather than assembled with a template here. The token format belongs to one
  // module, and checking it with the reader the fetcher uses is what guarantees a
  // pasted URL cannot produce a token that the nightly pass then refuses.
  const token = encodeWorkdayToken({ tenant, dataCentre, site });
  return decodeWorkdayToken(token) ? token : null;
}

function greenhouse(token: string): BoardIdentity {
  return { atsType: AtsType.GREENHOUSE, source: 'greenhouse', token };
}

/**
 * Hostname labels that are the careers site rather than the company.
 *
 * `careers.zeta.tech` is Zeta, not Careers. Stripped from the front so the slug guess
 * has a chance of being the token an ATS knows the company by.
 */
const SITE_LABELS = [
  'www',
  'careers',
  'career',
  'jobs',
  'job',
  'apply',
  'hiring',
  'hire',
  'work',
  'workwithus',
  'join',
  'life',
  'people',
  'talent',
  'recruiting',
  'recruitment',
  'boards',
];

/**
 * Second-level labels that are part of the suffix, not the name.
 *
 * `acme.co.in` is Acme. Not a public-suffix-list implementation and not trying to be:
 * this feeds a slug GUESS that is then probed against five boards, so a wrong answer
 * costs a few requests that miss, and the operator can type the name themselves.
 */
const SECOND_LEVEL = ['co', 'com', 'net', 'org', 'gov', 'ac', 'edu', 'in'];

/**
 * A slug guess from a hostname: `careers.zeta.tech` -> `zeta`.
 *
 * Returns '' when nothing usable is left, which the caller must treat as "ask the
 * operator" rather than as a token to probe.
 */
export function slugFromHost(hostname: string): string {
  const labels = hostname
    .toLowerCase()
    .split('.')
    .filter((label) => label.length > 0);

  // Drop leading site labels, but never the last remaining one: `jobs.com` would
  // otherwise become nothing at all.
  while (labels.length > 2 && SITE_LABELS.includes(labels[0])) labels.shift();

  // Drop the TLD, then a second-level suffix if that is what is now at the end.
  if (labels.length > 1) labels.pop();
  if (labels.length > 1 && SECOND_LEVEL.includes(labels[labels.length - 1])) {
    labels.pop();
  }

  // What is left may still be `careers.acme` if the loop above stopped at the
  // two-label floor; the company is the last label either way.
  const name = labels[labels.length - 1] ?? '';
  return slugify(name);
}

/**
 * A company name reduced to the form the slug column and the ATSes use.
 *
 * Lower case, alphanumeric and hyphens - the same shape `company-list.ts` validates,
 * because a slug written here has to satisfy the same uniqueness constraint as one
 * written there.
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * A display name guess for a bare domain: `sarvam.ai` -> `Sarvam`.
 *
 * A guess, and labelled as one wherever it is shown. The careers-page task is asked for
 * the employer's own name precisely because this is often wrong, and the operator can
 * always type it.
 */
export function nameFromSlug(slug: string): string {
  return slug
    .split('-')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
