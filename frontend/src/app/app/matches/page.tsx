'use client';

/**
 * Where you can apply: press one button, get your postings ranked best-first.
 *
 * WHY A BUTTON AND NOT AUTOMATIC. There IS an automatic run, at 07:00 every day. This
 * page exists because "I have just changed my resume, look again now" is a thing a
 * person wants at 3pm, and because a search that only ever happens while you are asleep
 * is impossible to trust - you cannot watch it work.
 *
 * WHY IT POLLS. Reading 17,000 postings and asking an AI about the survivors takes
 * minutes. The request that starts it returns immediately and the work happens in the
 * worker process, so this page asks "how is it going" every few seconds instead of
 * holding a connection open. Closing the tab does not stop the run, which is the point.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  ExternalLink,
  FileWarning,
  Search,
  Sparkles,
  Undo2,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
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
  type MatchDecision,
  type MatchRunStarted,
  type MatchRunStatus,
  type MatchSuggestion,
} from '@/lib/api';
import { num, relativeTime } from '@/lib/utils';

/**
 * How often to ask whether the run has finished, in milliseconds.
 *
 * Only while one is actually going - see `refetchInterval` below, which returns false
 * otherwise. A fixed interval would keep a tab left open overnight asking all night.
 */
const POLL_MS = 3_000;

/** The verdicts, worst to best, with the colour each one earns. */
const VERDICT_TONE: Record<string, 'good' | 'accent' | 'warning' | 'neutral'> = {
  STRONG: 'good',
  GOOD: 'good',
  BORDERLINE: 'accent',
  WEAK: 'warning',
  REJECT: 'neutral',
};

/**
 * Below this, a posting is not shown by default.
 *
 * 50 rather than 0 because the funnel deliberately keeps its rejections - they are what
 * makes a too-tight filter visible - but a first-time reader opening this page does not
 * want 174 refusals above the eleven things they could actually apply for. The fit filter
 * says how many are hidden and reaches them in one click, so nothing is concealed.
 */
const DEFAULT_MIN_SCORE = 50;

/**
 * How many rows one fetch of this list can hold - the server's own ceiling.
 *
 * It matters on screen because the server fills that ceiling BY SCORE. So when the list
 * comes back full, "newest first" means the newest of the 200 best fits and not the
 * newest of everything scored, and the card says so rather than letting the order imply
 * something it cannot deliver.
 */
const PAGE_CAP = 200;

/**
 * The orders the list can be read in.
 *
 * Each label names the direction as well as the field. "Posted date" on its own leaves
 * you to guess whether the top row is this morning's posting or last year's, and the
 * wrong guess is invisible - every row looks plausible either way.
 */
const SORTS = [
  { value: 'fit', label: 'Best fit first' },
  { value: 'posted', label: 'Newest posting first' },
  { value: 'scored', label: 'Most recently scored first' },
  { value: 'pay', label: 'Highest pay first' },
  { value: 'title', label: 'Job title (A–Z)' },
  { value: 'company', label: 'Company (A–Z)' },
] as const;

type Sort = (typeof SORTS)[number]['value'];

/**
 * The fit thresholds offered, as scores rather than as verdict names.
 *
 * The verdict is a band of the score (a STRONG is simply a high one), so filtering on
 * both would be two controls fighting over one number.
 */
const FITS: { value: number; label: string }[] = [
  { value: 0, label: 'Any fit, including the rejects' },
  { value: DEFAULT_MIN_SCORE, label: 'Fit 50 and up' },
  { value: 70, label: 'Fit 70 and up' },
  { value: 85, label: 'Fit 85 and up' },
];

/** Filtering on your own yes/no, which is a different question from the AI's score. */
const DECISIONS: { value: 'all' | MatchDecision; label: string }[] = [
  { value: 'all', label: 'Whatever I said' },
  { value: 'UNDECIDED', label: 'Not decided yet' },
  { value: 'WANTED', label: 'The ones I said yes to' },
  { value: 'NOT_WANTED', label: 'The ones I turned down' },
];

/** Newest first, with "no date recorded" at the end rather than at the top. */
function byNewest(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return Date.parse(b) - Date.parse(a);
}

/** Highest first, with "not stated" at the end. Salary arrives as a decimal string. */
function byPay(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return Number(b) - Number(a);
}

/** Best fit first, and the server's own tie-break after it. */
function byFit(a: MatchSuggestion, b: MatchSuggestion): number {
  return b.score - a.score || byNewest(a.scoredAt, b.scoredAt);
}

