'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ShieldCheck, Terminal, UserX } from 'lucide-react';
import { PageHeader } from '@/components/shell';
import { useToast } from '@/components/toast';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ErrorNote,
  SkeletonCard,
  Table,
  Td,
  Th,
  Tr,
} from '@/components/ui';
import { api, type UserRow } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { num, relativeTime } from '@/lib/utils';
import { AddUserCard } from './add-user';

type AccountState = 'pending' | 'suspended' | 'active';

/**
 * `active` and `approvedAt` together, because neither alone is enough: two
 * inactive accounts can need opposite actions. One has never been looked at and
 * wants approving; the other was approved and then switched off, and turning it
 * back on is a different decision.
 */
function stateOf(u: UserRow): AccountState {
  if (u.active) return 'active';
  return u.approvedAt ? 'suspended' : 'pending';
}

export default function UsersPage() {
  const queryClient = useQueryClient();
  const { user: me } = useAuth();
  const toast = useToast();

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api.get<UserRow[]>('/api/admin/users'),
  });

  /**
   * `name` rides along in the variables purely so the toast can name the account.
   * It is not sent anywhere - mutationFn destructures only id and active - and the
   * alternative was looking the row up again after the list has already been
   * invalidated out from under it.
   */
  const setActive = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean; name: string }) =>
      api.patch<void>(`/api/admin/users/${id}/active`, { active }),
    onSuccess: (_data, vars) => {
      // Approving moves the row out of the pending list, and on a long list that
      // is the only feedback there is. The toast says which account and what
      // happened, which is the difference between "it worked" and "did it?".
      toast.success(
        vars.active
          ? `${vars.name} can sign in now.`
          : `${vars.name} is suspended. Their sessions are revoked.`,
      );
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const pending = data?.filter((u) => stateOf(u) === 'pending') ?? [];

  return (
    <>
      <PageHeader
        title="Accounts"
        subtitle="Two roles: administrators see the machine, candidates see their own job search."
      />

      <div className="space-y-5 px-4 pb-6 sm:px-6">
        {/* Above the loading state, because it does not need the list to be
            useful and collapses to a single button when it is not wanted. */}
        <AddUserCard />

        {isLoading && <SkeletonCard rows={6} />}
        {error && <ErrorNote message={(error as Error).message} />}

        {/* Surfaced above the table as well as in it. A signup nobody notices is
            a person waiting indefinitely, so it gets a count on the way in
            rather than only a row somewhere in a list. */}
        {pending.length > 0 && (
          <Card glow>
            <CardHeader
              title={`${pending.length} account${pending.length === 1 ? '' : 's'} waiting for approval`}
              subtitle="Anyone can request access; nobody can sign in until you approve them here."
            />
            <div className="stagger divide-y divide-[var(--border)]">
              {pending.map((u) => (
                <div
                  key={u.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                >
                  <div>
                    <div className="text-sm font-medium text-[var(--ink-primary)]">
                      {u.name}
                    </div>
                    <div className="text-xs text-[var(--ink-muted)]">
                      {u.email} · requested {relativeTime(u.createdAt)}
                    </div>
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    icon={Check}
                    busy={
                      setActive.isPending && setActive.variables?.id === u.id
                    }
                    onClick={() =>
                      setActive.mutate({ id: u.id, active: true, name: u.name })
                    }
                  >
                    Approve
                  </Button>
                </div>
              ))}
            </div>
          </Card>
        )}

        {data && (
          <Card>
            <Table
              head={
                <>
                  <Th>Name</Th>
                  <Th>Email</Th>
                  <Th>Role</Th>
                  <Th>Status</Th>
                  <Th>Resume</Th>
                  <Th numeric>Scored</Th>
                  <Th numeric>Applications</Th>
                  <Th>Last signed in</Th>
                  <Th>Access</Th>
                </>
              }
            >
              {data.map((u) => {
                const profile = u.profiles[0];
                const state = stateOf(u);
                const busy =
                  setActive.isPending && setActive.variables?.id === u.id;
                return (
                  <Tr key={u.id}>
                    <Td className="font-medium text-[var(--ink-primary)]">
                      {u.name}
                    </Td>
                    <Td>{u.email}</Td>
                    <Td nowrap>
                      <span className="inline-flex items-center gap-1.5">
                        {u.role === 'ADMIN' && (
                          <ShieldCheck size={13} aria-hidden />
                        )}
                        {u.role === 'ADMIN' ? 'Administrator' : 'Candidate'}
                      </span>
                    </Td>
                    <Td nowrap>
                      {/* The tone is a second cue on top of the word, never
                          instead of it - the label is what carries the state. */}
                      {state === 'active' && <Badge tone="good">active</Badge>}
                      {state === 'pending' && (
                        <Badge tone="warning">awaiting approval</Badge>
                      )}
                      {state === 'suspended' && (
                        <Badge tone="critical">suspended</Badge>
                      )}
                    </Td>
                    <Td nowrap>
                      {!profile
                        ? 'Not uploaded'
                        : profile.confirmedAt
                          ? 'Confirmed'
                          : 'Awaiting confirmation'}
                    </Td>
                    <Td numeric>{num(u._count.matchScores)}</Td>
                    <Td numeric>{num(u._count.applications)}</Td>
                    <Td nowrap>{relativeTime(u.lastLoginAt)}</Td>
                    <Td nowrap>
                      {/* Your own row has no control. Suspending yourself is the
                          one action here you cannot undo from the UI you just
                          locked yourself out of - the server refuses it too, so
                          this is not the only guard. */}
                      {u.id === me?.id ? (
                        <span className="text-xs text-[var(--ink-muted)]">
                          you
                        </span>
                      ) : state === 'active' ? (
                        <Button
                          variant="danger"
                          size="sm"
                          icon={UserX}
                          busy={busy}
                          onClick={() =>
                            setActive.mutate({
                              id: u.id,
                              active: false,
                              name: u.name,
                            })
                          }
                        >
                          Suspend
                        </Button>
                      ) : (
                        <Button
                          variant="primary"
                          size="sm"
                          icon={Check}
                          busy={busy}
                          onClick={() =>
                            setActive.mutate({
                              id: u.id,
                              active: true,
                              name: u.name,
                            })
                          }
                        >
                          {state === 'pending' ? 'Approve' : 'Restore'}
                        </Button>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </Table>
          </Card>
        )}

        <Card>
          <CardHeader
            title="How accounts are created"
            subtitle="Three routes in, and only one of them can produce an administrator."
          />
          <div className="space-y-4 px-5 py-4 text-sm text-[var(--ink-secondary)]">
            <p>
              <strong className="text-[var(--ink-primary)]">Self-signup.</strong>{' '}
              Open to anyone at <code>/signup</code>, and worth nothing on its own
              — the account is created switched off and cannot sign in until it is
              approved above. The role is always Candidate; the signup endpoint has
              no field for a role, so asking for administrator is not something
              the form can express.
            </p>
            <p>
              <strong className="text-[var(--ink-primary)]">
                Added from this screen.
              </strong>{' '}
              The form at the top, for someone who is not going to sign up
              themselves. It produces the same account a signup does, minus the
              wait — you have already made the decision approval exists to
              record. Always a Candidate too: that endpoint has no role field
              either, and sending one is refused rather than ignored.
            </p>
            <p>
              <strong className="text-[var(--ink-primary)]">The CLI.</strong> The
              only way to create an administrator, because it needs a shell on the
              host rather than a session a phished admin could be talked into
              using.
            </p>
            {/* Fixed near-black, not --surface-sunken, because the text is lime:
                16.7:1 on this background and 1.4:1 on a light surface. A shell
                command is a terminal, and a terminal is dark in both themes. */}
            <pre className="overflow-x-auto rounded-[var(--r-sm)] border border-[var(--border-strong)] bg-[#0a0b0f] px-3 py-2.5 font-mono text-xs text-[var(--accent)]">
              npm run cli -- create-user --email you@example.com --name
              &quot;Your Name&quot; --role admin
            </pre>
            <p className="flex items-start gap-2 text-xs text-[var(--ink-muted)]">
              <Terminal size={13} className="mt-0.5 shrink-0" aria-hidden />
              The password is prompted for, never passed as a command-line flag —
              argv is readable by every process on the machine and lands in shell
              history.
            </p>
          </div>
        </Card>

        <Card>
          <CardHeader title="What an administrator cannot do" />
          <ul className="space-y-2 px-5 py-4 text-sm text-[var(--ink-secondary)]">
            <li>
              <strong className="text-[var(--ink-primary)]">
                Fill a candidate&apos;s application answers.
              </strong>{' '}
              Work authorization, notice period and expected CTC are writable
              only by the person they describe. Guessing someone else&apos;s visa
              status onto a real application is worse than a blocked pipeline.
            </li>
            <li>
              <strong className="text-[var(--ink-primary)]">
                Answer EEO or demographic questions.
              </strong>{' '}
              These are never stored, never inferred and never auto-filled, for
              any role. Forms are left at &quot;decline to self-identify&quot;.
            </li>
            <li>
              <strong className="text-[var(--ink-primary)]">
                Grant a role.
              </strong>{' '}
              Approving an account decides whether someone may sign in, and
              nothing else. Promotion to administrator is a CLI operation.
            </li>
            <li>
              <strong className="text-[var(--ink-primary)]">
                Submit an application.
              </strong>{' '}
              No adapter has a submit codepath. Admin is not a permission to
              auto-apply — the last click is always a human&apos;s.
            </li>
          </ul>
        </Card>
      </div>
    </>
  );
}
