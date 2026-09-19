'use client';

import { useQuery } from '@tanstack/react-query';
import { Briefcase, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/shell';
import {
  Badge,
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
import { api, type ApplicationRow } from '@/lib/api';
import { pct, relativeTime, STATUS_LABEL, TIER_LABEL } from '@/lib/utils';

const STATUSES = [
  'AWAITING_REVIEW',
  'APPROVED',
  'PREPARED',
  'SUBMITTED',
  'REJECTED',
  'FAILED',
  'SKIPPED',
  'QUEUED',
];

export default function ApplicationsPage() {
  const [status, setStatus] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['me', 'applications', status],
    queryFn: () =>
      api.get<ApplicationRow[]>(
        `/api/me/applications${status ? `?status=${status}` : ''}`,
      ),
  });

  return (
    <>
      <PageHeader
        title="Applications"
        // Says "most" rather than "forms are filled for you", because Workday is not
        // filled at all and a promise this page cannot keep is worse than a caveat.
        subtitle="Most forms are filled for you up to the submit button; the ones marked “by hand” are not. The last click is always yours — nothing is ever sent automatically."
      />

      <div className="space-y-4 px-4 pb-6 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            aria-label="Filter by state"
            className={controlClass}
          >
            <option value="">All states</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>

        {isLoading && <SkeletonCard rows={8} />}
        {error && <ErrorNote message={(error as Error).message} />}

        {data && (
          <Card>
            {data.length === 0 ? (
              <EmptyState
                icon={Briefcase}
                title="No applications yet"
                // No `phase` chip on top of this: the detail already names phase
                // 6, and the badge would say it a second time.
                detail="Assisted apply arrives in phase 6 — until then this stays empty, which is expected rather than broken."
              />
            ) : (
              <Table
                head={
                  <>
                    <Th>Role</Th>
                    <Th>Company</Th>
                    <Th>State</Th>
                    <Th numeric>Form filled</Th>
                    <Th>Updated</Th>
                    <Th> </Th>
                  </>
                }
              >
                {data.map((a) => (
                  <Tr key={a.id}>
                    <Td className="font-medium text-[var(--ink-primary)]">
                      {a.job.title}
                    </Td>
                    <Td>
                      {a.company.name}
                      <span className="ml-1.5 text-xs text-[var(--ink-muted)]">
                        {TIER_LABEL[a.company.tier]?.split(' · ')[0]}
                      </span>
                    </Td>
                    <Td nowrap>{STATUS_LABEL[a.status] ?? a.status}</Td>
                    {/* "by hand" beats both a percentage and a dash here. A Workday
                        row is stored with no coverage because none was measured, and
                        rows prepared before that was true are stored 1 - so a plain
                        percentage would show 100% on a form nobody typed into. */}
                    <Td numeric>
                      {a.job.applyByHand ? (
                        <Badge tone="warning">by hand</Badge>
                      ) : (
                        pct(a.prefillCoverage)
                      )}
                    </Td>
                    <Td nowrap>{relativeTime(a.updatedAt)}</Td>
                    <Td nowrap>
                      <a
                        href={a.job.applyUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border)] px-2 py-1 text-xs text-[var(--ink-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
                      >
                        Open form
                        <ExternalLink size={11} aria-hidden />
                      </a>
                    </Td>
                  </Tr>
                ))}
              </Table>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
