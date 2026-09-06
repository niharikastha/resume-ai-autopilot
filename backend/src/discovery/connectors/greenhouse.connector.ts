/**
 * Greenhouse job boards.
 *
 * The largest source by a wide margin - 3,316 of the 4,765 postings in the table
 * came from here - so its quirks matter more than the others'.
 *
 * Endpoint: https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
 * Public, documented, unauthenticated, one request per board.
 */
import { AtsType } from '@prisma/client';
import { decodeGreenhouseContent, htmlToText } from '../html';
import { remoteType } from '../normalize';
import {
  asArray,
  asDate,
  asOptionalString,
  asRecord,
  asString,
  Connector,
  makeSalary,
  RawPosting,
} from './types';

export class GreenhouseConnector implements Connector {
  readonly source = 'greenhouse';
  readonly atsType = AtsType.GREENHOUSE;

  /**
   * `content=true` is the whole point of this connector's existence.
   *
   * Without it the response carries titles and locations only - which is exactly
   * what the original spike fetched, and why 4,765 postings sat in the database
   * with empty descriptions and nothing downstream could run.
   */
  listUrl(token: string): string {
    return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`;
  }

  // `_token` because these four sources put a per-posting URL in the response, so
  // the connector never needs the board token to build one. SmartRecruiters does
  // use it - the parameter is part of the interface for that reason, not this one.
  parse(body: unknown, _token: string): RawPosting[] {
    const jobs = asArray(asRecord(body).jobs);
    const postings: RawPosting[] = [];

    for (const entry of jobs) {
      const job = asRecord(entry);

      const id = job.id;
      const title = asString(job.title).trim();
      // No id or no title means nothing downstream can key or display it. Skipped
      // rather than patched with a placeholder: sourceJobId is half of a unique
      // constraint, and inventing one would merge unrelated postings.
      if (!title || (typeof id !== 'number' && typeof id !== 'string'))
        continue;

      const applyUrl = asString(job.absolute_url).trim();
      // The URL is not optional in the schema and a posting nobody can open is not
      // useful, so this is a skip rather than a fallback to the board page.
      if (!/^https?:\/\//.test(applyUrl)) continue;

      const location = asString(asRecord(job.location).name).trim();

      // Greenhouse double-escapes: `content` arrives as `&lt;p&gt;`, so one decode
      // yields the HTML that everything else in this file treats as the raw body.
      const raw = decodeGreenhouseContent(asString(job.content));

      postings.push({
        sourceJobId: String(id),
        title,
        location,
        descriptionRaw: raw,
        descriptionText: htmlToText(raw),
        applyUrl,
        // Greenhouse has no remote flag; the fact is in the office name, which is
        // why remoteType reads the string here and takes an explicit flag on the
        // connectors that do provide one.
        remoteType: remoteType(location),
        // first_published is when candidates could first see it. updated_at moves
        // whenever a recruiter edits a typo, so using it as the posting date would
        // make an old role look new every time it is touched.
        postedAt: asDate(job.first_published) ?? asDate(job.updated_at),
        salary: this.salary(job),
        department: asOptionalString(
          asRecord(asArray(job.departments)[0]).name,
        ),
        employmentType: null,
      });
    }

    return postings;
  }

  /**
   * `pay_input_ranges`, present only on boards where the employer fills it in -
   * which in the Indian data is almost none, hence the 0.3% salary coverage the
   * seed comments on.
   *
   * Figures are in CENTS (`min_cents`), so they are divided by 100. Reading them as
   * major units would report a 2,000,000 INR salary as 200,000,000 - which the
   * `numeric(14,2)` cap would not even catch, since it fits.
   */
  private salary(job: Record<string, unknown>): RawPosting['salary'] {
    const range = asRecord(asArray(job.pay_input_ranges)[0]);
    if (Object.keys(range).length === 0) return null;

    const toMajor = (cents: unknown): number | null =>
      typeof cents === 'number' && Number.isFinite(cents) && cents > 0
        ? cents / 100
        : null;

    return makeSalary(
      toMajor(range.min_cents),
      toMajor(range.max_cents),
      range.currency_type,
      // Greenhouse does not state an interval on this field. Annual is the
      // documented meaning and the only one used in practice, so it is assumed -
      // and noted here because an assumption about a money field should not be
      // silent.
      'YEAR',
    );
  }
}
