/**
 * Does the blocklist block the employer the candidate named, and only that employer?
 *
 *   npx ts-node -r tsconfig-paths/register scripts/blocked-companies.check.ts
 *
 * WHY THIS EXISTS. A blocklist has two failure modes and both of them are silent.
 *
 * TOO NARROW: the candidate types "Hyscaler", the board says "HyScaler Solutions Pvt.
 * Ltd.", and the rule never fires. Nothing errors - their old employer's jobs simply keep
 * appearing, which reads as the feature not being saved rather than as a matching bug.
 *
 * TOO BROAD: the candidate types "Ola" and it also removes Motorola, Coca-Cola and
 * Solaris. This one is worse, because a posting screened out in stage 1 LEAVES NO ROW
 * BEHIND - stage1.screen.ts says so in its own docstring - so the loss is invisible and
 * indistinguishable from a quiet job market.
 *
 * Both are properties of one pure function, which is why that function is pure: the cases
 * below are the specification of what "Hyscaler" covers, written down where a future edit
 * to the normaliser has to run past them.
 *
 * THE LAST FOUR CASES RUN THE REAL SCREEN, not the matcher, because stage 1 is where the
 * rule has to fire and the ORDER matters - before the description scan, before embedding,
 * before any model call. A rule that works but fires late costs money on every run.
 *
 * WHY A SCRIPT AND NOT A JEST TEST: same as answers-library.check.ts and
 * resume-studio.check.ts. This repo verifies by running the real code path.
 */
import { RemoteType } from '@prisma/client';
import {
  blockedBy,
  blockedCompanyIds,
  normalizeCompany,
  type BlockedPattern,
} from '../src/config/blocked-companies';
import { loadTargets } from '../src/config/targets';
import {
  screen,
  screenAll,
  type ScreenablePosting,
} from '../src/matching/stage1.screen';

interface Case {
  name: string;
  /** Null passes; a sentence is the complaint. */
  run: () => string | null;
}

/** A rule as the database stores it: what they typed, plus its normalised form. */
function rule(label: string): BlockedPattern {
  return { label, pattern: normalizeCompany(label) };
}

function expect(ok: boolean, complaint: string): string | null {
  return ok ? null : complaint;
}

/** `label` blocks `companyName`. */
function blocks(label: string, companyName: string): string | null {
  const fired = blockedBy(companyName, [rule(label)]);
  return expect(
    fired !== undefined,
    `"${label}" should block "${companyName}" but did not ` +
      `(pattern "${normalizeCompany(label)}" vs name "${normalizeCompany(companyName)}")`,
  );
}

/** `label` leaves `companyName` alone. */
function spares(label: string, companyName: string): string | null {
  const fired = blockedBy(companyName, [rule(label)]);
  return expect(
    fired === undefined,
    `"${label}" should NOT block "${companyName}" but did ` +
      `(pattern "${normalizeCompany(label)}" vs name "${normalizeCompany(companyName)}")`,
  );
}

/** A posting at `companyName`, otherwise a perfectly ordinary backend role. */
function posting(
  companyName: string | null,
  overrides: Partial<ScreenablePosting> = {},
): ScreenablePosting {
  return {
    id: 'job-1',
    title: 'Senior Backend Engineer',
    normalizedTitle: 'senior backend engineer',
    companyName,
    descriptionText:
      'We are hiring a backend engineer to work on our python and postgres services.',
    location: 'Bengaluru, India',
    remoteType: RemoteType.ONSITE,
    seniority: null,
    yoeMin: null,
    yoeMax: null,
    postedAt: new Date('2026-09-20T00:00:00Z'),
    closedAt: null,
    ...overrides,
  };
}

const NOW = new Date('2026-09-21T00:00:00Z');
const NOTHING_APPLIED: ReadonlySet<string> = new Set<string>();

