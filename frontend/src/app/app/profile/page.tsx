'use client';

import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, ShieldOff, Upload } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/shell';
import {
  Badge,
  Card,
  CardHeader,
  ErrorNote,
  SkeletonCard,
} from '@/components/ui';
import { api, type UserOverview } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { relativeTime } from '@/lib/utils';
import { AnswersCard } from './answers';
import { BlockedCompaniesCard } from './blocked-companies';
import { LocationsCard } from './locations';

/**
 * The two things only the candidate can state, and the account they belong to.
 *
 * Resumes have their own screen now - uploading, choosing the one in use and editing
 * its pieces all live under /app/resumes, because that is three actions on a list
 * rather than one field on an account page. What is left here is the account itself,
 * where they will work (locations.tsx), the answers a form asks for (answers.tsx) and
 * the trust boundaries, which are worth stating on a screen of their own.
 */
export default function ProfilePage() {
  const { user } = useAuth();
  const { data, isLoading, error } = useQuery({
    queryKey: ['me', 'overview'],
    queryFn: () => api.get<UserOverview>('/api/me/overview'),
  });

  return (
    <>
      <PageHeader
        title="My profile"
        subtitle="Your resume, and the answers only you can give."
      />

      <div className="max-w-3xl space-y-5 px-4 pb-6 sm:px-6">
        {isLoading && <SkeletonCard rows={3} />}
        {error && <ErrorNote message={(error as Error).message} />}

        {user && (
          <Card>
            <CardHeader title="Account" />
            <dl className="grid grid-cols-[auto_1fr] gap-x-8 gap-y-2.5 px-5 py-4 text-sm">
              <dt className="text-[var(--ink-muted)]">Name</dt>
              <dd className="text-[var(--ink-primary)]">{user.name}</dd>
              <dt className="text-[var(--ink-muted)]">Email</dt>
              <dd className="text-[var(--ink-primary)]">{user.email}</dd>
              <dt className="text-[var(--ink-muted)]">Role</dt>
              <dd>
                <Badge tone={user.role === 'ADMIN' ? 'accent' : 'neutral'}>
                  {user.role === 'ADMIN' ? 'Administrator' : 'Candidate'}
                </Badge>
              </dd>
            </dl>
          </Card>
        )}

        {data && (
          <Card>
            <CardHeader
              title="Resume"
              subtitle="Uploaded once, then broken into facts the tailoring step is allowed to draw from — and nothing else."
            />
            <div className="px-5 py-4 text-sm">
              {!data.profile ? (
                <div className="flex items-start gap-3">
                  <Upload
                    size={16}
                    className="mt-0.5 shrink-0 text-[var(--ink-muted)]"
                    aria-hidden
                  />
                  <div>
                    <p className="text-[var(--ink-primary)]">
                      No resume uploaded yet
                    </p>
                    <p className="mt-1 text-xs text-[var(--ink-muted)]">
                      Add one under{' '}
                      <Link
                        href="/app/resumes"
                        className="text-[var(--link)] hover:underline"
                      >
                        Resumes
                      </Link>
                      .
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-3">
                  {data.profile.confirmedAt ? (
                    <CheckCircle2
                      size={16}
                      className="mt-0.5 shrink-0"
                      style={{ color: 'var(--status-good)' }}
                      aria-hidden
                    />
                  ) : (
                    <CircleAlert
                      size={16}
                      className="mt-0.5 shrink-0"
                      style={{ color: 'var(--status-warning)' }}
                      aria-hidden
                    />
                  )}
                  <div>
                    <p className="text-[var(--ink-primary)]">
                      {data.profile.confirmedAt
                        ? 'Confirmed'
                        : 'Awaiting your confirmation'}
                    </p>
                    <p className="mt-1 text-xs text-[var(--ink-muted)]">
                      {data.profile.confirmedAt
                        ? `Confirmed ${relativeTime(data.profile.confirmedAt)}`
                        : 'Nothing downstream runs until you have checked what was read from your resume. A misread date or employer would otherwise propagate into every application.'}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </Card>
        )}

        {/* The one setting on this screen that is editable, and the only one that
            changes what the daily run looks at. It lives here rather than on a screen
            of its own because it is the same kind of thing as the answers below:
            something only the candidate can state. */}
        <LocationsCard />

        {/* Directly under the locations card because it is the same kind of rule read
            from the other side: where you will work, and who you will not work for.
            Above the answers, because ruling an employer out stops their postings
            before any of these answers would ever be needed. */}
        <BlockedCompaniesCard />

        {/* The answers themselves. Never inferred, never generated and not visible to
            an administrator - guessing someone's visa status or salary onto a real job
            application is worse than leaving the pipeline blocked. */}
        <AnswersCard />

        <Card>
          <CardHeader title="What is never asked or answered for you" />
          <div className="flex items-start gap-3 px-5 py-4">
            <ShieldOff
              size={16}
              className="mt-0.5 shrink-0 text-[var(--ink-muted)]"
              aria-hidden
            />
            <div className="text-sm text-[var(--ink-secondary)]">
              <p>
                Gender, race, disability and veteran status are not stored here
                and are not filled on any form. Where an application asks, it is
                left at &quot;decline to self-identify&quot; unless you answer it
                yourself in the browser.
              </p>
              <p className="mt-2 text-xs text-[var(--ink-muted)]">
                They are also not inferred from your name, your photo or anything
                else. There is no field for them in the database.
              </p>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
