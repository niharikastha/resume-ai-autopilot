'use client';

import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  CircleAlert,
  Flame,
  Hourglass,
  Send,
  Sparkles,
} from 'lucide-react';
import Link from 'next/link';
import { FunnelChart } from '@/components/charts';
import { PageHeader } from '@/components/shell';
import {
  Card,
  CardHeader,
  ErrorNote,
  SkeletonDashboard,
  StatTile,
  Table,
  Td,
  Th,
  Tr,
} from '@/components/ui';
import { api, type UserOverview } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { relativeTime, STATUS_LABEL, TIER_LABEL } from '@/lib/utils';

export default function CandidateOverviewPage() {
  const { user } = useAuth();
  const { data, isLoading, error } = useQuery({
    queryKey: ['me', 'overview'],
    queryFn: () => api.get<UserOverview>('/api/me/overview'),
  });

  if (isLoading) return <SkeletonDashboard />;
  if (error)
    return (
      <div className="p-6">
        <ErrorNote message={(error as Error).message} />
      </div>
    );
  if (!data) return null;

  const { kpis, funnel, blockers, recent } = data;

  return (
    <>
      <PageHeader
        title={`Your job search`}
        subtitle={
          user
            ? `Signed in as ${user.name}. Only your own matches and applications appear here.`
            : undefined
        }
      />

      <div className="space-y-5 px-4 pb-6 sm:px-6">
        {/* Blockers first: an empty dashboard because a step is outstanding is a
            different thing from an empty dashboard because nothing matched, and
            the candidate should not have to work out which. */}
        {blockers.length > 0 && (
          <Card glow>
            <CardHeader
              title="Before anything can run"
              subtitle="These are yours to fill in — the system will not guess them for you."
            />
            <ul>
              {blockers.map((b) => (
                <li
                  key={b.key}
                  className="flex items-center gap-3 border-b border-[var(--border)] px-5 py-3 last:border-b-0"
                >
                  <CircleAlert
                    size={16}
                    className="shrink-0"
                    style={{ color: 'var(--status-warning)' }}
                    aria-hidden
                  />
                  <span className="flex-1 text-sm text-[var(--ink-primary)]">
                    {b.label}
                  </span>
                  <span className="text-xs text-[var(--ink-muted)]">
                    {b.phase}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <div className="stagger grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Jobs scored for you"
            value={kpis.scored}
            hint={kpis.scored === 0 ? 'starts once your resume is confirmed' : undefined}
            icon={Sparkles}
            emphasis
          />
          <StatTile
            label="Strong matches"
            value={kpis.strongMatches}
            hint="scored good or better"
            icon={Flame}
            emphasis
          />
          <StatTile
            label="Waiting on you"
            value={kpis.awaitingReview + kpis.prepared}
            hint="review, then submit yourself"
            icon={Hourglass}
            // The one number on this page that is a to-do rather than a fact.
            tone={kpis.awaitingReview + kpis.prepared > 0 ? 'accent' : 'default'}
          />
          <StatTile
            label="Submitted"
            value={kpis.submitted}
            hint="counted only on a confirmation page"
            icon={Send}
          />
        </div>

        <FunnelChart
          stages={funnel}
          title="Your progress"
          subtitle="From scored, to tailored, to a form filled and waiting for your final click."
        />

        <Card>
          <CardHeader
            title="Recent activity"
            action={
              <Link
                href="/app/applications"
                className="group inline-flex items-center gap-1 rounded-[var(--r-sm)] px-2 py-1 text-xs font-medium text-[var(--link)] transition-colors hover:bg-[var(--surface-hover)]"
              >
                All applications
                <ArrowRight
                  size={12}
                  aria-hidden
                  className="transition-transform group-hover:translate-x-0.5"
                />
              </Link>
            }
          />
          {recent.length === 0 ? (
            <div className="px-5 py-10 text-sm text-[var(--ink-muted)]">
              Nothing yet. Once your resume is confirmed, matching runs every
              morning and anything worth applying to shows up here.
            </div>
          ) : (
            <Table
              head={
                <>
                  <Th>Role</Th>
                  <Th>Company</Th>
                  <Th>State</Th>
                  <Th>Updated</Th>
                </>
              }
            >
              {recent.map((a) => (
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
                  <Td nowrap>{relativeTime(a.updatedAt)}</Td>
                </Tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
