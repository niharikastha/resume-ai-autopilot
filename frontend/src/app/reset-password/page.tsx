'use client';

import { Lock } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import {
  AuthCard,
  AuthLayout,
  AuthLink,
  FormError,
  FormSuccess,
  PasswordField,
  SubmitButton,
} from '@/components/auth-ui';
import { Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

const MIN_PASSWORD = 12;

/**
 * useSearchParams suspends during prerender, so the page export is a boundary
 * and the form is a child of it. Without this the build fails rather than the
 * page merely rendering late.
 */
export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<Spinner label="Loading" />}>
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const token = useSearchParams().get('token');
  const router = useRouter();
  const { refreshUser } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || tooShort) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/reset-password', { token, password });
      // The reset revoked every session this account had, including any this
      // browser was holding. Re-reading /me drops the now-stale cached user so
      // the app does not keep rendering a signed-in shell it cannot back up.
      await refreshUser();
      setDone(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not reset the password',
      );
    } finally {
      setBusy(false);
    }
  }

  // A missing token means the link was truncated by an email client or typed by
  // hand. Say so instead of showing a form that cannot possibly submit.
  if (!token) {
    return (
      <AuthLayout
        title="Link incomplete"
        subtitle="That reset link is missing its token, which usually means it was cut short somewhere between the email and the browser."
        footer={
          <>
            <AuthLink href="/forgot-password">Request a new link</AuthLink>
          </>
        }
      >
        <FormError>
          Try opening the link directly from the email rather than copying it, or
          request a fresh one.
        </FormError>
      </AuthLayout>
    );
  }

  if (done) {
    return (
      <AuthLayout
        title="Password updated"
        subtitle="You can sign in with the new password now."
      >
        <div className="space-y-5">
          <FormSuccess>
            Every device that was signed in has been signed out - the usual
            reason for resetting a password is that someone else knew the old
            one, so nothing is left holding it.
          </FormSuccess>
          <button
            type="button"
            onClick={() => router.replace('/login')}
            className="flex w-full items-center justify-center rounded-[var(--r-md)] bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-[var(--accent-ink)] transition-all hover:bg-[var(--accent-hover)] hover:shadow-[var(--glow-accent)]"
          >
            Go to sign in
          </button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Choose a new password"
      subtitle="This link works once. Setting a password here signs out every device."
      footer={
        <>
          Link expired? <AuthLink href="/forgot-password">Get a new one</AuthLink>
        </>
      }
    >
      <AuthCard onSubmit={onSubmit}>
        {error && <FormError>{error}</FormError>}

        <PasswordField
          label="New password"
          icon={Lock}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          autoFocus
          required
          hint={`At least ${MIN_PASSWORD} characters. Length is the only rule.`}
          error={
            tooShort
              ? `${MIN_PASSWORD - password.length} more character${
                  MIN_PASSWORD - password.length === 1 ? '' : 's'
                } needed`
              : undefined
          }
        />

        <SubmitButton busy={busy}>
          {busy ? 'Updating' : 'Update password'}
        </SubmitButton>
      </AuthCard>
    </AuthLayout>
  );
}
