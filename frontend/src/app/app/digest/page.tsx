'use client';

/**
 * The morning digest, and the two buttons it exists for.
 *
 * WHY THIS PAGE AND NOT THE EMAIL. The email carries the same words, but no links that
 * change anything: mail clients, link scanners and corporate gateways fetch every URL in
 * a message before a person sees it, so a one-click "not for me" in an inbox gets pressed
 * by a spam filter. The buttons live behind a session, here.
 *
 * SNAPSHOT FOR THE RECORD, LIVE FOR THE ASKS. The payload is a stored snapshot of one
 * morning - see DigestMatch in lib/api.ts - and the descriptive parts stay that way, so
 * this page and the email that was sent from it never disagree. But anything that ASKS
 * the reader for something is checked against the present: a nag to fill in an answer
 * that was filled in at lunchtime, or a Yes/No on a job already answered elsewhere, is
 * how a person learns to ignore the page. So the answers card and each row's buttons read
 * live state, while the counts and the wording remain the morning's.
 *
 * WHY A DECIDED POSTING STAYS ON THE LIST. Removing a row would make the page disagree
 * with the email. So the answer is shown on the row, with an undo.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  Hourglass,
  Send,
  Sparkles,
  Sun,
  Undo2,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
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
  SkeletonTiles,
  StatTile,
} from '@/components/ui';
import {
  api,
  REQUIRED_ANSWER_LABEL,
  type AnswersView,
  type DigestMatch,
  type DigestRow,
  type DigestSendResult,
  type MatchDecision,
  type MatchSuggestion,
  type MatchSummary,
} from '@/lib/api';
import { dayLabel, relativeTime } from '@/lib/utils';

export default function DigestPage() {
  const toast = useToast();
  const queryClient = useQueryClient();

  /**
   * The answers given on this visit, by job id.
   *
   * Separate from the live decisions below and checked FIRST, because it is the more
   * recent of the two: a press here is newer than anything the last fetch knows.
   */
  const [decided, setDecided] = useState<Record<string, MatchDecision>>({});

  const { data, isLoading, error } = useQuery({
    queryKey: ['me', 'digest'],
    queryFn: () => api.get<DigestRow | null>('/api/me/digest'),
  });

  const history = useQuery({
    queryKey: ['me', 'digests'],
    queryFn: () => api.get<DigestRow[]>('/api/me/digests?limit=14'),
  });

  const unread = useQuery({
    queryKey: ['me', 'digests', 'unread'],
    queryFn: () => api.get<{ count: number }>('/api/me/digests/unread'),
  });

  /** What is actually still blank on the answers form, right now. */
  const answers = useQuery({
    queryKey: ['me', 'answers'],
    queryFn: () => api.get<AnswersView>('/api/me/answers'),
  });

  /** The yes/no already recorded for each posting, right now. Same list the
   *  suggestions page shows, so the two screens cannot contradict each other. */
  const live = useQuery({
    queryKey: ['me', 'matches'],
    queryFn: () => api.get<MatchSuggestion[]>('/api/me/matches?limit=200'),
  });

  /** How many are still waiting, counted server-side. Not summed from `live`, which is
   *  a capped page and would stop growing at 200 without saying so. */
  const summary = useQuery({
    queryKey: ['me', 'matches', 'summary'],
    queryFn: () => api.get<MatchSummary>('/api/me/matches/summary'),
  });

  const decide = useMutation({
    mutationFn: ({ jobId, decision }: { jobId: string; decision: MatchDecision }) =>
      api.patch<void>(`/api/me/jobs/${jobId}/decision`, { decision }),
    onSuccess: (_result, { jobId, decision }) => {
      setDecided((current) => {
        if (decision !== 'UNDECIDED') return { ...current, [jobId]: decision };
        // Undo puts the row back to a question, so the answer is REMOVED rather than
        // stored as "undecided" - a row remembering that it was un-answered would render
        // as answered and offer an undo that does nothing.
        const next = { ...current };
        delete next[jobId];
        return next;
      });
      // The suggestions page reads the same rows, and this is the shared cache key.
      void queryClient.invalidateQueries({ queryKey: ['me', 'matches'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const send = useMutation({
    mutationFn: () => api.post<DigestSendResult>('/api/me/digest/send'),
    onSuccess: (result) => {
      if (result.email === 'sent') toast.success('Emailed to you.');
      // The notes name the setting that is missing, which is the only useful thing to
      // say when nothing was sent. "Failed" on its own sends someone to read logs.
      else toast.info(result.notes[0] ?? 'Built. Nothing was emailed.');
      void queryClient.invalidateQueries({ queryKey: ['me', 'digest'] });
      void queryClient.invalidateQueries({ queryKey: ['me', 'digests'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Marked read once, on the first render that has an unread digest. The ref is what
  // stops React 18's double-invoked effects from sending it twice.
  const marked = useRef<string | null>(null);
  useEffect(() => {
    if (!data || data.readAt || marked.current === data.id) return;
    marked.current = data.id;
    void api.patch<void>(`/api/me/digests/${data.id}/read`).then(
      () => queryClient.invalidateQueries({ queryKey: ['me', 'digests'] }),
      // Silent. Failing to mark it read costs an unread dot, and a toast about it would
      // be noise on a page the reader did not ask anything of.
      () => undefined,
    );
  }, [data, queryClient]);

  if (isLoading) {
    return (
      <div className="space-y-4 px-4 pb-6 sm:px-6">
        <SkeletonTiles count={4} />
        <SkeletonCard rows={6} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <ErrorNote message={(error as Error).message} />
      </div>
    );
  }

  if (!data) {
    return (
      <>
        <PageHeader
          title="This morning"
          subtitle="A summary is built at 9am India time, every day."
        />
        <div className="px-4 pb-6 sm:px-6">
          <Card>
            <EmptyState
              icon={Sun}
              title="No digest yet"
              detail="The first one is built at 9am. You can build today's now if you would rather not wait."
              action={
                <Button
                  variant="primary"
                  icon={Send}
                  busy={send.isPending}
                  onClick={() => send.mutate()}
                >
                  Build today&apos;s now
                </Button>
              }
            />
          </Card>
        </div>
      </>
    );
  }

  const payload = data.payload;

  if (!payload) {
    return (
      <>
        <PageHeader title="This morning" subtitle={dayLabel(data.day)} />
        <div className="px-4 pb-6 sm:px-6">
          <Card>
            <EmptyState
              icon={CircleAlert}
              title="This digest was written by an older version"
              detail="Its numbers cannot be read by this build. Tomorrow's will be fine, or build a fresh one now."
              action={
                <Button icon={Send} busy={send.isPending} onClick={() => send.mutate()}>
                  Build a fresh one
                </Button>
              }
            />
          </Card>
        </div>
      </>
    );
  }

  const c = payload.candidate;

  /**
   * The decision on each posting as of the last fetch. Only real answers are kept:
   * an explicit UNDECIDED belongs out of the map so a row falls back to its buttons.
   */
  const liveDecisions: Record<string, MatchDecision> = {};
  for (const row of live.data ?? []) {
    if (row.decision !== 'UNDECIDED') liveDecisions[row.jobId] = row.decision;
  }
  const decisionFor = (jobId: string): MatchDecision | undefined =>
    decided[jobId] ?? liveDecisions[jobId];

  // The live count, so a morning's work done at lunch does not still read as waiting.
  // The presses made on this visit are subtracted on top, because the server's number is
  // as of the last fetch. Falls back to the snapshot until that fetch lands.
  const answeredHere = Object.keys(decided).filter(
    (jobId) => liveDecisions[jobId] === undefined,
  ).length;
  const left = Math.max(
    0,
    (summary.data?.undecided ?? c.undecided) - answeredHere,
  );

  // The nag, checked against the form as it stands now rather than as it stood at 9am.
  const stillMissing = answers.data?.missing ?? [];

  return (
    <>
      <PageHeader
        title="This morning"
        subtitle={`${dayLabel(payload.day)} · everything below is counted since ${relativeTime(payload.since)}`}
      >
        <Button
          size="sm"
          icon={Send}
          busy={send.isPending}
          onClick={() => send.mutate()}
        >
          Email me a copy
        </Button>
      </PageHeader>

      <div className="space-y-6 px-4 pb-10 sm:px-6">
        {/* THE ASK, above everything. It is the one thing here that can be fixed in two
            minutes, and until it is, every form is submitted with a box empty. Shown
            only once the live answers are known, so a stale nag never flashes up. */}
        {stillMissing.length > 0 && (
          <Card glow>
            <CardHeader
              title={
                stillMissing.length === 1
                  ? 'One answer is still missing'
                  : `${stillMissing.length} answers are still missing`
              }
              subtitle="Application forms ask for these. Until they are filled in, they are left blank."
              action={
                <Link href="/app/profile">
                  <Button size="sm" variant="primary">
                    Fill them in
                  </Button>
                </Link>
              }
            />
            <ul className="flex flex-wrap gap-2 px-5 py-4">
              {stillMissing.map((key) => (
                <li key={key}>
                  <Badge tone="warning">
                    {REQUIRED_ANSWER_LABEL[key] ?? key}
                  </Badge>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <section className="space-y-3">
          <SectionLabel>Since the last digest</SectionLabel>
          <div className="stagger grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="New matches"
              value={c.newMatches}
              hint="scored since the last digest"
              icon={Sparkles}
              emphasis
            />
            <StatTile
              label="Waiting for your yes or no"
              value={left}
              hint={left === 0 ? 'all caught up' : 'the list below'}
              icon={Hourglass}
              tone={left > 0 ? 'accent' : 'default'}
              emphasis
            />
            <StatTile
              label="Forms filled, ready to send"
              value={c.preparedWaiting}
              hint="you press submit, never us"
              icon={Send}
              tone={c.preparedWaiting > 0 ? 'accent' : 'default'}
            />
            <StatTile
              label="Sent"
              value={c.submitted}
              hint="counted only on a confirmation page"
              icon={Check}
            />
          </div>
        </section>

        <section className="space-y-3">
          <SectionLabel>Your decisions</SectionLabel>
          <Card>
            <CardHeader
              title="Do you want these?"
              subtitle="No is the useful answer. It stops a tailored resume being written and a form being opened for a job you would not take."
              action={
                <Link href="/app/matches">
                  <Button size="sm" variant="ghost">
                    See all matches
                  </Button>
                </Link>
              }
            />
            {c.top.length === 0 ? (
              <EmptyState
                icon={Check}
                title="Nothing is waiting for a decision"
                detail="Everything scored so far has been answered, or nothing has been scored yet."
              />
            ) : (
              <ul>
                {c.top.map((match) => (
                  <MatchRow
                    key={match.jobId}
                    match={match}
                    decision={decisionFor(match.jobId)}
                    busy={decide.isPending && decide.variables?.jobId === match.jobId}
                    onDecide={(decision) => decide.mutate({ jobId: match.jobId, decision })}
                  />
                ))}
              </ul>
            )}
          </Card>
        </section>

        {/* Everything past here is a record rather than a request: quieter headings, and
            the board diagnostics folded away. A candidate scrolling for their yes/no
            should not have to walk past a list of dead job boards to reach it. */}
        <section className="space-y-3">
          <SectionLabel>For the record</SectionLabel>

          <Card>
            <dl className="divide-y divide-[var(--border)]">
              {c.tailored > 0 && (
                <Fact label="Resumes written for you">
                  <span className="figure font-semibold text-[var(--ink-primary)]">
                    {c.tailored}
                  </span>{' '}
                  written,{' '}
                  <span className="figure font-semibold text-[var(--ink-primary)]">
                    {c.guardFailed}
                  </span>{' '}
                  thrown away
                  {c.guardFailureRate !== null &&
                    ` (${Math.round(c.guardFailureRate * 100)}%)`}
                  .
                  {c.guardFailed > 0 &&
                    ' A thrown-away one means your plain resume was used instead, so nothing was lost.'}
                </Fact>
              )}

              <Fact label="Where this copy went">
                {data.emailedAt
                  ? `Emailed to you ${relativeTime(data.emailedAt)}.`
                  : 'Not emailed — email settings are not filled in.'}
                {data.telegramAt &&
                  ` Sent to Telegram ${relativeTime(data.telegramAt)}.`}
                {data.deliveryError && (
                  <span style={{ color: 'var(--status-warning)' }}>
                    {' '}
                    {data.deliveryError}
                  </span>
                )}
              </Fact>
            </dl>
          </Card>

          {history.data && history.data.length > 1 && (
            <Card>
              <CardHeader
                title="Earlier mornings"
                subtitle={
                  unread.data && unread.data.count > 0
                    ? `${unread.data.count} you have not opened. Each one covers the time since the one before it, so nothing is counted twice.`
                    : 'Each one covers the time since the one before it, so nothing is counted twice.'
                }
              />
              <ul>
                {history.data.map((row) => (
                  <li
                    key={row.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--border)] px-5 py-3 text-sm last:border-b-0"
                  >
                    <span className="w-40 shrink-0 text-[var(--ink-primary)]">
                      {dayLabel(row.day)}
                    </span>
                    <span className="text-[var(--ink-secondary)]">
                      {row.payload
                        ? `${row.payload.candidate.newMatches} new, ${row.payload.candidate.undecided} to review`
                        : 'from an older version'}
                    </span>
                    {!row.readAt && <Badge tone="accent">unopened</Badge>}
                    <span className="ml-auto text-xs text-[var(--ink-muted)]">
                      {row.emailedAt
                        ? `emailed ${relativeTime(row.emailedAt)}`
                        : 'not emailed'}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {payload.system && <MachineCard system={payload.system} />}
        </section>
      </div>
    </>
  );
}

/** A quiet heading that groups cards, so the page has three parts instead of six peers. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="px-1 text-[11px] font-semibold tracking-[0.08em] text-[var(--ink-muted)] uppercase">
      {children}
    </h2>
  );
}

/** One label-and-sentence row inside a record card. */
function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="px-5 py-4 sm:flex sm:gap-6">
      <dt className="shrink-0 text-xs text-[var(--ink-muted)] sm:w-48 sm:pt-0.5">
        {label}
      </dt>
      <dd className="mt-1 text-sm leading-relaxed text-[var(--ink-secondary)] sm:mt-0">
        {children}
      </dd>
    </div>
  );
}

/**
 * The admin-only section about the job boards themselves.
 *
 * Folded shut. It is diagnostics about the machine, not about this person's search, and
 * an unread wall of board errors above the yes/no buttons is what made the page feel
 * like a log file. A dead board still shows its count on the closed summary, so nothing
 * urgent is hidden behind the click.
 */
function MachineCard({
  system,
}: {
  system: NonNullable<
    NonNullable<DigestRow['payload']>['system']
  >;
}) {
  const dead = system.deadBoards.length;

  return (
    <Card>
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-4 text-sm">
          <ChevronDown
            size={14}
            aria-hidden
            className="shrink-0 text-[var(--ink-muted)] transition-transform group-open:rotate-180"
          />
          <span className="font-medium text-[var(--ink-primary)]">
            The job boards
          </span>
          <span className="text-xs text-[var(--ink-muted)]">
            only you see this — it is about the machine, not your search
          </span>
          {dead > 0 && (
            <Badge tone="warning">
              {dead} not responding
            </Badge>
          )}
        </summary>

        <div className="space-y-3 border-t border-[var(--border)] px-5 py-4 text-sm">
          <p className="text-[var(--ink-secondary)]">
            {system.newCompanies} new company(ies), {system.newPostings} new
            posting(s). Last fetch{' '}
            {system.lastDiscoveryAt
              ? relativeTime(system.lastDiscoveryAt)
              : 'never'}
            .
          </p>
          {dead > 0 && (
            <ul className="space-y-1">
              {system.deadBoards.map((board) => (
                <li key={board.source} className="flex items-start gap-2 text-xs">
                  <CircleAlert
                    size={14}
                    aria-hidden
                    className="mt-px shrink-0"
                    style={{ color: 'var(--status-warning)' }}
                  />
                  <span className="text-[var(--ink-secondary)]">
                    <strong className="text-[var(--ink-primary)]">
                      {board.source}
                    </strong>{' '}
                    — {board.reason}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {system.modelUse.length > 0 && (
            <p className="text-xs text-[var(--ink-muted)]">
              {/* Calls and not tokens, because token counts are logged per call and
                  never stored. Labelling these as spend would be a made-up number. */}
              AI calls:{' '}
              {system.modelUse.map((use) => `${use.calls} × ${use.model}`).join(', ')}
            </p>
          )}
        </div>
      </details>
    </Card>
  );
}

/**
 * One posting, with the two buttons and the answer once it has been given.
 *
 * A GRID, not a wrapping row. The old flex layout let the title, the link and both
 * buttons all wrap independently, so at tablet width the buttons ended up under the
 * score with the link stranded mid-line. Here the score and the title share the first
 * line and the controls are one block that moves as a unit.
 */
function MatchRow({
  match,
  decision,
  busy,
  onDecide,
}: {
  match: DigestMatch;
  decision: MatchDecision | undefined;
  busy: boolean;
  onDecide: (decision: MatchDecision) => void;
}) {
  const detail = [
    match.location,
    match.salaryLpa === null ? null : `~${match.salaryLpa} LPA`,
  ].filter((part): part is string => Boolean(part));

  return (
    <li className="border-b border-[var(--border)] px-5 py-4 last:border-b-0">
      <div className="flex items-start gap-4">
        <span className="figure w-9 shrink-0 pt-0.5 text-right text-sm font-semibold text-[var(--ink-primary)]">
          {match.score}
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-[var(--ink-primary)]">
            {match.title}
          </p>
          <p className="truncate text-xs text-[var(--ink-muted)]">
            {match.company}
            {detail.length > 0 && ` · ${detail.join(' · ')}`}
          </p>
        </div>

        {/* One block, right-aligned, so it never breaks apart across lines. */}
        <div className="flex shrink-0 items-center gap-2">
          <a
            href={match.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border)] px-2 py-1.5 text-xs text-[var(--ink-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            Read it
            <ExternalLink size={11} aria-hidden />
          </a>

          {decision === undefined ? (
            <>
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
                No
              </Button>
            </>
          ) : (
            <>
              <Badge tone={decision === 'WANTED' ? 'good' : 'neutral'}>
                {decision === 'WANTED' ? 'Yes' : 'Not for me'}
              </Badge>
              {/* Undo, because this is the one control on the page that changes what the
                  system will spend money on, and it is two taps away from a mis-tap. */}
              <Button
                size="sm"
                variant="ghost"
                icon={Undo2}
                busy={busy}
                onClick={() => onDecide('UNDECIDED')}
              >
                Undo
              </Button>
            </>
          )}
        </div>
      </div>
    </li>
  );
}
