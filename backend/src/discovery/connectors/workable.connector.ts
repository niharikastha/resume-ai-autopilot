/**
 * Workable job boards.
 *
 * Endpoint:
 *   https://apply.workable.com/api/v1/widget/accounts/{token}?details=true
 *
 * UNVERIFIED FIELD MAPPING - read this before trusting it.
 *
 * The other four connectors in this directory were written against a live response
 * captured from a real board. This one was not, because there is no Workable board
 * to capture: the spike probed 34 companies and found zero, `job_postings` contains
 * 3,316 greenhouse / 1,118 ashby / 331 lever rows and no workable rows at all, and
 * nine further likely candidates all returned an empty job list. The endpoint
 * answers and the envelope shape (`{ jobs: [...] }`) is confirmed; the per-posting
 * field NAMES below come from Workable's documented widget payload, not from
 * something observed.
 *
 * It is included because AtsType already has a WORKABLE member and the seed already
 * maps the source, so the alternative is a half-wired path that looks supported.
 * Every field read is defensive, so the worst case is a board that yields nothing -
 * which shows up as a zero in `source_runs` rather than as a crash.
 *
 * WHEN A REAL WORKABLE BOARD APPEARS, check these four before believing the output:
 *   1. `description` vs `full_description` - which one carries the requirements
 *   2. whether `id` or `shortcode` is the stable identifier
 *   3. whether `url` is per-posting or board-level
 *   4. that `telecommuting` is the remote flag and is a boolean
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

export class WorkableConnector implements Connector {
  readonly source = 'workable';
  readonly atsType = AtsType.WORKABLE;

  listUrl(token: string): string {
    return `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(token)}?details=true`;
  }

  // `_token` because these four sources put a per-posting URL in the response, so
  // the connector never needs the board token to build one. SmartRecruiters does
  // use it - the parameter is part of the interface for that reason, not this one.
  parse(body: unknown, _token: string): RawPosting[] {
    const postings: RawPosting[] = [];

    for (const entry of asArray(asRecord(body).jobs)) {
      const job = asRecord(entry);

      // shortcode first: it is the value that appears in Workable's own URLs, which
      // makes it the one most likely to be stable across a re-post. `id` is the
      // fallback rather than the primary for that reason.
      const id =
        asString(job.shortcode).trim() ||
        asString(job.id).trim() ||
        String(typeof job.id === 'number' ? job.id : '');
      const title = asString(job.title).trim();
      if (!id || !title) continue;

      const applyUrl =
        asString(job.url).trim() ||
        asString(job.shortlink).trim() ||
        asString(job.application_url).trim();
      if (!/^https?:\/\//.test(applyUrl)) continue;

      const location = this.location(job);

      // full_description preferred: on the widget payload `description` is often the
      // teaser shown in a job list, and a teaser has none of the requirements that
      // scoring needs. This is point 1 of the checklist above.
      const raw = asString(job.full_description) || asString(job.description);

      postings.push({
        sourceJobId: id,
        title,
        location,
        descriptionRaw: raw,
        descriptionText: htmlToText(raw),
        applyUrl,
        remoteType: remoteType(location, job.telecommuting === true),
        postedAt: asDate(job.created_at) ?? asDate(job.published_on),
        // No compensation field on the widget payload.
        salary: null,
        department: asOptionalString(job.department),
        employmentType: asOptionalString(job.employment_type),
      });
    }

    return postings;
  }

  /** Workable reports the parts separately; the location object is not always set. */
  private location(job: Record<string, unknown>): string {
    const nested = asRecord(job.location);
    const parts = [
      job.city ?? nested.city,
      job.region ?? nested.region,
      job.country ?? nested.country,
    ];
    return parts
      .map((part) => asString(part).trim())
      .filter(Boolean)
      .join(', ');
  }
}
