'use client';

import { useQuery } from '@tanstack/react-query';
import { Activity, Database, Inbox, Sparkles, Target } from 'lucide-react';
import { FunnelChart, ScoreHistogram } from '@/components/charts';
import { PageHeader } from '@/components/shell';
import {
  Card,
  CardHeader,
  ErrorNote,
  SkeletonDashboard,
  StatTile,
  StatusBadge,
  Table,
  Td,
  Th,
  Tr,
} from '@/components/ui';
import { api, type AdminOverview } from '@/lib/api';
import { num, relativeTime, STATUS_LABEL } from '@/lib/utils';

export default function AdminOverviewPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => api.get<AdminOverview>('/api/admin/overview'),
  });

  // A skeleton rather than a spinner: this layout is known before the data
  // arrives, so the page can hold its shape instead of jumping.
  if (isLoading) return <SkeletonDashboard />;
  if (error)
    return (
      <div className="p-6">
        <ErrorNote message={(error as Error).message} />
      </div>
    );
  if (!data) return null;

  const { kpis, funnel, sourceHealth, scoreDistribution, applications, lastRun } =
    data;
  const appRows = Object.entries(applications).sort((a, b) => b[1] - a[1]);

  return (
    <>
      <PageHeader
        title="Pipeline"
        subtitle="Everything the machine has found and done, across all accounts."
      >
        <span className="inline-flex items-center gap-1.5 rounded-[var(--r-full)] border border-[var(--border)] bg-[var(--surface-raised)] px-2.5 py-1 text-xs text-[var(--ink-muted)]">
          <Activity size={12} aria-hidden />
          last discovery run {relativeTime(lastRun?.startedAt)}
        </span>
      </PageHeader>

      <div className="space-y-5 px-4 pb-6 sm:px-6">
        <div className="stagger grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Postings held"
            value={kpis.postings}
            hint={`from ${num(kpis.activeCompanies)} active boards`}
            icon={Database}
            emphasis
          />
          <StatTile
            label="Actually addressable"
            value={kpis.addressable}
            hint="India · engineering · at your level"
            icon={Target}
            emphasis
          />
          <StatTile
            label="Scored"
            value={kpis.scored}
            hint={kpis.scored === 0 ? 'awaits phase 4' : 'across all accounts'}
            icon={Sparkles}
          />
          <StatTile
            label="Awaiting review"
            value={kpis.awaitingReview}
            hint={kpis.awaitingReview === 0 ? 'awaits phase 6' : 'needs a human'}
            icon={Inbox}
            // Accent only when there is genuinely something to do. A tile that is
            // always highlighted stops meaning anything.
            tone={kpis.awaitingReview > 0 ? 'accent' : 'default'}
          />
        </div>

        <FunnelChart
          stages={funnel}
          title="Discovery funnel"
          subtitle="Where the postings go. The drop from everything discovered to what is actually applicable is roughly two orders of magnitude — that is the real shape of the problem, not a bug."
        />

        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader
              title="Connector health"
              subtitle="A connector that quietly starts returning nothing is the main failure mode of depending on undocumented endpoints."
            />
            {sourceHealth.length === 0 ? (
              <div className="px-5 py-8 text-sm text-[var(--ink-muted)]">
                No connector has run yet.
              </div>
            ) : (
              <Table
                head={
                  <>
                    <Th>Source</Th>
                    <Th>Status</Th>
                    <Th numeric>Boards</Th>
                    <Th numeric>Postings</Th>
                    <Th>Last run</Th>
                  </>
                }
              >
                {sourceHealth.map((s) => (
                  <Tr key={s.source}>
                    <Td className="font-medium text-[var(--ink-primary)]">
                      {s.source}
                    </Td>
                    <Td>
                      <StatusBadge status={s.status} />
                    </Td>
                    <Td numeric>{num(s.boards)}</Td>
                    <Td numeric>{num(s.postings)}</Td>
                    <Td nowrap>{relativeTime(s.lastRun)}</Td>
                  </Tr>
                ))}
              </Table>
            )}
          </Card>

          <ScoreHistogram bins={scoreDistribution} />
        </div>

        <Card>
          <CardHeader
            title="Applications by state"
            subtitle="Submitted is recorded only on a detected confirmation, never optimistically."
          />
          {appRows.length === 0 ? (
            <div className="px-5 py-8 text-sm text-[var(--ink-muted)]">
              No applications yet — the assisted-apply stage arrives in phase 6.
            </div>
          ) : (
            <Table
              head={
                <>
                  <Th>State</Th>
                  <Th numeric>Count</Th>
                </>
              }
            >
              {appRows.map(([status, count]) => (
                <Tr key={status}>
                  <Td className="text-[var(--ink-primary)]">
                    {STATUS_LABEL[status] ?? status}
                  </Td>
                  <Td numeric>{num(count)}</Td>
                </Tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
