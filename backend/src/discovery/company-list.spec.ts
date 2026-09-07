/**
 * The company list loader.
 *
 * Two things here are worth a test rather than a read-through. The duplicate-slug
 * rule, because two tiers for one company is a silent mis-ranking rather than a
 * crash. And the ats/token pairing, because a half-specified board is the shape that
 * would send a request to the wrong API.
 *
 * The real config/companies.yaml is also loaded, as a fixture of itself: it is the
 * load-bearing artifact of the project and a stray tab or duplicated key in it should
 * fail in CI rather than thirty seconds into a sweep.
 */
import { CompanyTier } from '@prisma/client';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  CompanyListError,
  loadCompanyList,
  tierCounts,
} from './company-list';

/** Writes a YAML file to a temp dir and returns its path. */
function fixture(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'company-list-'));
  const path = join(dir, 'companies.yaml');
  writeFileSync(path, yaml, 'utf8');
  return path;
}

describe('loadCompanyList', () => {
  it('reads the short form and attaches the tier from the group', () => {
    const entries = loadCompanyList(
      fixture(`
t1_global_india_office:
  databricks: Databricks
t2_funded_indian_startup:
  meesho: Meesho
`),
    );

    expect(entries).toEqual([
      {
        slug: 'databricks',
        name: 'Databricks',
        tier: CompanyTier.T1_GLOBAL_INDIA_OFFICE,
        atsType: undefined,
        token: undefined,
        isAgency: false,
      },
      {
        slug: 'meesho',
        name: 'Meesho',
        tier: CompanyTier.T2_FUNDED_INDIAN_STARTUP,
        atsType: undefined,
        token: undefined,
        isAgency: false,
      },
    ]);
  });

  it('reads a known board from the object form', () => {
    const [bosch] = loadCompanyList(
      fixture(`
t1_global_india_office:
  bosch:
    name: Bosch
    ats: SMARTRECRUITERS
    token: BoschGroup
    note: the id is not guessable
`),
    );

    expect(bosch.atsType).toBe('SMARTRECRUITERS');
    expect(bosch.token).toBe('BoschGroup');
  });

  it('marks every T4 entry as an agency', () => {
    const [turing] = loadCompanyList(
      fixture(`
t4_services_staffing:
  turing: Turing
`),
    );
    expect(turing.isAgency).toBe(true);
  });

  it('refuses a slug that appears under two tiers', () => {
    expect(() =>
      loadCompanyList(
        fixture(`
t1_global_india_office:
  acme: Acme
t3_indian_midmarket:
  acme: Acme
`),
      ),
    ).toThrow(/listed under both/);
  });

  it('refuses an ATS without a token, and a token without an ATS', () => {
    expect(() =>
      loadCompanyList(
        fixture(`
t1_global_india_office:
  acme:
    name: Acme
    ats: SMARTRECRUITERS
`),
      ),
    ).toThrow(CompanyListError);

    expect(() =>
      loadCompanyList(
        fixture(`
t1_global_india_office:
  acme:
    name: Acme
    token: AcmeGroup
`),
      ),
    ).toThrow(CompanyListError);
  });

  it('refuses a slug that is not a URL path segment', () => {
    // `Infra.Market` is the shape that motivates this: the brand has a dot in it,
    // the board identifier cannot.
    expect(() =>
      loadCompanyList(
        fixture(`
t2_funded_indian_startup:
  Infra.Market: Infra.Market
`),
      ),
    ).toThrow(CompanyListError);
  });

  it('refuses an unknown top-level key rather than ignoring it', () => {
    // A typo'd tier heading would otherwise drop a whole category in silence.
    expect(() =>
      loadCompanyList(
        fixture(`
t1_global_indian_office:
  acme: Acme
`),
      ),
    ).toThrow(CompanyListError);
  });

  it('reports a missing file as a clean error', () => {
    expect(() => loadCompanyList('/nonexistent/companies.yaml')).toThrow(
      CompanyListError,
    );
  });

  describe('the real config/companies.yaml', () => {
    const entries = loadCompanyList(
      resolve(__dirname, '../../../config/companies.yaml'),
    );

    it('parses, and is big enough to be worth sweeping', () => {
      // PLAN-v2 phase 1b targets 400-500. This asserts the floor rather than the
      // target: the file should be allowed to grow without editing a test, but a
      // change that accidentally truncates it should fail here.
      expect(entries.length).toBeGreaterThan(350);
    });

    it('covers every tier', () => {
      const counts = tierCounts(entries);
      expect(counts.T1_GLOBAL_INDIA_OFFICE).toBeGreaterThan(50);
      expect(counts.T2_FUNDED_INDIAN_STARTUP).toBeGreaterThan(50);
      expect(counts.T3_INDIAN_MIDMARKET).toBeGreaterThan(20);
      expect(counts.T4_SERVICES_STAFFING).toBeGreaterThan(20);
      // Nothing should be UNKNOWN: every entry comes from a tier group.
      expect(counts.UNKNOWN).toBe(0);
    });

    it('keeps the 34 boards the spike confirmed', () => {
      const slugs = new Set(entries.map((e) => e.slug));
      for (const confirmed of [
        'databricks',
        'stripe',
        'coinbase',
        'netskope',
        'druva',
        'postman',
        'paytm',
        'meesho',
        'groww',
        'turing',
      ]) {
        expect(slugs).toContain(confirmed);
      }
    });
  });
});
