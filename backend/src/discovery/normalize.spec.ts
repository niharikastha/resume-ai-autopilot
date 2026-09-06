/**
 * The derived fields, tested on the cases that have actually gone wrong in this
 * table.
 *
 * normalizeTitle gets the most attention because it is a DEDUP KEY, not a label:
 * `job_postings` is upserted on it and `applications` is unique by
 * (userId, companyId, normalizedTitle). A change here silently redefines what counts
 * as the same job.
 */
import { RemoteType } from '@prisma/client';
import {
  isAddressableLocation,
  normalizeTitle,
  remoteType,
  seniority,
} from './normalize';

describe('normalizeTitle', () => {
  it('lower-cases, strips punctuation and collapses whitespace', () => {
    expect(normalizeTitle('  Senior   Backend Engineer (Platform)  ')).toBe(
      'senior backend engineer platform',
    );
  });

  it('keeps non-Latin scripts instead of erasing them', () => {
    // THE REGRESSION THIS FILE EXISTS FOR. With `[^a-z0-9\s]` every character of a
    // Japanese title was stripped, leaving ''. Two such rows existed in the live
    // table, and because applications is UNIQUE(userId, companyId, normalizedTitle),
    // every posting normalizing to '' collides with every other one at that company -
    // so a second application is refused as a duplicate of an unrelated role.
    expect(normalizeTitle('ソリューションアーキテクト (プリセールス)')).toBe(
      'ソリューションアーキテクト プリセールス',
    );
  });

  it('never returns empty for a non-empty input', () => {
    // What the NOT-empty CHECK constraint relies on. A title made only of
    // punctuation still has to produce something.
    expect(normalizeTitle('!!!')).toBe('!!!');
    expect(normalizeTitle('---')).toBe('---');
    expect(normalizeTitle('  +++  ')).toBe('+++');
  });

  it('is stable across the punctuation an employer might add later', () => {
    // The point of a dedup key: a recruiter adding a comma must not create a second
    // job.
    expect(normalizeTitle('Backend Engineer, II')).toBe(
      normalizeTitle('Backend Engineer II'),
    );
    expect(normalizeTitle('Full-Stack Developer')).toBe(
      normalizeTitle('Full Stack Developer'),
    );
  });
});

describe('remoteType', () => {
  it('separates remote-India from remote-elsewhere', () => {
    // The distinction the enum exists for: one is applicable, the other cannot be
    // taken, and collapsing them fills the pool with unreachable jobs.
    expect(remoteType('Remote - India')).toBe(RemoteType.REMOTE_INDIA);
    expect(remoteType('Remote - US')).toBe(RemoteType.REMOTE_OTHER_REGION);
    expect(remoteType('Remote')).toBe(RemoteType.REMOTE_GLOBAL);
  });

  it('reads hybrid before remote', () => {
    // "Hybrid - Remote/Bengaluru" is hybrid. Testing remote first would overstate
    // its flexibility.
    expect(remoteType('Hybrid - Remote/Bengaluru')).toBe(RemoteType.HYBRID);
  });

  it('uses the ATS remote flag when the location string does not say', () => {
    // Ashby and Lever state remoteness as a field. A job flagged remote but located
    // "Bengaluru" is REMOTE_INDIA; read from the string alone it looks ONSITE.
    expect(remoteType('Bengaluru')).toBe(RemoteType.ONSITE);
    expect(remoteType('Bengaluru', true)).toBe(RemoteType.REMOTE_INDIA);
    expect(remoteType('Bengaluru', undefined, 'hybrid')).toBe(
      RemoteType.HYBRID,
    );
  });

  it('matches Indian cities as whole words only', () => {
    // Without `\b`, "pune" matches inside "Puneet" and "delhi" inside a US township -
    // a real string-matching failure whose cost is a job in the wrong country.
    expect(remoteType('Puneet Nagar, Ohio')).toBe(RemoteType.UNKNOWN);
    expect(remoteType('Pune, India')).toBe(RemoteType.ONSITE);
  });

  it('is UNKNOWN, not ONSITE, for a known foreign office', () => {
    // We know where it is not. A confident ONSITE would let Berlin read as
    // addressable later.
    expect(remoteType('Berlin, Germany')).toBe(RemoteType.UNKNOWN);
  });
});

describe('seniority', () => {
  it.each([
    ['Senior Backend Engineer', 'senior'],
    ['Sr. Software Engineer', 'senior'],
    ['Staff Engineer', 'senior'],
    ['Principal Architect', 'senior'],
    ['Junior Developer', 'junior'],
    ['Associate Engineer', 'junior'],
    ['Software Engineer', 'mid'],
    ['Backend Developer', 'mid'],
  ])('reads %s as %s', (title, expected) => {
    expect(seniority(title)).toBe(expected);
  });
});

describe('isAddressableLocation', () => {
  it('accepts India and global remote, rejects a foreign-only role', () => {
    expect(isAddressableLocation('Bengaluru, India')).toBe(true);
    expect(isAddressableLocation('Remote - India')).toBe(true);
    expect(isAddressableLocation('Remote')).toBe(true);
    expect(isAddressableLocation('Remote - US')).toBe(false);
    expect(isAddressableLocation('Tokyo, Japan')).toBe(false);
  });
});
