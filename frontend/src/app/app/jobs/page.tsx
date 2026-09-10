'use client';

/**
 * Every posting discovery has found, arranged by employer.
 *
 * WHY BY COMPANY AND NOT A FLAT LIST. There are 16,500 open postings across 142
 * companies, and the largest single employer accounts for 900 of them. Paged 50 at a
 * time, the first three pages were one company - a list with no shape, where you could
 * not tell whether you had already passed a company or not. The employer is the unit a
 * person thinks in ("what has Stripe got?"), so it is the unit the page is built from.
 *
 * WHY THE POSTINGS LOAD ON EXPAND. Opening Veeva means 900 rows. Fetching every
 * company's postings up front would be a megabyte of JSON to render 142 headings, so each
 * company fetches its own the first time it is opened and React Query keeps it after
 * that - closing and reopening a row costs nothing.
 *
 * This page never applies for anything. The only action on a posting is a link to the
 * real one, which opens in a new tab.
 */

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  Building2,
  ChevronRight,
  ExternalLink,
  Search,
  Sparkles,
} from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/shell';
import {
  Badge,
  Button,
  Card,
  controlClass,
  EmptyState,
  ErrorNote,
  SkeletonCard,
} from '@/components/ui';
import { api, type JobCompanyGroup, type JobRow } from '@/lib/api';
import {
  num,
  REMOTE_LABEL,
  relativeTime,
  salaryText,
  TIER_LABEL,
} from '@/lib/utils';

/** Companies per page. 142 exist, so this is two pages at most today. */
const PAGE = 50;

/**
 * Postings shown inside one open company.
 *
 * 100 rather than everything: nine hundred rows in an expanded accordion is a scroll
 * position nobody can get out of. The row says how many are not shown and offers the
 * filtered flat view for them.
 */
const INNER = 100;

const TIERS = [
  'T1_GLOBAL_INDIA_OFFICE',
  'T2_FUNDED_INDIAN_STARTUP',
  'T3_INDIAN_MIDMARKET',
  'T4_SERVICES_STAFFING',
];

const SORTS: { value: 'postings' | 'name' | 'score'; label: string }[] = [
  { value: 'postings', label: 'Most openings first' },
  { value: 'name', label: 'Company name (A–Z)' },
  { value: 'score', label: 'Best match for you first' },
];