/**
 * The list in the chosen order.
 *
 * Every order falls back to fit, so rows that tie on the chosen field - two postings from
 * the same company, a dozen with no pay stated - still arrive best-first instead of in
 * whatever order the database happened to return them.
 */
function sortRows(rows: MatchSuggestion[], sort: Sort): MatchSuggestion[] {
  // A copy. React Query hands back the cached array itself, and sorting in place would
  // reorder the cache underneath anything else reading this query.
  const out = [...rows];

  switch (sort) {
    case 'posted':
      return out.sort((a, b) => byNewest(a.postedAt, b.postedAt) || byFit(a, b));
    case 'scored':
      return out.sort((a, b) => byNewest(a.scoredAt, b.scoredAt) || byFit(a, b));
    case 'pay':
      return out.sort(
        (a, b) =>
          byPay(a.estimatedSalaryLPA, b.estimatedSalaryLPA) || byFit(a, b),
      );
    case 'title':
      return out.sort((a, b) => a.title.localeCompare(b.title) || byFit(a, b));
    case 'company':
      return out.sort((a, b) => a.company.localeCompare(b.company) || byFit(a, b));
    default:
      return out.sort(byFit);
  }
}

export default function MatchesPage() {
  const toast = useToast();
  const queryClient = useQueryClient();

  /** What is being shown, and in what order. Held here; the list is filtered in memory. */
  const [q, setQ] = useState('');
  const [minFit, setMinFit] = useState(DEFAULT_MIN_SCORE);
  const [decided, setDecided] = useState<'all' | MatchDecision>('all');
  const [sort, setSort] = useState<Sort>('fit');

  const status = useQuery({
    queryKey: ['me', 'matches', 'run'],
    queryFn: () => api.get<MatchRunStatus>('/api/me/matches/run'),
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === 'queued' || state === 'running' ? POLL_MS : false;
    },
  });

  const suggestions = useQuery({
    queryKey: ['me', 'matches'],
    queryFn: () =>
      api.get<MatchSuggestion[]>(`/api/me/matches?limit=${PAGE_CAP}`),
  });

  const busy = status.data?.state === 'queued' || status.data?.state === 'running';

  const start = useMutation({
    mutationFn: () => api.post<MatchRunStarted>('/api/me/matches/run'),
    onSuccess: (result) => {
      queryClient.setQueryData(['me', 'matches', 'run'], result);
      if (result.started) toast.info('Searching. You can leave this page.');
      else toast.info('A search is already running.');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const decide = useMutation({
    mutationFn: ({
      jobId,
      decision,
    }: {
      jobId: string;
      decision: MatchDecision;
    }) => api.patch<void>(`/api/me/jobs/${jobId}/decision`, { decision }),
    // Refetched rather than patched locally: unlike the digest, this list IS a live
    // query, so the server's copy is the truth and a local edit would be a second
    // version of it waiting to disagree.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['me', 'matches'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // The list is refetched the moment a run finishes, which is the moment new rows
  // exist. Keyed on the finish time rather than on the state, so a poll that keeps
  // answering 'done' does not keep refetching a list that has not changed.
  const finishedAt = status.data?.finishedAt ?? null;
  useEffect(() => {
    if (finishedAt) {
      void queryClient.invalidateQueries({ queryKey: ['me', 'matches'] });
    }
  }, [finishedAt, queryClient]);

  // Memoised only so the empty fallback is not a brand new array on every render, which
  // would defeat the filter below it.
  const all = useMemo(() => suggestions.data ?? [], [suggestions.data]);

  /**
   * Filtered and sorted here rather than by the server.
   *
   * The whole page is already in memory - the fetch above asks for the server's maximum -
   * so re-ordering it is instant, and a request per keystroke to re-sort rows the browser
   * is already holding would only make the page slower to use.
   */
  const needle = q.trim().toLowerCase();
  const shown = useMemo(
    () =>
      sortRows(
        all.filter(
          (row) =>
            row.score >= minFit &&
            (decided === 'all' || row.decision === decided) &&
            (needle === '' ||
              row.title.toLowerCase().includes(needle) ||
              row.company.toLowerCase().includes(needle)),
        ),
        sort,
      ),
    [all, minFit, decided, needle, sort],
  );

  const hidden = all.length - shown.length;
  /**
   * How many of the rows on screen are ones nobody will fill in for you.
   *
   * Counted over `shown` rather than over everything fetched, so the sentence explaining
   * the badge appears exactly when a badge is visible. Explaining a marker that is
   * filtered out of view is how a page teaches somebody a rule they then cannot find.
   */
  const byHand = shown.filter((row) => row.applyByHand).length;
  const filtered = needle !== '' || minFit !== DEFAULT_MIN_SCORE || decided !== 'all';
  const clear = () => {
    setQ('');
    setMinFit(DEFAULT_MIN_SCORE);
    setDecided('all');
  };

  return (
    <>
      <PageHeader
        title="Where you can apply"
        subtitle="Your postings, best fit first. Every score is an AI reading that job against your resume."
      >
        <Button
          variant="primary"
          icon={Search}
          busy={busy || start.isPending}
          onClick={() => start.mutate()}
        >
          {busy ? 'Searching…' : 'Find my matches'}
        </Button>
      </PageHeader>

      <div className="space-y-5 px-4 pb-6 sm:px-6">
        <RunCard status={status.data} />

        {suggestions.error && (
          <ErrorNote message={(suggestions.error as Error).message} />
        )}

        {suggestions.isLoading ? (
          <SkeletonCard rows={8} />
        ) : (
          <Card>
            <CardHeader
              title={
                shown.length === 0
                  ? 'Nothing to show yet'
                  : `${shown.length} worth a look`
              }
              subtitle="Say no to anything you would not take. It stops a resume being written and a form being opened for it."
              action={
                hidden > 0 ? (
                  <span className="figure text-xs text-[var(--ink-muted)]">
                    {num(hidden)}{' '}
                    <span className="font-sans">not shown by these filters</span>
                  </span>
                ) : undefined
              }
            />

            {all.length > 0 && (
              <Controls
                q={q}
                onQ={setQ}
                minFit={minFit}
                onMinFit={setMinFit}
                decided={decided}
                onDecided={setDecided}
                sort={sort}
                onSort={setSort}
                filtered={filtered}
                onClear={clear}
                capped={all.length >= PAGE_CAP}
              />
            )}

            {byHand > 0 && (
              <p className="border-b border-[var(--border)] px-5 py-3 text-xs text-[var(--ink-secondary)]">
                <Badge tone="warning">by hand</Badge>{' '}
                {byHand === 1 ? 'One posting here is' : `${num(byHand)} of these are`}{' '}
                on Workday, where a form cannot be filled for you — it needs an account
                on that employer&apos;s own site and walks through several pages. Saying
                yes still writes you a tailored resume to attach; the typing is yours.
              </p>
            )}

            {shown.length === 0 ? (
              <EmptyState
                icon={Sparkles}
                title={
                  all.length === 0
                    ? 'No search has been run yet'
                    : filtered
                      ? 'Nothing here matches those filters'
                      : `Nothing scored above ${DEFAULT_MIN_SCORE}`
                }
                detail={
                  all.length === 0
                    ? 'Press "Find my matches". It reads the postings already collected for you, so it costs a few pence and takes a couple of minutes.'
                    : filtered
                      ? `${num(all.length)} scored posting${all.length === 1 ? '' : 's'} exist${all.length === 1 ? 's' : ''} — widen the fit, or clear the search.`
                      : 'Everything found was a poor fit. Set the fit filter to “any” to see why each one was turned down.'
                }
                action={
                  all.length === 0 ? (
                    <Button
                      variant="primary"
                      icon={Search}
                      busy={busy || start.isPending}
                      onClick={() => start.mutate()}
                    >
                      Find my matches
                    </Button>
                  ) : filtered ? (
                    <Button icon={X} onClick={clear}>
                      Clear the filters
                    </Button>
                  ) : (
                    <Button onClick={() => setMinFit(0)}>
                      Show every score
                    </Button>
                  )
                }
              />
            ) : (
              <ul>
                {shown.map((row) => (
                  <SuggestionRow
                    key={row.jobId}
                    row={row}
                    busy={
                      decide.isPending && decide.variables?.jobId === row.jobId
                    }
                    onDecide={(decision) =>
                      decide.mutate({ jobId: row.jobId, decision })
                    }
                  />
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
    </>
  );
}

/**
 * The row of filters and the sort.
 *
 * INSIDE the card and above the rows, not in the page header. It describes this one list,
 * and a control that changes a list should sit against it - the header belongs to "Find my
 * matches", which changes what exists rather than what is shown.
 */
function Controls({
  q,
  onQ,
  minFit,
  onMinFit,
  decided,
  onDecided,
  sort,
  onSort,
  filtered,
  onClear,
  capped,
}: {
  q: string;
  onQ: (value: string) => void;
  minFit: number;
  onMinFit: (value: number) => void;
  decided: 'all' | MatchDecision;
  onDecided: (value: 'all' | MatchDecision) => void;
  sort: Sort;
  onSort: (value: Sort) => void;
  filtered: boolean;
  onClear: () => void;
  capped: boolean;
}) {
  return (
    <div className="border-b border-[var(--border)] px-5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search
            size={14}
            aria-hidden
            className="absolute top-1/2 left-3 -translate-y-1/2 text-[var(--ink-muted)]"
          />
          <input
            value={q}
            onChange={(event) => onQ(event.target.value)}
            placeholder="Job title or company…"
            aria-label="Search these matches by job title or company"
            className={`${controlClass} w-52 pl-8`}
          />
        </div>

        <select
          value={sort}
          onChange={(event) => onSort(event.target.value as Sort)}
          aria-label="Order these matches by"
          className={controlClass}
        >
          {SORTS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <select
          value={minFit}
          onChange={(event) => onMinFit(Number(event.target.value))}
          aria-label="Lowest fit score to show"
          className={controlClass}
        >
          {FITS.map((fit) => (
            <option key={fit.value} value={fit.value}>
              {fit.label}
            </option>
          ))}
        </select>

        <select
          value={decided}
          onChange={(event) =>
            onDecided(event.target.value as 'all' | MatchDecision)
          }
          aria-label="Filter by what you decided"
          className={controlClass}
        >
          {DECISIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        {filtered && (
          <Button size="sm" variant="ghost" icon={X} onClick={onClear}>
            Clear
          </Button>
        )}
      </div>

      {capped && sort !== 'fit' && (
        <p className="mt-2 text-xs text-[var(--ink-muted)]">
          This page holds the {PAGE_CAP} best-scoring postings, so this order rearranges
          those {PAGE_CAP} rather than everything ever scored. Run a search to bring the
          newest postings into it.
        </p>
      )}
    </div>
  );
}

/**
 * What the search is doing, or what the last one found.
 *
 * The four numbers are the funnel's own stages, and they are shown rather than summed
 * because they answer different questions: "considered" says whether there are postings
 * at all, and the drop from there to "read by AI" is where a filter that is too tight
 * becomes visible. One total would hide exactly the thing worth seeing.
 */
function RunCard({ status }: { status: MatchRunStatus | undefined }) {
  if (!status || status.state === 'idle') return null;

  if (status.state === 'failed') {
    return (
      <Card>
        <CardHeader
          title="The last search failed"
          subtitle="Nothing was lost. Anything already scored is still in the list below."
        />
        <div className="px-5 py-4">
          <ErrorNote message={status.error ?? 'no reason was recorded'} />
        </div>
      </Card>
    );
  }

  if (status.state === 'queued' || status.state === 'running') {
    return (
      <Card glow>
        <CardHeader
          title={status.state === 'queued' ? 'Waiting to start' : 'Searching now'}
          subtitle={
            status.state === 'queued'
              ? 'Queued. It starts as soon as the worker is free.'
              : 'Reading your postings and asking an AI about the promising ones. This takes a couple of minutes, and it keeps going if you close this page.'
          }
        />
        <div className="px-5 py-4 text-sm text-[var(--ink-secondary)]">
          {status.startedAt
            ? `Started ${relativeTime(status.startedAt)}.`
            : 'Not started yet.'}{' '}
          The list below updates when it finishes.
        </div>
      </Card>
    );
  }

  const counts = status.counts;
  if (!counts) return null;

  return (
    <Card>
      <CardHeader
        title="Your last search"
        subtitle={
          status.finishedAt
            ? `Finished ${relativeTime(status.finishedAt)}`
            : undefined
        }
      />
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-5 py-4 text-sm sm:grid-cols-4">
        <Figure label="Postings looked at" value={counts.considered} />
        <Figure label="Passed the basic filter" value={counts.screened} />
        <Figure label="Close enough to read" value={counts.ranked} />
        <Figure label="Read by the AI" value={counts.scored} />
      </dl>
      {counts.failures > 0 && (
        <p
          className="px-5 pb-4 text-xs"
          style={{ color: 'var(--status-warning)' }}
        >
          {counts.failures} posting(s) could not be read. They are not in the list
          and were not charged for.
        </p>
      )}
    </Card>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-[var(--ink-muted)]">{label}</dt>
      <dd className="figure text-lg font-semibold text-[var(--ink-primary)]">
        {value}
      </dd>
    </div>
  );
}

/** One posting: why it scored what it did, and the yes/no. */
function SuggestionRow({
  row,
  busy,
  onDecide,
}: {
  row: MatchSuggestion;
  busy: boolean;
  onDecide: (decision: MatchDecision) => void;
}) {
  const detail = [
    row.location,
    row.estimatedSalaryLPA === null ? null : `~${row.estimatedSalaryLPA} LPA`,
    row.postedAt ? `posted ${relativeTime(row.postedAt)}` : null,
  ].filter((part): part is string => Boolean(part));

  return (
    <li className="border-b border-[var(--border)] px-5 py-4 last:border-b-0">
      <div className="flex flex-wrap items-start gap-3">
        <span className="figure w-9 shrink-0 pt-0.5 text-right text-sm font-semibold text-[var(--ink-primary)]">
          {row.score}
        </span>

        <span className="min-w-[12rem] flex-1">
          <span className="block text-sm font-medium text-[var(--ink-primary)]">
            {row.title}
          </span>
          <span className="block text-xs text-[var(--ink-muted)]">
            {row.company}
            {detail.length > 0 && ` · ${detail.join(' · ')}`}
          </span>
        </span>

        <Badge tone={VERDICT_TONE[row.verdict] ?? 'neutral'}>
          {row.verdict.toLowerCase()}
        </Badge>

        {/* Marked on the row, not only explained once above it, because the two kinds
            of posting are mixed together in every order this list offers. */}
        {row.applyByHand && <Badge tone="warning">by hand</Badge>}

        <a
          href={row.applyUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border)] px-2 py-1 text-xs text-[var(--ink-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
        >
          Read it
          <ExternalLink size={11} aria-hidden />
        </a>

        {row.decision === 'UNDECIDED' ? (
          <span className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              icon={Check}
              busy={busy}
              onClick={() => onDecide('WANTED')}
            >
              Yes
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon={X}
              busy={busy}
              onClick={() => onDecide('NOT_WANTED')}
            >
              Not for me
            </Button>
          </span>
        ) : (
          <span className="flex items-center gap-2">
            <Badge tone={row.decision === 'WANTED' ? 'good' : 'neutral'}>
              {row.decision === 'WANTED' ? 'Yes' : 'Not for me'}
            </Badge>
            <Button
              size="sm"
              variant="ghost"
              icon={Undo2}
              busy={busy}
              onClick={() => onDecide('UNDECIDED')}
            >
              Undo
            </Button>
          </span>
        )}
      </div>

      {/* The AI's own reasons. Shown on the row rather than behind a click, because a
          score with no explanation is a number to be argued with rather than read. */}
      {row.reasons.length > 0 && (
        <ul className="mt-2 ml-12 space-y-0.5">
          {row.reasons.slice(0, 3).map((reason, index) => (
            <li
              key={index}
              className="text-xs leading-relaxed text-[var(--ink-secondary)]"
            >
              {reason}
            </li>
          ))}
        </ul>
      )}

      {row.missingSkills.length > 0 && (
        <p className="mt-2 ml-12 text-xs text-[var(--ink-muted)]">
          Asks for things your resume does not mention:{' '}
          {row.missingSkills.join(', ')}
        </p>
      )}

      {/* The state of the tailored resume for this posting, when there is one. The
          buttons that create it come next; this says what already exists so a row that
          has been through the safety check does not look untouched. */}
      {row.variant && (
        <p className="mt-2 ml-12 flex items-center gap-1.5 text-xs">
          {row.variant.guardPassed ? (
            <>
              <Check
                size={12}
                aria-hidden
                style={{ color: 'var(--accent-cyan)' }}
              />
              <span className="text-[var(--ink-secondary)]">
                A resume was written for this job {relativeTime(row.variant.createdAt)} and
                passed the honesty check.
              </span>
            </>
          ) : (
            <>
              <FileWarning
                size={12}
                aria-hidden
                style={{ color: 'var(--status-warning)' }}
              />
              <span className="text-[var(--ink-secondary)]">
                A resume was written and thrown away for claiming something your resume
                does not say. Your plain resume would be sent instead.
              </span>
            </>
          )}
        </p>
      )}

      {row.application && (
        <p className="mt-2 ml-12 text-xs text-[var(--ink-secondary)]">
          You have an application for this one —{' '}
          <Link
            href="/app/applications"
            className="text-[var(--accent)] hover:underline"
          >
            {row.application.status.toLowerCase()}
          </Link>
          .
        </p>
      )}
    </li>
  );
}
