'use client';

import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
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
import { api, type CompanyRow } from '@/lib/api';
import { num, TIER_LABEL } from '@/lib/utils';

const TIERS = [
  'T1_GLOBAL_INDIA_OFFICE',
  'T2_FUNDED_INDIAN_STARTUP',
  'T3_INDIAN_MIDMARKET',
  'T4_SERVICES_STAFFING',
  'UNKNOWN',
];

export default function CompaniesPage() {
  const [tier, setTier] = useState('');
  const [q, setQ] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'companies'],
    queryFn: () => api.get<CompanyRow[]>('/api/admin/companies?limit=1000'),
  });

  // Filtered client-side: the whole list is a few hundred rows at most, so a
  // round trip per keystroke would be slower and no more correct.
  const rows = useMemo(() => {
    let list = data ?? [];
    if (tier) list = list.filter((c) => c.tier === tier);
    if (q.trim()) {
      const needle = q.trim().toLowerCase();
      list = list.filter(
        (c) =>
          c.name.toLowerCase().includes(needle) ||
          c.slug.toLowerCase().includes(needle),
      );
    }
    return [...list].sort((a, b) => b._count.postings - a._count.postings);
  }, [data, tier, q]);

  return (
    <>
      <PageHeader
        title="Companies"
        subtitle="The company list is the load-bearing artifact: postings found is a function of boards known, not of connector code."
      />

      <div className="space-y-4 px-4 pb-6 sm:px-6">
        {/* Filters in one row above the content, per the interaction spec. */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search
              size={14}
              aria-hidden
              className="absolute top-1/2 left-3 -translate-y-1/2 text-[var(--ink-muted)]"
            />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name or slug…"
              aria-label="Search companies"
              className={`${controlClass} w-56 pl-8`}
            />
          </div>
          <select
            value={tier}
            onChange={(e) => setTier(e.target.value)}
            aria-label="Filter by tier"
            className={controlClass}
          >
            <option value="">All tiers</option>
            {TIERS.map((t) => (
              <option key={t} value={t}>
                {TIER_LABEL[t]}
              </option>
            ))}
          </select>
          <span className="figure text-xs text-[var(--ink-muted)]">
            {num(rows.length)}{' '}
            <span className="font-sans">of {num(data?.length ?? 0)}</span>
          </span>
        </div>

        {isLoading && <SkeletonCard rows={8} />}
        {error && <ErrorNote message={(error as Error).message} />}

        {/* Zero ROWS is not zero DATA. Left as a bare table this reads as a
            failed load, when the truth is that the filter excluded everything -
            and the filter is the thing to change. */}
        {data && rows.length === 0 && (
          <Card>
            <EmptyState
              icon={Search}
              title="No company matches those filters"
              detail={`${num(data.length)} companies are being watched. Clear the search or pick a different tier.`}
            />
          </Card>
        )}

        {data && rows.length > 0 && (
          <Card>
            <Table
              head={
                <>
                  <Th>Company</Th>
                  <Th>ATS</Th>
                  <Th>Board token</Th>
                  <Th>Tier</Th>
                  <Th numeric>Postings</Th>
                </>
              }
            >
              {rows.map((c) => (
                <Tr key={c.id}>
                  <Td className="font-medium text-[var(--ink-primary)]">
                    {c.name}
                    {c.isAgency && (
                      <span className="ml-2">
                        <Badge>agency</Badge>
                      </span>
                    )}
                    {!c.active && (
                      <span className="ml-2">
                        <Badge tone="warning">paused</Badge>
                      </span>
                    )}
                  </Td>
                  <Td nowrap>{c.atsType.toLowerCase()}</Td>
                  <Td className="font-mono text-xs" nowrap>
                    {c.atsToken ?? '—'}
                  </Td>
                  <Td nowrap>{TIER_LABEL[c.tier] ?? c.tier}</Td>
                  <Td numeric>{num(c._count.postings)}</Td>
                </Tr>
              ))}
            </Table>
          </Card>
        )}
      </div>
    </>
  );
}
