/**
 * Seeds from the discovery spike's real output (spike/all-postings.json): the
 * 4,804 live postings actually fetched from Greenhouse, Lever, Ashby and
 * Workable on 2026-09-05.
 *
 * Deliberately real rather than synthetic. A dashboard built against invented
 * numbers tells you nothing about whether the funnel logic is right; this data
 * has the true shape, including the awkward parts (0.3% salary coverage, a long
 * tail of US-only remote roles).
 *
 * Limits worth knowing: the spike saved title/location/salary/company/ats only,
 * so descriptions are empty and applyUrl is board-level. Phase 1's real
 * connectors populate both properly. Re-running is safe - everything upserts.
 */
import {
  AtsType,
  CompanyTier,
  PrismaClient,
  RemoteType,
  Role,
  SalarySource,
} from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createHash, randomBytes } from 'crypto';
import { config } from 'dotenv';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { hashPassword } from '../src/auth/password';

config({ path: resolve(__dirname, '../../.env') });

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

interface SpikePosting {
  title: string;
  location: string;
  salary: string | null;
  company: string;
  ats: string;
}

const ATS_MAP: Record<string, AtsType> = {
  greenhouse: AtsType.GREENHOUSE,
  lever: AtsType.LEVER,
  ashby: AtsType.ASHBY,
  workable: AtsType.WORKABLE,
  smartrecruiters: AtsType.SMARTRECRUITERS,
};

const BOARD_URL: Record<string, (token: string) => string> = {
  greenhouse: (t) => `https://job-boards.greenhouse.io/${t}`,
  lever: (t) => `https://jobs.lever.co/${t}`,
  ashby: (t) => `https://jobs.ashbyhq.com/${t}`,
  workable: (t) => `https://apply.workable.com/${t}`,
};

/**
 * Hand-assigned starting tiers for the 34 boards the spike found. Tier is the
 * PRIMARY pay signal (posting salary is absent on 99.7% of India roles), so
 * these matter - but they are estimates to correct as real offers arrive, not
 * researched figures. See PLAN-v2 change 2.
 */
const TIERS: Record<string, CompanyTier> = {
  // Global companies with Indian engineering offices - highest yield and pay.
  databricks: CompanyTier.T1_GLOBAL_INDIA_OFFICE,
  stripe: CompanyTier.T1_GLOBAL_INDIA_OFFICE,
  coinbase: CompanyTier.T1_GLOBAL_INDIA_OFFICE,
  netskope: CompanyTier.T1_GLOBAL_INDIA_OFFICE,
  druva: CompanyTier.T1_GLOBAL_INDIA_OFFICE,
  openai: CompanyTier.T1_GLOBAL_INDIA_OFFICE,
  anthropic: CompanyTier.T1_GLOBAL_INDIA_OFFICE,
  figma: CompanyTier.T1_GLOBAL_INDIA_OFFICE,
  mixpanel: CompanyTier.T1_GLOBAL_INDIA_OFFICE,
  plaid: CompanyTier.T1_GLOBAL_INDIA_OFFICE,
  ramp: CompanyTier.T1_GLOBAL_INDIA_OFFICE,
  brex: CompanyTier.T1_GLOBAL_INDIA_OFFICE,
  postman: CompanyTier.T1_GLOBAL_INDIA_OFFICE,
  atlan: CompanyTier.T1_GLOBAL_INDIA_OFFICE,
  mindtickle: CompanyTier.T1_GLOBAL_INDIA_OFFICE,
  hackerrank: CompanyTier.T1_GLOBAL_INDIA_OFFICE,
  observeai: CompanyTier.T1_GLOBAL_INDIA_OFFICE,
  netradyne: CompanyTier.T1_GLOBAL_INDIA_OFFICE,
  // Funded Indian product startups.
  paytm: CompanyTier.T2_FUNDED_INDIAN_STARTUP,
  meesho: CompanyTier.T2_FUNDED_INDIAN_STARTUP,
  groww: CompanyTier.T2_FUNDED_INDIAN_STARTUP,
  navi: CompanyTier.T2_FUNDED_INDIAN_STARTUP,
  zeta: CompanyTier.T2_FUNDED_INDIAN_STARTUP,
  epifi: CompanyTier.T2_FUNDED_INDIAN_STARTUP,
  slice: CompanyTier.T2_FUNDED_INDIAN_STARTUP,
  inmobi: CompanyTier.T2_FUNDED_INDIAN_STARTUP,
  glance: CompanyTier.T2_FUNDED_INDIAN_STARTUP,
  sarvam: CompanyTier.T2_FUNDED_INDIAN_STARTUP,
  dozee: CompanyTier.T2_FUNDED_INDIAN_STARTUP,
  // Services / staffing - kept, ranked last.
  turing: CompanyTier.T4_SERVICES_STAFFING,
  andela: CompanyTier.T4_SERVICES_STAFFING,
  toptal: CompanyTier.T4_SERVICES_STAFFING,
  thoughtworks: CompanyTier.T4_SERVICES_STAFFING,
  sigmoid: CompanyTier.T4_SERVICES_STAFFING,
};

