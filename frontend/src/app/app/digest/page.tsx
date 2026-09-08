'use client';

/**
 * The morning digest, and the two buttons it exists for.
 *
 * WHY THIS PAGE AND NOT THE EMAIL. The email carries the same words, but no links that
 * change anything: mail clients, link scanners and corporate gateways fetch every URL in
 * a message before a person sees it, so a one-click "not for me" in an inbox gets pressed
 * by a spam filter. The buttons live behind a session, here.
 *
 * WHY A DECIDED POSTING STAYS ON THE LIST. The digest is a stored snapshot of one
 * morning, not a live query - see DigestMatch in lib/api.ts. Removing a row would make
 * the page disagree with the email that was sent from the same payload. So the answer is
 * shown on the row, with an undo, and the count at the top is the one that moves.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  CircleAlert,
  ExternalLink,
  Hourglass,
  Mail,
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
  type DigestMatch,
  type DigestRow,
  type DigestSendResult,
  type MatchDecision,
} from '@/lib/api';
import { relativeTime } from '@/lib/utils';

export default function DigestPage() {
  const toast = useToast();
  const queryClient = useQueryClient();

  /**
   * The answers given on this visit, by job id.
   *
   * Local because the payload is a snapshot. It is not a cache of the server's state -
   * it is "what I have just said", which is exactly what the row needs to show.
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
        <PageHeader title="This morning" subtitle={data.day} />
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
  const answered = Object.keys(decided).length;
  const left = Math.max(0, c.undecided - answered);

  return (
    <>
      <PageHeader
        title="This morning"
        subtitle={`${payload.day} · counted since ${relativeTime(payload.since)}`}
      />

      <div className="space-y-5 px-4 pb-6 sm:px-6">
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
            hint={answered > 0 ? `${answered} answered just now` : 'this is the list below'}
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
            label="Sent since the last digest"
            value={c.submitted}
            hint="counted only on a confirmation page"
            icon={Check}
          />
        </div>

        {/* Above the job list, deliberately: it is the one thing here that can be fixed
            in two minutes, and until it is, every form is submitted with a box empty. */}
        {c.missingAnswers.length > 0 && (
          <Card glow>
            <CardHeader
              title="Your forms are missing some answers"
              subtitle="Application forms ask for these. Until they are filled in, they are left blank."
            />
            <div className="flex flex-wrap items-center gap-2 px-5 py-4">
              {c.missingAnswers.map((answer) => (
                <Badge key={answer} tone="warning">
                  {answer}
                </Badge>
              ))}
              <Link href="/app/profile" className="ml-auto">
                <Button size="sm">Fill them in</Button>
              </Link>
            </div>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Do you want these?"
            subtitle="No is the useful answer. It stops a tailored resume being written and a form being opened for a job you would not take."
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
                  decision={decided[match.jobId]}
                  busy={decide.isPending && decide.variables?.jobId === match.jobId}
                  onDecide={(decision) => decide.mutate({ jobId: match.jobId, decision })}
                />
              ))}
            </ul>
          )}
        </Card>

        {c.tailored > 0 && (
          <Card>
            <CardHeader
              title="Resumes written for you"
              subtitle="Each one is checked against your own resume before it is used. A rewrite that claims something your resume does not is thrown away."
            />
            <div className="px-5 py-4 text-sm text-[var(--ink-secondary)]">
              <span className="figure font-semibold text-[var(--ink-primary)]">
                {c.tailored}
              </span>{' '}
              written,{' '}
              <span className="figure font-semibold text-[var(--ink-primary)]">
                {c.guardFailed}
              </span>{' '}
              thrown away
              {c.guardFailureRate !== null && ` (${Math.round(c.guardFailureRate * 100)}%)`}.
              {c.guardFailed > 0 &&
                ' A thrown-away one means your plain resume was used instead, so nothing was lost.'}
            </div>
          </Card>
        )}

        {payload.system && (
          <Card>
            <CardHeader
              title="The machine"
              subtitle="Only you see this section. It is about the job boards, not about your search."
            />
            <div className="space-y-3 px-5 py-4 text-sm">
              <p className="text-[var(--ink-secondary)]">
                {payload.system.newCompanies} new company(ies),{' '}
                {payload.system.newPostings} new posting(s). Last fetch{' '}
                {payload.system.lastDiscoveryAt
                  ? relativeTime(payload.system.lastDiscoveryAt)
                  : 'never'}
                .
              </p>
              {payload.system.deadBoards.length > 0 && (
                <ul className="space-y-1">
                  {payload.system.deadBoards.map((dead) => (
                    <li key={dead.source} className="flex items-start gap-2 text-xs">
                      <CircleAlert
                        size={14}
                        aria-hidden
                        className="mt-px shrink-0"
                        style={{ color: 'var(--status-warning)' }}
                      />
                      <span className="text-[var(--ink-secondary)]">
                        <strong className="text-[var(--ink-primary)]">
                          {dead.source}
                        </strong>{' '}
                        — {dead.reason}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {payload.system.modelUse.length > 0 && (
                <p className="text-xs text-[var(--ink-muted)]">
                  {/* Calls and not tokens, because token counts are logged per call and
                      never stored. Labelling these as spend would be a made-up number. */}
                  AI calls:{' '}
                  {payload.system.modelUse
                    .map((use) => `${use.calls} × ${use.model}`)
                    .join(', ')}
                </p>
              )}
            </div>
          </Card>
        )}

        <Card>
          <CardHeader title="Where this went" subtitle="The copy on this page is the original. The rest are copies of it." />
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4 text-sm text-[var(--ink-secondary)]">
            <span className="inline-flex items-center gap-2">
              <Mail size={14} aria-hidden className="text-[var(--ink-muted)]" />
              {data.emailedAt
                ? `Emailed ${relativeTime(data.emailedAt)}`
                : 'Not emailed — email settings are not filled in'}
            </span>
            {data.telegramAt && <span>Sent to Telegram {relativeTime(data.telegramAt)}</span>}
            {data.deliveryError && (
              <span style={{ color: 'var(--status-warning)' }}>{data.deliveryError}</span>
            )}
            <Button
              size="sm"
              icon={Send}
              busy={send.isPending}
              onClick={() => send.mutate()}
              className="ml-auto"
            >
              Send me a copy
            </Button>
          </div>
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
                  className="flex items-center gap-3 border-b border-[var(--border)] px-5 py-3 text-sm last:border-b-0"
                >
                  <span className="figure w-24 text-[var(--ink-primary)]">{row.day}</span>
                  <span className="text-[var(--ink-secondary)]">
                    {row.payload
                      ? `${row.payload.candidate.newMatches} new, ${row.payload.candidate.undecided} to review`
                      : 'from an older version'}
                  </span>
                  {!row.readAt && <Badge tone="accent">unopened</Badge>}
                  <span className="ml-auto text-xs text-[var(--ink-muted)]">
                    {row.emailedAt ? `emailed ${relativeTime(row.emailedAt)}` : 'not emailed'}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}

/** One posting, with the two buttons and the answer once it has been given. */
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
    <li className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] px-5 py-3 last:border-b-0">
      <span className="figure w-9 shrink-0 text-right text-sm font-semibold text-[var(--ink-primary)]">
        {match.score}
      </span>

      <span className="min-w-[12rem] flex-1">
        <span className="block text-sm font-medium text-[var(--ink-primary)]">
          {match.title}
        </span>
        <span className="block text-xs text-[var(--ink-muted)]">
          {match.company}
          {detail.length > 0 && ` · ${detail.join(' · ')}`}
        </span>
      </span>

      <a
        href={match.url}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border)] px-2 py-1 text-xs text-[var(--ink-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
      >
        Read it
        <ExternalLink size={11} aria-hidden />
      </a>

      {decision === undefined ? (
        <span className="flex gap-2">
          <Button size="sm" variant="primary" icon={Check} busy={busy} onClick={() => onDecide('WANTED')}>
            Yes
          </Button>
          <Button size="sm" variant="danger" icon={X} busy={busy} onClick={() => onDecide('NOT_WANTED')}>
            Not for me
          </Button>
        </span>
      ) : (
        <span className="flex items-center gap-2">
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
        </span>
      )}
    </li>
  );
}
