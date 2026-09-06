'use client';

import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { PageHeader } from '@/components/shell';
import {
  Card,
  EmptyState,
  ErrorNote,
  SkeletonCard,
  Table,
  Td,
  Th,
  Tr,
} from '@/components/ui';
import { api, type RunRow } from '@/lib/api';
import { num, relativeTime } from '@/lib/utils';

export default function RunsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'runs'],
    queryFn: () => api.get<RunRow[]>('/api/admin/runs?limit=100'),
  });

  return (
    <>
      <PageHeader
        title="Connector runs"
        subtitle="One row per connector per run. This log is how a silently-dead endpoint becomes visible."
      />
      <div className="px-4 pb-6 sm:px-6">
        {isLoading && <SkeletonCard rows={8} />}
        {error && <ErrorNote message={(error as Error).message} />}
        {data && (
          <Card>
            {data.length === 0 ? (
              <EmptyState
                icon={History}
                title="No runs recorded yet"
                detail="Every discovery run writes a row here, including the ones that fail."
                phase="phase 1"
              />
            ) : (
              <Table
                head={
                  <>
                    <Th>Source</Th>
                    <Th>Started</Th>
                    <Th numeric>Boards tried</Th>
                    <Th numeric>Seen</Th>
                    <Th numeric>New</Th>
                    <Th numeric>Errors</Th>
                  </>
                }
              >
                {data.map((r) => (
                  <Tr key={r.id}>
                    <Td className="font-medium text-[var(--ink-primary)]">
                      {r.source}
                    </Td>
                    <Td nowrap>{relativeTime(r.startedAt)}</Td>
                    <Td numeric>{num(r.companiesTried)}</Td>
                    <Td numeric>{num(r.postingsSeen)}</Td>
                    <Td numeric>{num(r.postingsNew)}</Td>
                    {/* The count itself already says whether anything went wrong;
                        the colour just makes a bad row findable while scrolling. */}
                    <Td
                      numeric
                      className={
                        r.errors > 0
                          ? 'font-semibold text-[var(--status-critical)]'
                          : undefined
                      }
                    >
                      {num(r.errors)}
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