const IN_LOCATION =
  /\b(india|bengaluru|bangalore|hyderabad|pune|mumbai|delhi|gurgaon|gurugram|noida|chennai|kolkata|bhubaneswar|ahmedabad|jaipur|indore|kochi|coimbatore)\b/i;

/**
 * Remote eligibility, not just the remote flag. "Remote - India" is applicable;
 * "Remote - US" is not, and lumping them together fills the pool with jobs that
 * cannot be taken. See PLAN-v2 phase 1c.
 */
function remoteType(location: string): RemoteType {
  const l = location.toLowerCase();
  const isRemote = /\bremote\b/.test(l);
  const isHybrid = /\bhybrid\b/.test(l);
  const inIndia = IN_LOCATION.test(location);

  if (isHybrid) return RemoteType.HYBRID;
  if (isRemote && inIndia) return RemoteType.REMOTE_INDIA;
  if (isRemote && /\b(us|usa|united states|canada|emea|uk|europe|latam|brazil|germany)\b/.test(l))
    return RemoteType.REMOTE_OTHER_REGION;
  if (isRemote) return RemoteType.REMOTE_GLOBAL;
  if (inIndia) return RemoteType.ONSITE;
  return RemoteType.UNKNOWN;
}

const SENIOR = /\b(senior|sr\.?|staff|principal|lead|director|head of|chief|iii|iv|v)\b/i;
const JUNIOR = /\b(junior|jr\.?|associate|graduate|entry|intern|i{1,2})\b/i;

function seniority(title: string): string | null {
  if (SENIOR.test(title)) return 'senior';
  if (JUNIOR.test(title)) return 'junior';
  return 'mid';
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Light-touch parse. Returns null for the common case of no usable figure. */
function parseSalary(
  raw: string | null,
): { min: number; max: number; currency: string } | null {
  if (!raw) return null;
  const currency = /₹|inr|lpa/i.test(raw) ? 'INR' : /\$|usd/.test(raw) ? 'USD' : 'USD';
  const nums = [...raw.matchAll(/([\d,.]+)\s*([kK])?/g)]
    .map((m) => {
      const n = parseFloat(m[1].replace(/,/g, ''));
      if (!Number.isFinite(n)) return null;
      return m[2] ? n * 1000 : n;
    })
    .filter((n): n is number => n !== null && n > 0);
  if (nums.length < 2) return null;
  return { min: Math.min(...nums), max: Math.max(...nums), currency };
}

/**
 * Creates the first admin so the dashboard is reachable.
 *
 * The password comes from SEED_ADMIN_PASSWORD, or is randomly generated and
 * printed ONCE. It is never a hardcoded default: a checked-in "admin/admin"
 * survives into whatever this becomes, and a random secret that must be read
 * from the console cannot be forgotten in place.
 */
async function seedAccounts(): Promise<string> {
  const email = (process.env.SEED_ADMIN_EMAIL ?? 'admin@localhost').toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`admin ${email} already exists - password left unchanged`);
    return existing.id;
  }

  const generated = !process.env.SEED_ADMIN_PASSWORD;
  const password = process.env.SEED_ADMIN_PASSWORD ?? randomBytes(12).toString('base64url');

  const admin = await prisma.user.create({
    data: {
      email,
      name: process.env.SEED_ADMIN_NAME ?? 'Admin',
      role: Role.ADMIN,
      passwordHash: await hashPassword(password),
    },
  });

  console.log(`\ncreated admin: ${email}`);
  if (generated) {
    console.log(`generated password: ${password}`);
    console.log('^ shown once. Save it now, or set SEED_ADMIN_PASSWORD and re-run.\n');
  }
  return admin.id;
}

