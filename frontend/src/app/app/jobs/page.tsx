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
 * WHY THE NUMBERS ARE "FOR YOU" BY DEFAULT. The first version of this page counted every
 * open posting on a board, so OpenAI read "780 openings" and expanding it showed a
 * handful. That was not a labelling problem: 780 is a fact about OpenAI, and the reader
 * wanted a fact about themselves. Only 218 of the 16,527 open postings are engineering
 * roles in India. So the count, the list and the sort all mean "roles that suit you", and
 * the switch at the top reveals the rest for the times you want to look at a whole board.
 *
 * WHY THE POSTINGS LOAD ON EXPAND. Opening Veeva means 900 rows. Fetching every
 * company's postings up front would be a megabyte of JSON to render 142 headings, so each
 * company fetches its own the first time it is opened and React Query keeps it after
 * that - closing and reopening a row costs nothing.
 *
 * This page never applies for anything. The only action on a posting is a link to the
 * real one, which opens in a new tab.
 */

import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Plus,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/shell';
import { useToast } from '@/components/toast';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  controlClass,
  EmptyState,
  ErrorNote,
  SkeletonCard,
} from '@/components/ui';
import {
  api,
  type CompanyAdded,
  type CompanyName,
  type CompanyScan,
  type JobCompanyGroup,
  type JobRow,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
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
 * Postings shown inside one open company, before "Show more".
 *
 * 50 rather than everything: nine hundred rows in an expanded accordion is a scroll
 * position nobody can get out of. Under the default filter almost no company reaches this
 * at all - the largest is 23 - so the button is mainly for the "show everything" mode.
 */
const INNER = 50;

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

/**
 * The two things a count on this page can mean, in the reader's words.
 *
 * Not "filtered / unfiltered". The default is the interesting one, and naming it after
 * the reader rather than after the mechanism is what stops the 780-openings confusion
 * coming back in another form.
 */
const SCOPES: { value: 'suits' | 'all'; label: string }[] = [
  { value: 'suits', label: 'Only jobs that suit me' },
  { value: 'all', label: 'Show everything on their board' },
];

export default function JobsPage() {
  const { isAdmin } = useAuth();

  const [q, setQ] = useState('');
  const [tier, setTier] = useState('');
  const [sort, setSort] = useState<'postings' | 'name' | 'score'>('postings');
  const [only, setOnly] = useState<'suits' | 'all'>('suits');
  const [page, setPage] = useState(0);
  const [adding, setAdding] = useState(false);

  /** The company filter's selection. Empty means every company. */
  const [picked, setPicked] = useState<Set<string>>(new Set());

  /**
   * Which companies are open, by id.
   *
   * A Set and not a single id, because comparing two employers side by side is the
   * obvious thing to want and an accordion that shuts the last one every time you open
   * a new one makes it impossible.
   */
  const [open, setOpen] = useState<Set<string>>(new Set());

  const companyIds = [...picked].sort().join(',');

  const params = new URLSearchParams({
    limit: String(PAGE),
    offset: String(page * PAGE),
    sort,
    only,
  });
  if (q.trim()) params.set('q', q.trim());
  if (tier) params.set('tier', tier);
  if (companyIds) params.set('companyIds', companyIds);

  const { data, isLoading, error } = useQuery({
    queryKey: ['me', 'jobs', 'companies', q, tier, sort, only, companyIds, page],
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

  /** Any change to what is being listed sends you back to the first page. */
  const refilter = (change: () => void) => {
    change();
    setPage(0);
  };

  /**
   * The add-a-company work, held HERE rather than inside the dialog.
   *
   * That is the whole reason the scan can run in the background: a mutation belonging to
   * the dialog dies with it, so closing the dialog would throw away the answer the
   * request was about to bring back. Held on the page, the dialog becomes a window onto
   * work that continues without it.
   */
  const add = useAddCompany({ onSaved: () => setAdding(false) });

  return (
    <>
      <PageHeader
        title="All jobs"
        subtitle="Grouped by employer, and counted the way you asked for. Open a company to see the roles inside it. Your own score appears once a match run has read one."
      >
        {isAdmin && (
          <Button
            size="sm"
            variant="primary"
            icon={add.scan ? Sparkles : Plus}
            busy={add.scanning.isPending}
            onClick={() => setAdding(true)}
          >
            {/* The label is the status. A scan of a page AI has to read takes the better
                part of a minute, and with the dialog shut this button is the only place
                that can say so - a plain "Add a company" would look like the press did
                nothing at all. */}
            {add.scanning.isPending
              ? 'Scanning…'
              : add.scan
                ? `Review ${add.scan.name}`
                : 'Add a company'}
          </Button>
        )}
      </PageHeader>

      {/* Admin-only, and the button above is the only way in. A modal rather than a panel
          in the flow: scanning a page is a short errand with a decision at the end of it,
          and a panel that pushes the whole list down while you read its result makes you
          lose the place you were looking at. */}
      {isAdmin && adding && (
        <AddCompanyModal add={add} onClose={() => setAdding(false)} />
      )}

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
              onChange={(e) => refilter(() => setQ(e.target.value))}
              placeholder="Search company…"
              aria-label="Search company names"
              className={`${controlClass} w-48 pl-8`}
            />
          </div>

          <CompanyFilter
            picked={picked}
            onChange={(next) => refilter(() => setPicked(next))}
          />

          <select
            value={only}
            onChange={(e) =>
              refilter(() => setOnly(e.target.value as typeof only))
            }
            aria-label="Which jobs to count and show"
            className={controlClass}
          >
            {SCOPES.map((scope) => (
              <option key={scope.value} value={scope.value}>
                {scope.label}
              </option>
            ))}
          </select>

          <select
            value={tier}
            onChange={(e) => refilter(() => setTier(e.target.value))}
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
            onChange={(e) => refilter(() => setSort(e.target.value as typeof sort))}
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
                {num(openings)}{' '}
                <span className="font-sans">
                  {only === 'suits' ? 'for you here' : 'openings here'}
                </span>
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
              title="No company has a job that fits those filters"
              detail={
                only === 'suits'
                  ? 'Nothing here matches the roles and places you are open to. Switch to “Show everything on their board” to see what else these employers have.'
                  : 'Try part of a name, or clear the tier filter. Companies with nothing open are not listed at all.'
              }
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
                    only={only}
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

/**
 * The company filter: tick the employers you want, see only those.
 *
 * A panel of checkboxes rather than a `<select multiple>`, which on a list of 142 names
 * is a scrolling box where ctrl-click is the only way to pick a second one and one stray
 * plain click silently throws the whole selection away.
 *
 * THE LIST IS NOT NARROWED BY THE OTHER FILTERS, and that is the same decision the server
 * makes for the same reason: a picker whose contents changed when you flipped the "show
 * everything" switch would drop the company you had just chosen, and your selection would
 * quietly stop meaning anything.
 */
function CompanyFilter({
  picked,
  onChange,
}: {
  picked: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['me', 'jobs', 'company-names'],
    queryFn: () => api.get<CompanyName[]>('/api/me/jobs/company-names'),
    // The set of employers changes when discovery runs, which is once a night. Re-asking
    // every time this panel opens would be a request per click for an answer that has
    // not moved.
    staleTime: 10 * 60_000,
  });

  const all = data ?? [];
  const needle = find.trim().toLowerCase();
  const shown = needle
    ? all.filter((company) => company.name.toLowerCase().includes(needle))
    : all;

  const flip = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  const label =
    picked.size === 0
      ? 'All companies'
      : picked.size === 1
        ? (all.find((company) => picked.has(company.id))?.name ?? '1 company')
        : `${picked.size} companies`;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className={`${controlClass} flex items-center gap-1.5 ${
          picked.size > 0 ? 'border-[var(--accent)] text-[var(--accent)]' : ''
        }`}
      >
        <Building2 size={13} aria-hidden />
        <span className="max-w-40 truncate">{label}</span>
        <ChevronDown size={13} aria-hidden />
      </button>

      {open && (
        <>
          {/* Catches a click anywhere else so the panel closes the way every other
              dropdown on the web does. Not focusable - keyboard users close it with the
              button, which stays in the tab order. */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-20 cursor-default"
          />

          <div className="absolute top-full left-0 z-30 mt-1 w-72 rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--surface)] shadow-lg">
            <div className="border-b border-[var(--border)] p-2">
              <input
                value={find}
                onChange={(e) => setFind(e.target.value)}
                placeholder="Find a company…"
                aria-label="Find a company in this list"
                autoFocus
                className={`${controlClass} w-full`}
              />
            </div>

            <div className="max-h-72 overflow-y-auto py-1">
              {isLoading && (
                <p className="px-3 py-2 text-xs text-[var(--ink-muted)]">
                  Loading companies…
                </p>
              )}

              {!isLoading && shown.length === 0 && (
                <p className="px-3 py-2 text-xs text-[var(--ink-muted)]">
                  No company name contains “{find.trim()}”.
                </p>
              )}

              {shown.map((company) => {
                const on = picked.has(company.id);
                return (
                  <button
                    key={company.id}
                    type="button"
                    onClick={() => flip(company.id)}
                    aria-pressed={on}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-[var(--surface-hover)]"
                  >
                    <span
                      aria-hidden
                      className={`flex size-4 shrink-0 items-center justify-center rounded-[var(--r-sm)] border ${
                        on
                          ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                          : 'border-[var(--border)]'
                      }`}
                    >
                      {on && <Check size={11} strokeWidth={3} />}
                    </span>
                    <span className="truncate text-[var(--ink-primary)]">
                      {company.name}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="flex items-center justify-between border-t border-[var(--border)] px-3 py-2">
              <span className="figure text-xs text-[var(--ink-muted)]">
                {picked.size === 0 ? (
                  <span className="font-sans">none picked</span>
                ) : (
                  <>
                    {picked.size} <span className="font-sans">picked</span>
                  </>
                )}
              </span>
              <Button
                size="sm"
                onClick={() => onChange(new Set())}
                disabled={picked.size === 0}
              >
                Clear
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** One employer: a heading that is a button, and its postings once opened. */
function CompanyGroup({
  company,
  only,
  open,
  onToggle,
}: {
  company: JobCompanyGroup;
  only: 'suits' | 'all';
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

        {/* The reason to open this row, when there is one.
            "best 72 of 1 read" was two facts jammed into four words, and neither of them
            landed - the 1 read as part of the score. Now the chip carries the one number
            worth glancing at and the sentence explaining it is in the tooltip. Shown only
            once a match run has read something here, so an unscored company says nothing
            rather than showing a zero that looks like a verdict. */}
        {company.bestScore !== null && (
          <span
            className="hidden items-center gap-1.5 sm:flex"
            title={
              `Your best score at ${company.name} is ${company.bestScore} out of 100. ` +
              `A match run has read ${company.scoredForYou} of the ` +
              `${company.openPostings} openings listed here; the rest have not been ` +
              `scored yet.`
            }
          >
            <Sparkles size={12} aria-hidden style={{ color: 'var(--accent)' }} />
            <span className="text-xs text-[var(--ink-secondary)]">
              best match{' '}
              <span className="figure font-semibold">{company.bestScore}</span>
            </span>
          </span>
        )}

        {/* This number is now the number of rows you get when you open the row - which is
            the whole complaint the "suits me" default fixed. */}
        <Badge tone={open ? 'accent' : 'neutral'}>
          {num(company.openPostings)}{' '}
          {only === 'suits'
            ? 'for you'
            : company.openPostings === 1
              ? 'opening'
              : 'openings'}
        </Badge>
      </button>

      {/* Mounted only while open, which is what makes the fetch lazy. */}
      {open && <CompanyPostings company={company} only={only} />}
    </li>
  );
}

/** The postings inside one open company. Fetched the first time it is opened. */
function CompanyPostings({
  company,
  only,
}: {
  company: JobCompanyGroup;
  only: 'suits' | 'all';
}) {
  /**
   * "Show more" ADDS to what is on screen rather than replacing it.
   *
   * Not a nested pager, and not a bigger `limit` either. Inside one company the rows are
   * all of one kind, so there is no reason to lose the ones you have already scrolled
   * past - and the server caps `limit` at 200, which one 900-posting employer exceeds.
   * Asking for the next slice by offset is the only shape that can reach the end of it.
   */
  const { data, isLoading, isFetchingNextPage, fetchNextPage, error } =
    useInfiniteQuery({
      queryKey: ['me', 'jobs', 'of-company', company.id, only],
      queryFn: ({ pageParam }) =>
        api.get<{ total: number; items: JobRow[] }>(
          `/api/me/jobs?companyId=${company.id}&only=${only}&limit=${INNER}&offset=${pageParam}`,
        ),
      initialPageParam: 0,
      getNextPageParam: (last, pages) => {
        const have = pages.reduce((sum, page) => sum + page.items.length, 0);
        // Undefined means "there is no next page", which is what hides the button.
        return have < last.total ? have : undefined;
      },
      // Kept for the session. Reopening a company is a very common thing to do, and
      // re-fetching its rows to show what was on screen a second ago is pure waste.
      staleTime: 5 * 60_000,
    });

  const items = data?.pages.flatMap((page) => page.items) ?? [];
  const total = data?.pages[0]?.total ?? 0;
  const hidden = total - items.length;

  if (isLoading && !data) {
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

  if (items.length === 0) {
    return (
      <div className="bg-[var(--surface-sunken)] px-5 py-4 text-xs text-[var(--ink-muted)]">
        Nothing open here any more — the employer has taken these down since the
        last fetch.
      </div>
    );
  }

  return (
    <div className="bg-[var(--surface-sunken)]">
      <ul>
        {items.map((job) => (
          <PostingRow key={job.id} job={job} />
        ))}
      </ul>

      {/* Was a dead end: "680 more openings here are not shown. Search a job title on
          the matches page." It named a number, offered no way to see it, and pointed at
          another page. Now it is a button, and pressing it enough times reaches the end. */}
      {hidden > 0 && (
        <div className="flex items-center gap-3 px-5 py-3 pl-14">
          <Button
            size="sm"
            busy={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
          >
            Show {num(Math.min(hidden, INNER))} more
          </Button>
          <span className="figure text-xs text-[var(--ink-muted)]">
            {num(items.length)} <span className="font-sans">of</span> {num(total)}{' '}
            <span className="font-sans">shown</span>
          </span>
        </div>
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

/**
 * Adding one employer, as state that outlives the dialog showing it.
 *
 * TWO STEPS, NOT ONE, and the split is the point. "Scan" fetches the page and reports
 * what is on it while writing nothing; "Save" writes what the scan found. A single
 * add-this-URL button would put rows into the shared job list on the strength of an
 * address nobody had looked at yet, and pasting a partner directory instead of a careers
 * page would quietly add forty companies that do not employ anyone.
 *
 * The save request sends back the scan's id and nothing else - not the postings. The
 * server holds what it found, so what gets written is what was shown here.
 *
 * A HOOK ON THE PAGE, NOT STATE IN THE DIALOG. Reading a careers page can take the better
 * part of a minute, and nobody should have to sit and watch it. Held here, the dialog can
 * shut the moment the scan starts and the request carries on; the answer arrives in a
 * toast, and reopening the dialog shows it.
 */
function useAddCompany({ onSaved }: { onSaved: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [tier, setTier] = useState('');
  const [scan, setScan] = useState<CompanyScan | null>(null);

  const scanning = useMutation({
    mutationFn: () =>
      api.post<CompanyScan>('/api/admin/companies/scan', {
        url: url.trim(),
        name: name.trim() || undefined,
        tier: tier || undefined,
      }),
    onSuccess: (result) => {
      setScan(result);
      // The scan may have read the employer's real name off the page, which is usually
      // better than the guess from the hostname. Filled in rather than applied silently,
      // so it is still editable before saving.
      if (!name.trim()) setName(result.name);
      // Said out loud, because by now the dialog is shut and nothing else on screen
      // would mention that the work finished.
      toast.info(
        `${result.name}: ${result.postings.length} openings found, ` +
          `${result.suitable} suit you. Open it to save.`,
      );
    },
    // Toasted as well as shown in the dialog. With the dialog closed the ErrorNote inside
    // it has nobody to tell, and a scan that failed in silence looks like one still
    // running.
    onError: (failure: Error) => toast.error(failure.message),
  });

  const saving = useMutation({
    mutationFn: (scanId: string) =>
      api.post<CompanyAdded>('/api/admin/companies', { scanId }),
    onSuccess: (result) => {
      toast.success(
        result.created > 0
          ? `${result.name} added, with ${result.created} openings.`
          : `${result.name} added.`,
      );
      // Prefix invalidation: the company list, every open company's postings, and the
      // filter's names are all now out of date.
      void queryClient.invalidateQueries({ queryKey: ['me', 'jobs'] });
      // Cleared and dismissed together: the company is on the list now, so a dialog
      // still offering to save it would be offering to do it twice.
      setUrl('');
      setName('');
      setTier('');
      setScan(null);
      onSaved();
    },
    onError: (failure: Error) => toast.error(failure.message),
  });

  return {
    url,
    setUrl,
    name,
    setName,
    tier,
    setTier,
    scan,
    setScan,
    scanning,
    saving,
  };
}

type AddCompany = ReturnType<typeof useAddCompany>;

/** The window onto that work. Closing it does not stop it. */
function AddCompanyModal({
  add,
  onClose,
}: {
  add: AddCompany;
  onClose: () => void;
}) {
  const {
    url,
    setUrl,
    name,
    setName,
    tier,
    setTier,
    scan,
    setScan,
    scanning,
    saving,
  } = add;

  const busy = scanning.isPending || saving.isPending;

  /**
   * Escape closes, the way the command palette does.
   *
   * Except while the save is in flight. That request has already left, and a dialog that
   * disappears mid-write leaves you with no idea whether the company was added.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving.isPending) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving.isPending]);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto px-4 py-[8vh]"
      // A click on the dark area closes. The dialog below stops the event, so only a
      // click on the empty space counts - and not while saving, for the reason above.
      onMouseDown={() => {
        if (!saving.isPending) onClose();
      }}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" aria-hidden />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add a company"
        onMouseDown={(e) => e.stopPropagation()}
        className="animate-pop relative w-full max-w-2xl"
      >
        <Card>
          <CardHeader
            title="Add a company"
            subtitle="Paste the address of its careers page. The scan runs in the background, and nothing is saved until you press Save."
            icon={Building2}
            action={
              <Button
                size="sm"
                icon={X}
                onClick={onClose}
                disabled={saving.isPending}
              >
                Close
              </Button>
            }
          />

          {/* Capped and scrollable, because a scan of a large board lists twelve roles
              and several notes - which on a short screen would push the Save button off
              the bottom with no way to reach it. */}
          <div className="max-h-[70vh] space-y-3 overflow-y-auto p-5">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-[var(--ink-secondary)]">
                Careers page address
              </span>
              <input
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  // The old result described the old address. Cleared so a stale scan
                  // cannot be saved against a URL that has since been edited.
                  setScan(null);
                }}
                placeholder="https://www.example.com/careers"
                autoFocus
                // Locked while a scan is running. Editing it clears the scan, and a
                // result would then arrive describing an address no longer in the box.
                disabled={busy}
                className={`${controlClass} w-full`}
              />
            </label>

            <div className="flex flex-wrap items-end gap-2">
              <label className="flex min-w-44 flex-1 flex-col gap-1">
                <span className="text-xs text-[var(--ink-secondary)]">
                  Company name (optional)
                </span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Guessed from the address"
                  disabled={busy}
                  className={`${controlClass} w-full`}
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-xs text-[var(--ink-secondary)]">
                  Pay band (optional)
                </span>
                <select
                  value={tier}
                  onChange={(e) => setTier(e.target.value)}
                  disabled={busy}
                  className={controlClass}
                >
                  <option value="">Not sure yet</option>
                  {TIERS.map((t) => (
                    <option key={t} value={t}>
                      {TIER_LABEL[t]}
                    </option>
                  ))}
                </select>
              </label>

              {/* Starts the scan AND shuts the dialog. Reading a careers page means a
                  fetch plus an AI pass over the text, which is tens of seconds of
                  nothing to look at - so the dialog gets out of the way and the header
                  button carries the progress. */}
              <Button
                variant="primary"
                icon={Search}
                disabled={busy || url.trim().length < 4}
                onClick={() => {
                  scanning.mutate();
                  onClose();
                }}
              >
                Scan in the background
              </Button>
            </div>

            {scanning.error && (
              <ErrorNote message={(scanning.error as Error).message} />
            )}
            {saving.error && (
              <ErrorNote message={(saving.error as Error).message} />
            )}

            {/* Shown if you reopen the dialog while the scan is still going. It is the
                only place that can say what is being waited on, since the header button
                has room for one word. */}
            {scanning.isPending && (
              <p className="text-xs text-[var(--ink-secondary)]">
                Reading that page now. You can close this and carry on — the result
                arrives as a message, and this button turns into “Review”. A job board
                answers in a second or two; a page AI has to read takes longer.
              </p>
            )}

            {!scan && !scanning.isPending && (
              <p className="text-xs text-[var(--ink-muted)]">
                A job board address works best — Greenhouse, Lever, Ashby,
                SmartRecruiters or Workable. If it is the company&rsquo;s own page,
                AI reads the page instead, which finds the roles but not their
                descriptions.
              </p>
            )}

            {scan && <ScanResult scan={scan} />}

            {scan && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  icon={Check}
                  busy={saving.isPending}
                  disabled={busy}
                  onClick={() => saving.mutate(scan.scanId)}
                >
                  {scan.existing
                    ? `Update ${scan.name}`
                    : `Save ${scan.name} and its openings`}
                </Button>
                <Button onClick={() => setScan(null)} disabled={busy}>
                  Discard this scan
                </Button>
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

/** What the scan found, before anything is written. */
function ScanResult({ scan }: { scan: CompanyScan }) {
  /** The first few, so the dialog does not become a second jobs page. */
  const preview = scan.postings.slice(0, 12);
  const rest = scan.postings.length - preview.length;

  return (
    <div className="space-y-3 rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--surface-sunken)] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-[var(--ink-primary)]">
          {scan.name}
        </span>
        <Badge tone={scan.via === 'ats' ? 'good' : 'warning'}>
          {scan.via === 'ats' ? `read from ${scan.source}` : 'read by AI'}
        </Badge>
        {scan.existing && <Badge tone="neutral">already on the list</Badge>}
        <span className="figure ml-auto text-xs text-[var(--ink-muted)]">
          {num(scan.postings.length)}{' '}
          <span className="font-sans">
            {scan.postings.length === 1 ? 'opening' : 'openings'}
          </span>
          {' · '}
          {num(scan.suitable)} <span className="font-sans">suit you</span>
        </span>
      </div>

      {scan.notes.map((note) => (
        <p key={note} className="text-xs text-[var(--ink-secondary)]">
          {note}
        </p>
      ))}

      {/* Said before Save rather than after. Otherwise saving reports "0 openings
          added" for a board that plainly listed 300, and the only explanation arrives
          once the decision has already been made. */}
      {!scan.writesPostingsNow && (
        <p className="text-xs text-[var(--ink-secondary)]">
          The company is saved straight away; these openings appear on tonight&rsquo;s
          run, because this board needs one request per role to read them.
        </p>
      )}

      <ul className="space-y-1">
        {preview.map((posting) => (
          <li
            key={`${posting.title}|${posting.location ?? ''}`}
            className="flex items-center gap-2 text-xs"
          >
            {/* The tick is the same test the jobs page counts by, so a scan promising 12
                and a page showing 3 cannot happen. */}
            <span
              aria-hidden
              className={
                posting.suits
                  ? 'text-[var(--status-good)]'
                  : 'text-[var(--ink-muted)]'
              }
            >
              {posting.suits ? '✓' : '·'}
            </span>
            <span className="truncate text-[var(--ink-primary)]">
              {posting.title}
            </span>
            <span className="truncate text-[var(--ink-muted)]">
              {posting.location ?? 'no place given'}
            </span>
          </li>
        ))}
      </ul>

      {rest > 0 && (
        <p className="figure text-xs text-[var(--ink-muted)]">
          {num(rest)} <span className="font-sans">more not listed here</span>
        </p>
      )}
    </div>
  );
}
