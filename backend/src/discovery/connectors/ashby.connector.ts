/**
 * Ashby job boards.
 *
 * Endpoint:
 *   https://api.ashbyhq.com/posting-api/job-board/{token}?includeCompensation=true
 *
 * The best-structured of the three: it states remoteness as a boolean, gives a real
 * per-posting URL, and is the only one that reports salary as numbers with an
 * interval and a currency rather than as a summary string to be parsed.
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
  makeSalary,
  RawPosting,
} from './types';

export class AshbyConnector implements Connector {
  readonly source = 'ashby';
  readonly atsType = AtsType.ASHBY;

  listUrl(token: string): string {
    return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`;
  }

  // `_token` because these four sources put a per-posting URL in the response, so
  // the connector never needs the board token to build one. SmartRecruiters does
  // use it - the parameter is part of the interface for that reason, not this one.
  parse(body: unknown, _token: string): RawPosting[] {
    const jobs = asArray(asRecord(body).jobs);
    const postings: RawPosting[] = [];

    for (const entry of jobs) {
      const job = asRecord(entry);

      const id = asString(job.id).trim();
      const title = asString(job.title).trim();
      if (!id || !title) continue;

      // isListed false means the employer has unpublished it - it is still in the
      // API but is no longer open to applicants. Including it would put a job in
      // the digest that returns a dead page when clicked.
      if (job.isListed === false) continue;

      const applyUrl =
        asString(job.jobUrl).trim() || asString(job.applyUrl).trim();
      if (!/^https?:\/\//.test(applyUrl)) continue;

      const location = this.location(job);
      const raw = asString(job.descriptionHtml);

      postings.push({
        sourceJobId: id,
        title,
        location,
        descriptionRaw: raw,
        // htmlToText over Ashby's own descriptionPlain, so all three connectors
        // produce text through one code path that one set of tests covers. The
        // fallback matters though: a posting with no HTML body still has the plain
        // one, and an empty description is a posting scoring cannot use.
        descriptionText:
          htmlToText(raw) || asString(job.descriptionPlain).trim(),
        applyUrl,
        remoteType: remoteType(
          location,
          job.isRemote === true,
          asString(job.workplaceType),
        ),
        postedAt: asDate(job.publishedAt),
        salary: this.salary(job),
        department:
          asOptionalString(job.department) ?? asOptionalString(job.team),
        employmentType: asOptionalString(job.employmentType),
      });
    }

    return postings;
  }

  /**
   * The primary location, with secondaries appended.
   *
   * Ashby splits "New York (HQ)" from a `secondaryLocations` array that frequently
   * holds the India office. Reading only the primary would classify a role open in
   * both New York and Bengaluru as US-only, and it would be filtered out of the
   * pool - the exact kind of quiet, invisible loss that is worth two extra lines.
   *
   * Capped at the 200 characters `optionalText` allows, since a role listed in
   * fifteen cities would otherwise overflow the column.
   */
  private location(job: Record<string, unknown>): string {
    const primary = asString(job.location).trim();
    const secondary = asArray(job.secondaryLocations)
      .map((entry) => asString(asRecord(entry).location).trim())
      .filter(Boolean);

    const all = [primary, ...secondary].filter(Boolean);
    if (all.length === 0) return '';

    const joined = [...new Set(all)].join('; ');
    return joined.length > 200 ? joined.slice(0, 197) + '...' : joined;
  }

  /**
   * The salary component of the first compensation tier.
   *
   * THE TRAP: `components` is a mixed array, and the equity component often comes
   * FIRST. Taking `components[0]` yields
   * `{ compensationType: 'EquityPercentage', minValue: null, interval: 'NONE' }` -
   * which is not a salary, and reading it as one produces a null-valued salary on
   * exactly the postings that do state their pay. The filter on compensationType is
   * what this method is really for.
   *
   * Interval arrives as `"1 YEAR"`, and `"1 WEEK"` also exists - toSalaryPeriod
   * returns null for weekly rather than mislabelling it, so those are dropped.
   */
  private salary(job: Record<string, unknown>): RawPosting['salary'] {
    const tiers = asArray(asRecord(job.compensation).compensationTiers);

    for (const tier of tiers) {
      for (const raw of asArray(asRecord(tier).components)) {
        const component = asRecord(raw);
        if (asString(component.compensationType) !== 'Salary') continue;

        const salary = makeSalary(
          component.minValue,
          component.maxValue,
          component.currencyCode,
          component.interval,
        );
        // Keep looking rather than returning null: a board can carry one tier whose
        // salary is unusable (weekly, or missing a currency) and another that is
        // fine, and stopping at the first would discard a good figure.
        if (salary) return salary;
      }
    }

    return null;
  }
}
