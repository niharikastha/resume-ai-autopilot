/**
 * Lever job boards.
 *
 * Endpoint: https://api.lever.co/v0/postings/{token}?mode=json
 * Returns a bare ARRAY, not an object with a `jobs` key - the one shape difference
 * that makes a shared "read body.jobs" helper impossible across connectors.
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

export class LeverConnector implements Connector {
  readonly source = 'lever';
  readonly atsType = AtsType.LEVER;

  listUrl(token: string): string {
    return `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`;
  }

  // `_token` because these four sources put a per-posting URL in the response, so
  // the connector never needs the board token to build one. SmartRecruiters does
  // use it - the parameter is part of the interface for that reason, not this one.
  parse(body: unknown, _token: string): RawPosting[] {
    // A bare array on success. An error is an OBJECT (`{error, ok}`), which is how
    // a wrong token presents - so a non-array body is not a crash here, it is an
    // empty result the caller records as a board that returned nothing.
    const jobs = asArray(body);
    const postings: RawPosting[] = [];

    for (const entry of jobs) {
      const job = asRecord(entry);

      const id = asString(job.id).trim();
      // `text`, not `title`. Lever's field for the job title is called text, and
      // reading `.title` here returns undefined for every posting on every board -
      // a whole source silently yielding nothing.
      const title = asString(job.text).trim();
      if (!id || !title) continue;

      // hostedUrl is the readable posting page; applyUrl jumps straight into the
      // form. The digest sends a human to look at a job before deciding, so the
      // page is the right destination and the form is the fallback.
      const applyUrl =
        asString(job.hostedUrl).trim() || asString(job.applyUrl).trim();
      if (!/^https?:\/\//.test(applyUrl)) continue;

      const categories = asRecord(job.categories);
      const location = asString(categories.location).trim();

      const raw = this.assembleRaw(job);

      postings.push({
        sourceJobId: id,
        title,
        location,
        descriptionRaw: raw.full,
        descriptionText: htmlToText(raw.forScoring),
        applyUrl,
        remoteType: remoteType(
          location,
          undefined,
          asString(job.workplaceType),
        ),
        postedAt: asDate(job.createdAt),
        salary: this.salary(job),
        department:
          asOptionalString(categories.department) ??
          asOptionalString(categories.team),
        employmentType: asOptionalString(categories.commitment),
      });
    }

    return postings;
  }

  /**
   * Reassembles the body, which Lever splits across several fields.
   *
   * THE TRAP: `descriptionPlain` is only the opening blurb. The responsibilities
   * and requirements live in `lists`, a separate array of
   * `{ text: "Requirements:", content: "<ul>..." }` objects. So a connector that
   * reads `descriptionPlain` alone gets the marketing paragraph and none of the
   * qualifications - and the qualifications are the entire thing scoring needs. It
   * would look like it worked, on every posting, while feeding the matcher nothing
   * of value.
   *
   * Two outputs, because they answer different questions:
   *
   *  - `full` is stored verbatim in descriptionRaw, including `additional`.
   *  - `forScoring` OMITS `additional`, which is Lever's slot for the equal
   *    opportunity statement. It is identical across every posting a company has,
   *    so it dilutes the embedding toward boilerplate - and, more importantly, it is
   *    dense with gender, race, disability and veteran language. This system never
   *    infers or considers demographics, and the cleanest way to honour that is to
   *    not put that text in front of the model at all.
   */
  private assembleRaw(job: Record<string, unknown>): {
    full: string;
    forScoring: string;
  } {
    const opening = asString(job.description) || asString(job.descriptionBody);

    const lists = asArray(job.lists)
      .map((item) => {
        const section = asRecord(item);
        const heading = asString(section.text).trim();
        const content = asString(section.content);
        if (!content) return '';
        // The heading is wrapped in a real tag so htmlToText gives it its own line.
        // Concatenated bare, "Requirements:" would run into the first bullet.
        return heading ? `<h3>${heading}</h3>${content}` : content;
      })
      .filter(Boolean)
      .join('\n');

    const additional = asString(job.additional);
    const forScoring = [opening, lists].filter(Boolean).join('\n');

    return {
      full: [opening, lists, additional].filter(Boolean).join('\n'),
      forScoring,
    };
  }

  /**
   * `salaryRange`, when the employer fills it in. Null on most Indian postings.
   *
   * `interval` arrives as `per-year-salary`, which is why toSalaryPeriod matches on
   * a substring rather than an exact value.
   */
  private salary(job: Record<string, unknown>): RawPosting['salary'] {
    const range = asRecord(job.salaryRange);
    if (Object.keys(range).length === 0) return null;
    return makeSalary(range.min, range.max, range.currency, range.interval);
  }
}