export default function JobsPage() {
  const [q, setQ] = useState('');
  const [tier, setTier] = useState('');
  const [sort, setSort] = useState<'postings' | 'name' | 'score'>('postings');
  const [page, setPage] = useState(0);

  /**
   * Which companies are open, by id.
   *
   * A Set and not a single id, because comparing two employers side by side is the
   * obvious thing to want and an accordion that shuts the last one every time you open
   * a new one makes it impossible.
   */
  const [open, setOpen] = useState<Set<string>>(new Set());

  const params = new URLSearchParams({
    limit: String(PAGE),
    offset: String(page * PAGE),
    sort,
  });
  if (q.trim()) params.set('q', q.trim());
  if (tier) params.set('tier', tier);

  const { data, isLoading, error } = useQuery({
    queryKey: ['me', 'jobs', 'companies', q, tier, sort, page],
    queryFn: () =>
      api.get<{ total: number; items: JobCompanyGroup[] }>(
        `/api/me/jobs/companies?${params.toString()}`,
      ),
    placeholderData: keepPreviousData,
  });

  const total = data?.total ?? 0;
  const lastPage = Math.max(0, Math.ceil(total / PAGE) - 1);
  const openings = (data?.items ?? []).reduce(
    (sum, company) => sum + company.openPostings,
    0,
  );

  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <PageHeader
        title="All jobs"
        subtitle="Every posting found for you, grouped by employer. Open a company to see what it has. Your own score is attached once a match run has read it."
      />

      <div className="space-y-4 px-4 pb-8 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search
              size={14}
              aria-hidden
              className="absolute top-1/2 left-3 -translate-y-1/2 text-[var(--ink-muted)]"
            />
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(0);
              }}
              placeholder="Search company…"
              aria-label="Search company names"
              className={`${controlClass} w-56 pl-8`}
            />
          </div>

          <select
            value={tier}
            onChange={(e) => {
              setTier(e.target.value);
              setPage(0);
            }}
            aria-label="Filter by company tier"
            className={controlClass}
          >
            <option value="">All company tiers</option>
            {TIERS.map((t) => (
              <option key={t} value={t}>
                {TIER_LABEL[t]}
              </option>
            ))}
          </select>

          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value as typeof sort);
              setPage(0);
            }}
            aria-label="Sort companies"
            className={controlClass}
          >
            {SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <span className="figure ml-auto text-xs text-[var(--ink-muted)]">
            {num(total)}{' '}
            <span className="font-sans">
              {total === 1 ? 'company' : 'companies'}
            </span>
            {data && (
              <>
                {' · '}
                {num(openings)} <span className="font-sans">on this page</span>
              </>
            )}
          </span>
        </div>

        {isLoading && !data && <SkeletonCard rows={10} />}
        {error && <ErrorNote message={(error as Error).message} />}

        {data && data.items.length === 0 && (
          <Card>
            <EmptyState
              icon={Building2}
              title="No company matches those filters"
              detail="Try part of a name, or clear the tier filter. Companies with nothing open are not listed at all."
            />
          </Card>
        )}

        {data && data.items.length > 0 && (
          <>
            {/* Dimmed while a new page is in flight. keepPreviousData means the old rows
                stay on screen, which is right - but with no cue at all a slow page looks
                like a click that did nothing. */}
            <Card
              className={isLoading ? 'opacity-60 transition-opacity' : undefined}
            >
              <ul>
                {data.items.map((company) => (
                  <CompanyGroup
                    key={company.id}
                    company={company}
                    open={open.has(company.id)}
                    onToggle={() => toggle(company.id)}
                  />
                ))}
              </ul>
            </Card>

            <div className="flex items-center justify-between text-sm">
              <span className="figure text-xs text-[var(--ink-muted)]">
                page {page + 1} <span className="font-sans">of</span>{' '}
                {lastPage + 1}
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  onClick={() => setPage((p) => Math.min(lastPage, p + 1))}
                  disabled={page >= lastPage}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

/** One employer: a heading that is a button, and its postings once opened. */
function CompanyGroup({
  company,
  open,
  onToggle,
}: {
  company: JobCompanyGroup;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="border-b border-[var(--border)] last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-[var(--surface-hover)]"
      >
        <ChevronRight
          size={15}
          aria-hidden
          className={`shrink-0 text-[var(--ink-muted)] transition-transform duration-150 ${
            open ? 'rotate-90' : ''
          }`}
        />

        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-[var(--ink-primary)]">
            {company.name}
          </span>
          <span className="block truncate text-xs text-[var(--ink-muted)]">
            {TIER_LABEL[company.tier] ?? company.tier}
            {company.isAgency && ' · staffing agency'}
          </span>
        </span>

        {/* The reason to open this row, when there is one. Only shown once a match run
            has actually read something here, so an unscored company says nothing rather
            than showing a zero that looks like a verdict. */}
        {company.bestScore !== null && (
          <span className="hidden items-center gap-1.5 sm:flex">
            <Sparkles size={12} aria-hidden style={{ color: 'var(--accent)' }} />
            <span className="text-xs text-[var(--ink-secondary)]">
              best <span className="figure font-semibold">{company.bestScore}</span>
              {' of '}
              <span className="figure">{company.scoredForYou}</span> read
            </span>
          </span>
        )}

        <Badge tone={open ? 'accent' : 'neutral'}>
          {num(company.openPostings)}{' '}
          {company.openPostings === 1 ? 'opening' : 'openings'}
        </Badge>
      </button>

      {/* Mounted only while open, which is what makes the fetch lazy. */}
      {open && <CompanyPostings company={company} />}
    </li>
  );
}

/** The postings inside one open company. Fetched the first time it is opened. */
function CompanyPostings({ company }: { company: JobCompanyGroup }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['me', 'jobs', 'of-company', company.id],
    queryFn: () =>
      api.get<{ total: number; items: JobRow[] }>(
        `/api/me/jobs?companyId=${company.id}&limit=${INNER}`,
      ),
    // Kept for the session. Reopening a company is a very common thing to do, and
    // re-fetching 900 rows to show what was on screen a second ago is pure waste.
    staleTime: 5 * 60_000,
  });

  if (isLoading) {
    return (
      <div className="bg-[var(--surface-sunken)] px-5 py-4 text-xs text-[var(--ink-muted)]">
        Loading {num(company.openPostings)} opening
        {company.openPostings === 1 ? '' : 's'}…
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-[var(--surface-sunken)] px-5 py-4">
        <ErrorNote message={(error as Error).message} />
      </div>
    );
  }

  if (!data || data.items.length === 0) {
    return (
      <div className="bg-[var(--surface-sunken)] px-5 py-4 text-xs text-[var(--ink-muted)]">
        Nothing open here any more — the employer has taken these down since the
        last fetch.
      </div>
    );
  }

  const hidden = data.total - data.items.length;

  return (
    <div className="bg-[var(--surface-sunken)]">
      <ul>
        {data.items.map((job) => (
          <PostingRow key={job.id} job={job} />
        ))}
      </ul>

      {hidden > 0 && (
        <p className="px-5 py-3 pl-14 text-xs text-[var(--ink-muted)]">
          {num(hidden)} more opening{hidden === 1 ? '' : 's'} here are not shown.
          Search a job title on the matches page to find a specific one.
        </p>
      )}
    </div>
  );
}

/**
 * One posting inside a company.
 *
 * Deliberately not a table. The old flat page used one, which was right when the company
 * was a column - but inside a company the company column is gone and a five-column table
 * nested inside an accordion row cannot align with anything above it.
 */
function PostingRow({ job }: { job: JobRow }) {
  const score = job.matchScores[0];

  const detail = [
    job.location || null,
    job.remoteType !== 'UNKNOWN' ? REMOTE_LABEL[job.remoteType] : null,
    salaryText(job) === 'Not stated' ? null : salaryText(job),
    relativeTime(job.postedAt ?? job.firstSeenAt),
  ].filter((part): part is string => Boolean(part));

  return (
    <li className="flex items-center gap-3 border-t border-[var(--border)] px-5 py-2.5 pl-14">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-[var(--ink-primary)]">
          {job.title}
          {job.seniority && (
            <span className="ml-2 align-middle">
              <Badge>{job.seniority}</Badge>
            </span>
          )}
        </span>
        <span className="block truncate text-xs text-[var(--ink-muted)]">
          {detail.join(' · ')}
        </span>
      </span>

      {/* An em dash and not a 0 when this posting has not been read. The two mean
          opposite things, and printing 0 for "not looked at" is the kind of quiet lie
          that makes a whole column untrustworthy. */}
      <span
        className="figure w-8 shrink-0 text-right text-sm text-[var(--ink-primary)]"
        title={score ? `Scored ${score.score} — ${score.verdict}` : 'Not scored yet'}
      >
        {score ? score.score : <span className="text-[var(--ink-muted)]">—</span>}
      </span>

      {/* A manual link, deliberately. Nothing here is ever submitted for you -
          opening the real posting is the whole action. */}
      <a
        href={job.applyUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex shrink-0 items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border)] px-2 py-1 text-xs text-[var(--ink-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
      >
        Open
        <ExternalLink size={11} aria-hidden />
      </a>
    </li>
  );
}
