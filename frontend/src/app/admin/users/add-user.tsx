'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound, UserPlus, X } from 'lucide-react';
import { useState } from 'react';
import { useToast } from '@/components/toast';
import { Button, Card, CardHeader, controlClass } from '@/components/ui';
import { api, type SessionUser } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Matches the server's PASSWORD_MIN_LENGTH; the signup form states the same number. */
const MIN_PASSWORD = 12;

/**
 * Creating a candidate account from here, for the person who is not going to sign up.
 *
 * WHY THIS EXISTS WHEN /signup IS OPEN. Self-signup is a request: the account arrives
 * switched off and waits to be approved. That is the right shape when somebody has a
 * browser and five minutes, and the wrong shape when the account is being set up FOR
 * them - it turns one action into two, separated by however long it takes to notice the
 * pending row.
 *
 * THE ROLE IS NOT A FIELD, and it is not a field on purpose. Everything else on this
 * screen is reachable from a browser session, and a session is the thing an attacker
 * can get with a phishing email. So no HTTP route in this codebase grants ADMIN - not
 * signup, not approval, not this one. The server sends back a 400 rather than quietly
 * ignoring a `role` in the body, because a request that silently does less than it asked
 * for is worse than one that fails. Promotion stays a shell on the host.
 *
 * COLLAPSED BY DEFAULT. The job on this screen nine times out of ten is approving
 * somebody who already signed up; a permanently open form with a password box in it
 * would sit above that list competing for the eye.
 */
export function AddUserCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');

  const create = useMutation({
    mutationFn: (body: { email: string; name: string; password: string }) =>
      api.post<SessionUser>('/api/admin/users', body),
    onSuccess: (user) => {
      // Says "can sign in now" rather than "created", because the difference from a
      // signup - no approval step - is the whole reason this form is here.
      toast.success(
        `${user.name} can sign in now. Give them the password and have them change it.`,
      );
      setEmail('');
      setName('');
      setPassword('');
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
    // The server reports a duplicate address by name here, unlike signup, where doing
    // so would tell a stranger who has an account. An administrator is already looking
    // at the whole list.
    onError: (err) => toast.error((err as Error).message),
  });

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;
  const ready =
    email.trim().length > 0 &&
    name.trim().length > 0 &&
    password.length >= MIN_PASSWORD;

  const submit = () => {
    if (!ready) return;
    create.mutate({ email: email.trim(), name: name.trim(), password });
  };

  return (
    <Card>
      <CardHeader
        title="Add a candidate"
        subtitle="For someone who is not going to sign up themselves. The account is active immediately — there is nothing left to approve."
        icon={UserPlus}
        action={
          <Button
            variant={open ? 'ghost' : 'primary'}
            size="sm"
            icon={open ? X : UserPlus}
            onClick={() => setOpen(!open)}
          >
            {open ? 'Cancel' : 'Add user'}
          </Button>
        }
      />

      {open && (
        <div className="space-y-4 px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="new-user-name"
                className="mb-1 block text-xs text-[var(--ink-muted)]"
              >
                Name
              </label>
              <input
                id="new-user-name"
                className={cn(controlClass, 'w-full')}
                placeholder="Astha Niharika"
                value={name}
                maxLength={120}
                autoComplete="off"
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div>
              <label
                htmlFor="new-user-email"
                className="mb-1 block text-xs text-[var(--ink-muted)]"
              >
                Email
              </label>
              <input
                id="new-user-email"
                type="email"
                className={cn(controlClass, 'w-full')}
                placeholder="them@example.com"
                value={email}
                maxLength={200}
                autoComplete="off"
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="new-user-password"
              className="mb-1 block text-xs text-[var(--ink-muted)]"
            >
              First password
            </label>
            <input
              id="new-user-password"
              type="password"
              className={cn(controlClass, 'w-full sm:max-w-sm')}
              value={password}
              maxLength={200}
              // Not the browser's saved-password flow: this password belongs to
              // somebody else and should not end up in this admin's keychain.
              autoComplete="off"
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <p
              className="mt-1 text-xs"
              style={{
                color: tooShort
                  ? 'var(--status-warning)'
                  : 'var(--ink-muted)',
              }}
            >
              {tooShort
                ? `${MIN_PASSWORD - password.length} more character${
                    MIN_PASSWORD - password.length === 1 ? '' : 's'
                  }.`
                : `At least ${MIN_PASSWORD} characters. You will have to tell them what it is, so treat it as temporary.`}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              icon={UserPlus}
              busy={create.isPending}
              disabled={!ready}
              onClick={submit}
            >
              Create account
            </Button>
            <p className="flex items-start gap-1.5 text-xs text-[var(--ink-muted)]">
              <KeyRound size={13} className="mt-0.5 shrink-0" aria-hidden />
              Always a candidate. Administrators cannot be made from a browser.
            </p>
          </div>
        </div>
      )}
    </Card>
  );
}
