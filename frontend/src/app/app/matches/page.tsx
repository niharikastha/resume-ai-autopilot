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
  Filter,
  Search,
  Sparkles,
  Undo2,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/shell';
import { useToast } from '@/components/toast';
import {
  Badge,
  Button,
  Card,
  CardHeader,
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
import { relativeTime } from '@/lib/utils';

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
 * want 174 refusals above the eleven things they could actually apply for. The toggle
 * says how many are hidden, so nothing is concealed.
 */
const DEFAULT_MIN_SCORE = 50;

export default function MatchesPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [showAll, setShowAll] = useState(false);

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
    queryFn: () => api.get<MatchSuggestion[]>('/api/me/matches?limit=200'),
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

  const all = suggestions.data ?? [];
  const shown = showAll ? all : all.filter((row) => row.score >= DEFAULT_MIN_SCORE);
  const hidden = all.length - shown.length;

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
                hidden > 0 || showAll ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={Filter}
                    onClick={() => setShowAll((v) => !v)}
                  >
                    {showAll
                      ? 'Hide the poor fits'
                      : `Show ${hidden} poor fit${hidden === 1 ? '' : 's'}`}
                  </Button>
                ) : undefined
              }
            />

            {shown.length === 0 ? (
              <EmptyState
                icon={Sparkles}
                title={
                  all.length === 0
                    ? 'No search has been run yet'
                    : 'Nothing scored above 50'
                }
                detail={
                  all.length === 0
                    ? 'Press "Find my matches". It reads the postings already collected for you, so it costs a few pence and takes a couple of minutes.'
                    : 'Everything found was a poor fit. Show them anyway to see why each one was turned down.'
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
                  ) : undefined
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