async function main(): Promise<void> {
  await seedAccounts();

  const path = resolve(__dirname, '../../spike/all-postings.json');
  let raw: SpikePosting[];
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as SpikePosting[];
  } catch {
    console.error(
      `Could not read ${path}.\n` +
        `Run the spike first:  cd spike && node sweep.mjs && node analyze.mjs`,
    );
    process.exit(1);
  }

  console.log(`read ${raw.length} postings from the spike snapshot`);

  // --- companies ---------------------------------------------------------
  const boards = new Map<string, { slug: string; ats: string }>();
  for (const p of raw) boards.set(`${p.ats}:${p.company}`, { slug: p.company, ats: p.ats });

  const companyIds = new Map<string, string>();
  for (const { slug, ats } of boards.values()) {
    const atsType = ATS_MAP[ats] ?? AtsType.UNKNOWN;
    const company = await prisma.company.upsert({
      where: { slug },
      update: { atsType, atsToken: slug, tier: TIERS[slug] ?? CompanyTier.UNKNOWN },
      create: {
        name: slug.charAt(0).toUpperCase() + slug.slice(1),
        slug,
        atsType,
        atsToken: slug,
        tier: TIERS[slug] ?? CompanyTier.UNKNOWN,
        isAgency: TIERS[slug] === CompanyTier.T4_SERVICES_STAFFING,
      },
    });
    companyIds.set(slug, company.id);
  }
  console.log(`upserted ${companyIds.size} companies`);

  // --- postings ----------------------------------------------------------
  let written = 0;
  let skipped = 0;
  for (const p of raw) {
    if (!p.title || !p.company) {
      skipped++;
      continue;
    }
    const companyId = companyIds.get(p.company);
    const location = p.location ?? '';
    const sourceJobId = `seed:${p.company}:${createHash('sha1')
      .update(`${p.title}|${location}`)
      .digest('hex')
      .slice(0, 16)}`;
    const salary = parseSalary(p.salary);
    const applyUrl = (BOARD_URL[p.ats] ?? ((t: string) => `https://example.invalid/${t}`))(
      p.company,
    );

    await prisma.jobPosting.upsert({
      where: { source_sourceJobId: { source: p.ats, sourceJobId } },
      update: { lastSeenAt: new Date() },
      create: {
        source: p.ats,
        sourceJobId,
        companyId,
        title: p.title.trim(),
        normalizedTitle: normalizeTitle(p.title),
        // Empty by design: the spike did not retain description bodies. Phase 1
        // connectors fetch them, and scoring cannot run until they do.
        descriptionRaw: '',
        descriptionText: '',
        location,
        remoteType: remoteType(location),
        seniority: seniority(p.title),
        salaryMin: salary ? Math.round(salary.min) : null,
        salaryMax: salary ? Math.round(salary.max) : null,
        salaryCurrency: salary?.currency ?? null,
        salaryPeriod: salary ? 'year' : null,
        salarySource: salary ? SalarySource.STATED : SalarySource.UNKNOWN,
        applyUrl,
        atsType: ATS_MAP[p.ats] ?? AtsType.UNKNOWN,
        contentHash: createHash('sha256')
          .update(`${p.company}|${p.title}|${location}`)
          .digest('hex'),
      },
    });
    written++;
    if (written % 500 === 0) console.log(`  ...${written}`);
  }
  console.log(`upserted ${written} postings (${skipped} skipped)`);

  // --- one SourceRun per connector, so health has history to read --------
  const bySource = new Map<string, { boards: Set<string>; postings: number }>();
  for (const p of raw) {
    const e = bySource.get(p.ats) ?? { boards: new Set<string>(), postings: 0 };
    e.boards.add(p.company);
    e.postings++;
    bySource.set(p.ats, e);
  }
  for (const [source, e] of bySource) {
    await prisma.sourceRun.create({
      data: {
        source,
        startedAt: new Date('2026-09-05T06:00:00Z'),
        finishedAt: new Date('2026-09-05T06:04:00Z'),
        companiesTried: e.boards.size,
        postingsSeen: e.postings,
        postingsNew: e.postings,
        errors: 0,
      },
    });
  }
  console.log(`recorded ${bySource.size} source runs`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
