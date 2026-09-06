'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Circle, FileLock2 } from 'lucide-react';
import { PageHeader } from '@/components/shell';
import {
  Badge,
  Card,
  CardHeader,
  ErrorNote,
  SkeletonCard,
} from '@/components/ui';
import { api, type Integrations } from '@/lib/api';

export default function IntegrationsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'integrations'],
    queryFn: () => api.get<Integrations>('/api/admin/integrations'),
  });

  return (
    <>
      <PageHeader
        title="Integrations"
        subtitle="Which credentials are present, and nothing more."
      />

      <div className="space-y-5 px-4 pb-6 sm:px-6">
        {isLoading && <SkeletonCard rows={6} />}
        {error && <ErrorNote message={(error as Error).message} />}

        {data && (
          <>
            <Card>
              <div className="flex items-start gap-3 px-5 py-4">
                <FileLock2
                  size={16}
                  className="mt-0.5 shrink-0 text-[var(--ink-muted)]"
                  aria-hidden
                />
                <div className="text-sm text-[var(--ink-secondary)]">
                  <p className="font-medium text-[var(--ink-primary)]">
                    Keys are edited in{' '}
                    <code className="font-mono text-[var(--link)]">
                      {data.editableIn}
                    </code>
                  </p>
                  <p className="mt-1 text-xs text-[var(--ink-muted)]">
                    This screen shows presence only — not the value, not even a
                    masked one. A masked key still leaks its length and prefix,
                    and there is no reason for a browser to receive any part of a
                    credential. Writing keys through a web form would turn one
                    file readable by a single OS user into a database column, a
                    request body, a log line and an HTTP response.
                  </p>
                </div>
              </div>
            </Card>

            <Card>
              <CardHeader title="Status" />
              <ul>
                {data.items.map((item) => {
                  /* Three states, not two. A REQUIRED credential that is
                     missing is a fault; an OPTIONAL one that is missing is a
                     choice. Rendering both as the same grey circle meant the
                     one row an admin needs to act on looked exactly like the
                     three rows they can ignore. */
                  const state = item.configured
                    ? 'ok'
                    : item.required
                      ? 'missing'
                      : 'optional';
                  const Icon =
                    state === 'ok'
                      ? CheckCircle2
                      : state === 'missing'
                        ? AlertTriangle
                        : Circle;
                  return (
                    <li
                      key={item.key}
                      className="flex items-start gap-3 border-b border-[var(--border)] px-5 py-3.5 last:border-b-0"
                    >
                      <Icon
                        size={16}
                        className={
                          state === 'optional'
                            ? 'mt-0.5 shrink-0 text-[var(--ink-muted)]'
                            : 'mt-0.5 shrink-0'
                        }
                        style={
                          state === 'ok'
                            ? { color: 'var(--status-good)' }
                            : state === 'missing'
                              ? { color: 'var(--status-warning)' }
                              : undefined
                        }
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-[var(--ink-primary)]">
                            {item.label}
                          </span>
                          <code className="font-mono text-xs text-[var(--ink-muted)]">
                            {item.key}
                          </code>
                          {item.required && (
                            <Badge tone={state === 'missing' ? 'warning' : 'neutral'}>
                              required
                            </Badge>
                          )}
                        </div>
                        <div className="mt-0.5 text-xs text-[var(--ink-secondary)]">
                          {/* The word carries the state; the icon colour only
                              reinforces it. Never colour alone. */}
                          {state === 'ok'
                            ? 'Configured'
                            : state === 'missing'
                              ? 'Missing - required'
                              : 'Not set'}
                          {item.note ? ` · ${item.note}` : ''}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          </>
        )}
      </div>
    </>
  );
}
