/**
 * SmartRecruiters job boards.
 *
 * Endpoints:
 *   list   /v1/companies/{id}/postings?limit=100&offset=N   -> { totalFound, content }
 *   detail /v1/companies/{id}/postings/{postingId}          -> { jobAd, applyUrl, ... }
 *
 * THE EXPENSIVE ONE, and the reason the Connector interface has a detail step at
 * all. The list response carries no description and no apply URL - only a `ref`
 * pointing at the detail endpoint - so a board with 200 roles costs 201 requests
 * instead of 1. Verified against a live board rather than assumed: the list item
 * genuinely has no body field.
 *
 * That cost is why this source is worth having but should not be the first one
 * added to a large company list.
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

export class SmartRecruitersConnector implements Connector {
  readonly source = 'smartrecruiters';
  readonly atsType = AtsType.SMARTRECRUITERS;

  /** The API's documented maximum. Larger values are silently clamped. */
  readonly pageSize = 100;

  listUrl(token: string, offset = 0): string {
    return (
      `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}` +
      // `country=in` is a NATIVE filter, and the only connector of the four that
      // has one. It matters more here than anywhere else because of the detail
      // step: without it, Bosch is ~3,000 postings and therefore ~3,000 detail
      // requests to reach the 543 that are in India. Applied at the source, the
      // same board costs a sixth of that. Remote-India roles are kept - they carry
      // country IN - and remote-US roles are dropped, which is what the remote
      // eligibility rule wants anyway.
      `/postings?country=in&limit=${this.pageSize}&offset=${offset}`
    );
  }

  /**
   * PascalCase first, then the raw slug.
   *
   * `bosch` -> `Bosch`, `paloaltonetworks` -> `Paloaltonetworks`. Only the first
   * letter is raised: a multi-word slug's internal boundaries are not recoverable
   * ("paloalto" could be "PaloAlto" or "Paloalto"), and guessing every split would
   * multiply requests for a form the vendor may not use. Companies whose real id is
   * unguessable - `BoschGroup` - carry an explicit token in the company list
   * instead, which is what the `ats`/`token` fields on a list entry are for.
   */
  tokenCandidates(slug: string): string[] {
    const pascal = slug.charAt(0).toUpperCase() + slug.slice(1);
    return pascal === slug ? [slug] : [pascal, slug];
  }

  totalAvailable(body: unknown): number | null {
    const total = asRecord(body).totalFound;
    return typeof total === 'number' && Number.isFinite(total) ? total : null;
  }

  parse(body: unknown, token: string): RawPosting[] {
    const postings: RawPosting[] = [];

    for (const entry of asArray(asRecord(body).content)) {
      const job = asRecord(entry);

      const id = asString(job.id).trim();
      // `name`, not `title`. Another vendor, another word for the same field.
      const title = asString(job.name).trim();
      if (!id || !title) continue;

      // PUBLIC is the only visibility a candidate could act on. INTERNAL postings
      // are real jobs that an outsider cannot apply to.
      if (asString(job.visibility) !== 'PUBLIC') continue;

      const location = this.location(asRecord(job.location));

      postings.push({
        sourceJobId: id,
        title,
        location,
        // Both empty until mergeDetail runs. A posting that never gets hydrated is
        // dropped by the service rather than stored blank - a description-less row
        // is exactly the state this whole phase exists to eliminate.
        descriptionRaw: '',
        descriptionText: '',
        // Constructed from the token and id, and REPLACED by the real postingUrl in
        // mergeDetail. Present here only so the posting is well-formed before
        // hydration; the detail response is authoritative because a posting's slug
        // is in the URL and cannot be derived from the id alone.
        applyUrl: `https://jobs.smartrecruiters.com/${encodeURIComponent(token)}/${encodeURIComponent(id)}`,
        remoteType: remoteType(
          location,
          asRecord(job.location).remote === true,
        ),
        postedAt: asDate(job.releasedDate),
        // Not in the list response, and not in the detail response either -
        // SmartRecruiters has no public compensation field.
        salary: null,
        department:
          asOptionalString(asRecord(job.department).label) ??
          asOptionalString(asRecord(job.function).label),
        employmentType: asOptionalString(asRecord(job.typeOfEmployment).label),
      });
    }

    return postings;
  }

  detailUrl(posting: RawPosting, token: string): string {
    return (
      `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}` +
      `/postings/${encodeURIComponent(posting.sourceJobId)}`
    );
  }

  /**
   * Folds the detail response in: the description, the real URL, and remoteness.
   *
   * The body is split across `jobAd.sections`, each an independent
   * `{ title, text }`. Concatenated in reading order so the result is a document
   * rather than a bag of fragments.
   *
   * `additionalInformation` goes into descriptionRaw but NOT into the scoring text,
   * on the same grounds as Lever's `additional`: it is where the equal-opportunity
   * statement lives, it repeats across every posting a company has, and this system
   * never considers demographics - so that language should not reach the model at
   * all.
   */
  mergeDetail(posting: RawPosting, body: unknown): RawPosting {
    const detail = asRecord(body);
    const sections = asRecord(asRecord(detail.jobAd).sections);

    const section = (key: string): string => {
      const found = asRecord(sections[key]);
      const text = asString(found.text);
      if (!text) return '';
      const heading = asString(found.title).trim();
      return heading ? `<h3>${heading}</h3>${text}` : text;
    };

    const forScoring = [
      section('companyDescription'),
      section('jobDescription'),
      section('qualifications'),
    ].filter(Boolean);

    const full = [...forScoring, section('additionalInformation')].filter(
      Boolean,
    );

    const url =
      asString(detail.postingUrl).trim() || asString(detail.applyUrl).trim();

    return {
      ...posting,
      descriptionRaw: full.join('\n'),
      descriptionText: htmlToText(forScoring.join('\n')),
      applyUrl: /^https?:\/\//.test(url) ? url : posting.applyUrl,
      remoteType:
        asRecord(detail.location).remote === true
          ? remoteType(posting.location, true)
          : posting.remoteType,
    };
  }

  /** "Bengaluru, KA, in" from the structured location object. */
  private location(location: Record<string, unknown>): string {
    return [location.city, location.region, location.country]
      .map((part) => asString(part).trim())
      .filter(Boolean)
      .join(', ');
  }
}
