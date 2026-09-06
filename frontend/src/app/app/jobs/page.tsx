'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ExternalLink, Search } from 'lucide-react';
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
  Table,
  Td,
  Th,
  Tr,
} from '@/components/ui';
import { api, type JobRow } from '@/lib/api';
import { num, REMOTE_LABEL, relativeTime, salaryText, TIER_LABEL } from '@/lib/utils';

const PAGE = 50;

const TIERS = [
  'T1_GLOBAL_INDIA_OFFICE',
  'T2_FUNDED_INDIAN_STARTUP',
  'T3_INDIAN_MIDMARKET',
  'T4_SERVICES_STAFFING',
];

export default function JobsPage() {
  const [q, setQ] = useState('');
  const [tier, setTier] = useState('');
  const [page, setPage] = useState(0);

  const params = new URLSearchParams({
    limit: String(PAGE),
    offset: String(page * PAGE),
  });
  if (q.trim()) params.set('q', q.trim());
  if (tier) params.set('tier', tier);

  const { data, isLoading, error } = useQuery({
    queryKey: ['me', 'jobs', q, tier, page],
    queryFn: () =>
      api.get<{ total: number; items: JobRow[] }>(
        `/api/me/jobs?${params.toString()}`,
      ),
    placeholderData: keepPreviousData,
  });

  const total = data?.total ?? 0;
  const lastPage = Math.max(0, Math.ceil(total / PAGE) - 1);

  return (
    <>
      <PageHeader
        title="Jobs"
        subtitle="Every posting discovery has found. Your own match score is attached once scoring runs."
      />

      <div className="space-y-4 px-4 pb-6 sm:px-6">
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
              placeholder="Search title…"
              aria-label="Search job titles"
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
          <span className="figure text-xs text-[var(--ink-muted)]">
            {num(total)} <span className="font-sans">postings</span>
          </span>
        </div>

        {isLoading && !data && <SkeletonCard rows={10} />}
        {error && <ErrorNote message={(error as Error).message} />}

        {data && data.items.length === 0 && (
          <Card>
            <EmptyState
              icon={Search}
              title="No posting matches those filters"
              detail="Try a broader title, or clear the tier filter."
            />
          </Card>
        )}

        {data && data.items.length > 0 && (
          <>
            {/* Dimmed while a new page is in flight. keepPreviousData means the old
                rows stay on screen, which is right - but with no cue at all a slow
                page looks like a click that did nothing. */}
            <Card className={isLoading ? 'opacity-60 transition-opacity' : undefined}>
              <Table
                head={
                  <>
                    <Th>Role</Th>
                    <Th nowrap>Company</Th>
                    <Th>Location</Th>
                    <Th nowrap>Pay</Th>
                    <Th numeric nowrap>
                      Your score
                    </Th>
                    <Th nowrap>Found</Th>
                    <Th> </Th>
                  </>
                }
              >
                {data.items.map((job) => {
                  const score = job.matchScores[0];
                  return (
                    <Tr key={job.id}>
                      <Td className="font-medium text-[var(--ink-primary)]">
                        {job.title}
                        {job.seniority && (
                          <span className="ml-2">
                            <Badge>{job.seniority}</Badge>
                          </span>
                        )}
                      </Td>
                      <Td nowrap>
                        {job.company?.name ?? '—'}
                        {job.company && (
                          <span className="ml-1.5 text-xs text-[var(--ink-muted)]">
                            {TIER_LABEL[job.company.tier]?.split(' · ')[0]}
                          </span>
                        )}
                      </Td>
                      <Td>
                        {job.location || '—'}
                        {/* Only when we actually know. Rendering the UNKNOWN
                            label put "Unknown" next to a perfectly good
                            location on most rows, which reads as though the
                            LOCATION were unknown rather than the remote
                            policy. Silence is the honest encoding for absent. */}
                        {job.remoteType !== 'UNKNOWN' && (
                          <span className="ml-1.5 text-xs text-[var(--ink-muted)]">
                            {REMOTE_LABEL[job.remoteType]}
                          </span>
                        )}
                      </Td>
                      <Td nowrap className="text-xs">
                        {salaryText(job)}
                      </Td>
                      <Td numeric nowrap>
                        {score ? (
                          `${score.score}`
                        ) : (
                          <span
                            className="text-[var(--ink-muted)]"
                            title="Scoring arrives in phase 4"
                          >
                            —
                          </span>
                        )}
                      </Td>
                      <Td nowrap>{relativeTime(job.postedAt ?? job.firstSeenAt)}</Td>
                      <Td nowrap>
                        {/* A manual link, deliberately. Nothing here is ever
                            submitted for you - opening the real posting is the
                            whole action. */}
                        <a
                          href={job.applyUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border)] px-2 py-1 text-xs text-[var(--ink-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
                        >
                          Open
                          <ExternalLink size={11} aria-hidden />
                        </a>
                      </Td>
                    </Tr>
                  );
                })}
              </Table>
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
