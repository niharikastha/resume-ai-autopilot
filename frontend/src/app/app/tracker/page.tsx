'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, Users } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/shell';
import { Badge, ErrorNote, SkeletonCard } from '@/components/ui';
import { api, type TrackerView } from '@/lib/api';
import { cn } from '@/lib/utils';
import { TrackedApplicationsTab } from './applications';
import { PeopleTab } from './people';

type Tab = 'applications' | 'people';

/**
 * The tracker: what you applied to yourself, and who could refer you.
 *
 * WHY THIS IS A SECOND SCREEN AND NOT MORE COLUMNS ON /app/applications. That screen is the
 * pipeline's record - every row there began as a posting this system crawled and scored, and
 * its states ("Form filled", "Awaiting review") are states of a job the machine is running.
 * Nothing on this screen was discovered by anything. The job came off a friend's forward or
 * the company's own site, the stages are what an employer told you, and every field was
 * typed. Mixing them would produce one list where "Applied" sometimes means a person acted
 * and sometimes means a browser did, which is the distinction most worth not losing.
 *
 * TWO TABS RATHER THAN TWO ROUTES, because the referrer field on an application is a person
 * from the other tab: they are one screen used in two directions, and a route change between
 * them would lose the list you were half way through reading. One query feeds both, so the
 * picker on the left can never disagree with the list on the right.
 *
 * TAB STATE IS NOT IN THE URL. It is a view of the same data rather than a place, so there
 * is nothing here worth linking to or restoring - and `useSearchParams` would put this page
 * behind a Suspense boundary for a toggle.
 */
export default function TrackerPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('applications');

  /**
   * The person whose applications are being shown, set by clicking their count on the People
   * tab. Lives here rather than in either tab because it is the one piece of state the two
   * share: it is written on one side and read on the other.
   *
   * The count is worth following rather than just reading. "Priya: 3 referrals" answers how
   * often you have leaned on her but not whether any of it went anywhere - and that is the
   * question you actually have before asking a fourth time. The three rows say it: two
   * rejections and a no-answer is a different situation from two interviews.
   */
  const [focusPerson, setFocusPerson] = useState<string | null>(null);

  const tracker = useQuery({
    queryKey: ['me', 'tracker'],
    queryFn: () => api.get<TrackerView>('/api/me/tracker'),
  });

  /**
   * Every write returns the whole view, so the response IS the new cache.
   *
   * Written straight in rather than refetched, for the reason BlockedCompaniesCard gives: a
   * second round trip is a second chance for the counts on this page to disagree with the
   * list beside them. The tabs pass this up because both of them write, and a tab holding
   * its own copy would leave the other one stale until it was re-mounted.
   */
  const onSettled = (next: TrackerView) => {
    qc.setQueryData(['me', 'tracker'], next);
  };

  const view = tracker.data;

  const tabs: { key: Tab; label: string; icon: typeof Users; count?: number }[] = [
    {
      key: 'applications',
      label: 'Applications',
      icon: ClipboardList,
      count: view?.applications.length,
    },
    {
      key: 'people',
      label: 'People',
      icon: Users,
      count: view?.contacts.length,
    },
  ];

  return (
    <>
      <PageHeader
        title="My tracker"
        subtitle="Applications you made yourself, and the people who might put a word in. Nothing on this screen is filled in, sent or scored — it is a notebook, and everything in it is what you typed."
      />

      <div className="space-y-4 px-4 pb-6 sm:px-6">
        {/*
          A segmented control, not an ARIA tablist. The panels are two independent lists that
          each own their own state rather than one region whose contents swap, so `aria-pressed`
          on a pair of buttons describes what is actually happening - a full tablist would
          promise arrow-key navigation between panels that these do not implement.
        */}
        <div
          role="group"
          aria-label="Tracker sections"
          className="inline-flex gap-1 rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--surface-raised)] p-1"
        >
          {tabs.map(({ key, label, icon: Icon, count }) => (
            <button
              key={key}
              type="button"
              aria-pressed={tab === key}
              // Clicking a tab here drops the person filter. This control means "show me
              // this section", and a section that silently kept showing three of forty rows
              // because of a click made two minutes ago on the other tab is the kind of
              // filter people conclude their data is missing from.
              onClick={() => {
                setTab(key);
                setFocusPerson(null);
              }}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-[var(--r-sm)] px-3 py-1.5 text-[13px] font-medium transition-colors',
                tab === key
                  ? 'bg-[var(--accent)] text-[var(--accent-ink)]'
                  : 'text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)]',
              )}
            >
              <Icon size={14} aria-hidden />
              {label}
              {/* Only once the data is in. A count of 0 next to a tab that has not loaded
                  reads as "empty" rather than as "not known yet". */}
              {count !== undefined && (
                <span className="text-xs opacity-70">{count}</span>
              )}
            </button>
          ))}
        </div>

        {tracker.isLoading && <SkeletonCard rows={6} />}
        {tracker.error && <ErrorNote message={(tracker.error as Error).message} />}

        {view &&
          (tab === 'applications' ? (
            <TrackedApplicationsTab
              view={view}
              onSettled={onSettled}
              focusPerson={focusPerson}
              onClearFocus={() => setFocusPerson(null)}
            />
          ) : (
            <PeopleTab
              view={view}
              onSettled={onSettled}
              onShowApplications={(contactId) => {
                setFocusPerson(contactId);
                setTab('applications');
              }}
            />
          ))}

        {view && view.applications.length > 0 && (
          <p className="flex flex-wrap items-center gap-2 px-1 text-xs text-[var(--ink-muted)]">
            <Badge tone="neutral">
              {view.applications.length} tracked · {view.contacts.length}{' '}
              {view.contacts.length === 1 ? 'person' : 'people'}
            </Badge>
            Kept only here. Nothing in this list is read by discovery, matching or the
            morning digest.
          </p>
        )}
      </div>
    </>
  );
}