const CASES: Case[] = [
  // ---- the name the candidate actually typed -------------------------------
  {
    name: 'the exact name blocks it',
    run: () => blocks('Hyscaler', 'Hyscaler'),
  },
  {
    name: 'case is irrelevant - "Hyscaler" blocks "HyScaler"',
    run: () => blocks('Hyscaler', 'HyScaler'),
  },
  {
    name: 'the short name blocks the long one: "Hyscaler" vs "HyScaler Solutions Pvt. Ltd."',
    run: () => blocks('Hyscaler', 'HyScaler Solutions Pvt. Ltd.'),
  },
  {
    name: 'and the long name blocks the short one: "Hyscaler Pvt Ltd" vs "HyScaler"',
    run: () => blocks('Hyscaler Pvt Ltd', 'HyScaler'),
  },
  {
    name: 'a trailing legal form is not part of the name: "Hyscaler Private Limited" vs "Hyscaler Solutions"',
    run: () => blocks('Hyscaler Private Limited', 'Hyscaler Solutions'),
  },
  {
    name: 'punctuation is not meaning: "zeta suite" vs "Zeta-Suite"',
    run: () => blocks('zeta suite', 'Zeta-Suite'),
  },
  {
    name: '"&" and "and" are one word: "Johnson & Johnson" vs "Johnson and Johnson"',
    run: () => blocks('Johnson & Johnson', 'Johnson and Johnson'),
  },
  {
    name: 'a multi-word name matches in sequence: "Tata Consultancy" vs "Tata Consultancy Services"',
    run: () => blocks('Tata Consultancy', 'Tata Consultancy Services'),
  },

  // ---- and nobody else ----------------------------------------------------
  {
    name: 'a short name is not a substring: "Ola" does not block "Motorola"',
    run: () => spares('Ola', 'Motorola'),
  },
  {
    name: 'nor mid-word: "IBM" does not block "Fibmesh"',
    run: () => spares('IBM', 'Fibmesh'),
  },
  {
    name: 'word order is not ignored: "Consultancy Tata" does not block "Tata Consultancy Services"',
    run: () => spares('Consultancy Tata', 'Tata Consultancy Services'),
  },
  {
    name: 'a longer name does not block a shorter different one: "Bosch Global Software" vs "Bosch"',
    run: () => spares('Bosch Global Software', 'Bosch'),
  },
  {
    name: 'blocking an employer does not block a different one with a shared word',
    run: () => spares('Hyscaler', 'Scaler Academy'),
  },
  {
    name: 'a legal form typed alone does not block every company that has one',
    // "Pvt Ltd" survives normalisation as itself (see normalizeCompany's guard), and
    // the words are stripped from the other side - so it matches nothing real. The
    // alternative, an empty pattern, would match EVERY employer.
    run: () => spares('Pvt Ltd', 'Hyscaler Pvt Ltd'),
  },

  // ---- the failure that would block the whole job market ------------------
  {
    name: 'a name with no letters or digits normalises to nothing',
    run: () =>
      expect(
        normalizeCompany('...') === '' && normalizeCompany('!@#') === '',
        `wanted "" for a punctuation-only name, got "${normalizeCompany('...')}" ` +
          `and "${normalizeCompany('!@#')}"`,
      ),
  },
  {
    name: 'an empty pattern blocks nothing (it must not be a run inside every name)',
    // The service refuses to store one - this is the second line of defence, because
    // a single such row would empty every shortlist and look like a dead pipeline.
    run: () =>
      expect(
        blockedBy('Hyscaler', [{ label: 'broken', pattern: '' }]) === undefined,
        'an empty pattern blocked a real employer',
      ),
  },
  {
    name: 'a company whose whole name is a legal form keeps it',
    run: () =>
      expect(
        normalizeCompany('Co') === 'co',
        `wanted "co", got "${normalizeCompany('Co')}"`,
      ),
  },
  {
    name: 'no company on the posting is never blocked',
    run: () =>
      expect(
        blockedBy(null, [rule('Hyscaler')]) === undefined &&
          blockedBy(undefined, [rule('Hyscaler')]) === undefined,
        'a posting with no employer was blocked by a name',
      ),
  },
  {
    name: 'an empty list blocks nothing',
    run: () =>
      expect(
        blockedBy('Hyscaler', []) === undefined,
        'an empty blocklist blocked an employer',
      ),
  },

  // ---- the rule fired, and it says which one ------------------------------
  {
    name: 'the rule that fired is named, so a skip can say which entry did it',
    run: () => {
      const fired = blockedBy('HyScaler Solutions Pvt Ltd', [
        rule('Infosys'),
        rule('Hyscaler'),
        rule('Wipro'),
      ]);
      return expect(
        fired?.label === 'Hyscaler',
        `wanted the "Hyscaler" rule, got ${fired ? `"${fired.label}"` : 'nothing'}`,
      );
    },
  },
  {
    name: 'ids are resolved for the surfaces that filter in SQL',
    run: () => {
      const ids = blockedCompanyIds(
        [
          { id: 'c1', name: 'HyScaler Solutions Pvt Ltd' },
          { id: 'c2', name: 'Motorola' },
          { id: 'c3', name: 'Hyscaler' },
        ],
        [rule('Hyscaler')],
      );
      return expect(
        JSON.stringify(ids) === JSON.stringify(['c1', 'c3']),
        `wanted ["c1","c3"], got ${JSON.stringify(ids)}`,
      );
    },
  },
  {
    name: 'no ids at all when nothing is blocked (an empty IN list would exclude everything)',
    run: () =>
      expect(
        blockedCompanyIds([{ id: 'c1', name: 'HyScaler' }], []).length === 0,
        'an empty blocklist resolved to a non-empty id list',
      ),
  },

  // ---- stage 1, the real screen -------------------------------------------
  {
    name: 'stage 1 drops a blocked employer and names the entry',
    run: () => {
      const verdict = screen(
        posting('HyScaler Solutions Pvt Ltd'),
        loadTargets(),
        {
          now: NOW,
          appliedJobIds: NOTHING_APPLIED,
          blockedCompanies: [rule('Hyscaler')],
        },
      );
      return expect(
        !verdict.pass &&
          verdict.reason === 'company-blocked' &&
          verdict.matched === 'Hyscaler',
        `wanted company-blocked <- "Hyscaler", got ${JSON.stringify(verdict)}`,
      );
    },
  },
  {
    name: 'the same posting passes stage 1 when nothing is blocked',
    // Proves the case above is testing the blocklist and not some other rule the
    // fixture happens to trip.
    run: () => {
      const verdict = screen(
        posting('HyScaler Solutions Pvt Ltd'),
        loadTargets(),
        {
          now: NOW,
          appliedJobIds: NOTHING_APPLIED,
        },
      );
      return expect(
        verdict.pass,
        `wanted a pass with no blocklist, got ${JSON.stringify(verdict)}`,
      );
    },
  },
  {
    name: 'the blocklist is checked before the description is read',
    run: () => {
      // An empty description is its own rejection reason. Getting company-blocked back
      // is what proves no 20KB scan happened for an employer already ruled out - which
      // is the whole reason this rule lives in stage 1 rather than at the apply step.
      const verdict = screen(
        posting('Hyscaler', { descriptionText: '' }),
        loadTargets(),
        {
          now: NOW,
          appliedJobIds: NOTHING_APPLIED,
          blockedCompanies: [rule('Hyscaler')],
        },
      );
      return expect(
        !verdict.pass && verdict.reason === 'company-blocked',
        `wanted company-blocked ahead of the description check, got ${JSON.stringify(verdict)}`,
      );
    },
  },
  {
    name: 'an already-applied posting still reports already-applied',
    // The two facts are checked in that order deliberately: "you have applied here" is
    // the more specific thing to tell somebody about a posting they acted on.
    run: () => {
      const verdict = screen(posting('Hyscaler'), loadTargets(), {
        now: NOW,
        appliedJobIds: new Set(['job-1']),
        blockedCompanies: [rule('Hyscaler')],
      });
      return expect(
        !verdict.pass && verdict.reason === 'already-applied',
        `wanted already-applied, got ${JSON.stringify(verdict)}`,
      );
    },
  },
  {
    name: 'the histogram counts the blocked ones under their own reason',
    run: () => {
      const result = screenAll(
        [
          posting('Hyscaler', { id: 'a' }),
          posting('HyScaler Technologies', { id: 'b' }),
          posting('Motorola Mobility', { id: 'c' }),
        ],
        loadTargets(),
        {
          now: NOW,
          appliedJobIds: NOTHING_APPLIED,
          blockedCompanies: [rule('Hyscaler')],
        },
      );
      return expect(
        result.rejected['company-blocked'] === 2 &&
          result.survivors.length === 1 &&
          result.survivors[0]?.id === 'c' &&
          result.examples.get('company-blocked') !== undefined,
        `wanted 2 blocked and Motorola surviving, got ${JSON.stringify({
          rejected: result.rejected,
          survivors: result.survivors.map((s) => s.id),
        })}`,
      );
    },
  },
];

function main(): void {
  let pass = 0;
  let fail = 0;

  for (const testCase of CASES) {
    let complaint: string | null;
    try {
      complaint = testCase.run();
    } catch (error: unknown) {
      complaint = `threw: ${String(error)}`;
    }

    if (complaint === null) pass++;
    else fail++;
    console.log(
      `${complaint === null ? 'PASS' : 'FAIL'}  ${testCase.name}` +
        (complaint === null ? '' : `\n        ${complaint}`),
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
