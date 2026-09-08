'use client';

import { Mail } from 'lucide-react';
import { useState } from 'react';
import {
  AuthCard,
  AuthLayout,
  AuthLink,
  Field,
  FormError,
  FormSuccess,
  SubmitButton,
} from '@/components/auth-ui';
import { api } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ message: string }>(
        '/api/auth/forgot-password',
        { email },
      );
      setSent(res.message);
    } catch (err) {
      // The only real failure mode here is 503, which means the server has no
      // SMTP configured. That is worth showing: it tells the person to go and
      // ask the operator rather than keep refreshing an empty inbox.
      setError(err instanceof Error ? err.message : 'Could not send the link');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="Enter the address you sign in with and we will email you a link to set a new password."
      footer={
        <>
          Remembered it? <AuthLink href="/login">Back to sign in</AuthLink>
        </>
      }
    >
      {sent ? (
        <div className="space-y-5">
          <FormSuccess>{sent}</FormSuccess>
          <p className="text-[13px] leading-relaxed text-[var(--ink-muted)]">
            Nothing arrived? Check spam, then try again - requesting a new link
            replaces the previous one, so only the newest email will work.
          </p>
        </div>
      ) : (
        <AuthCard onSubmit={onSubmit}>
          {error && <FormError>{error}</FormError>}

          <Field
            label="Email"
            icon={Mail}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            autoFocus
            required
            placeholder="you@example.com"
          />

          <SubmitButton busy={busy}>
            {busy ? 'Sending' : 'Send reset link'}
          </SubmitButton>
        </AuthCard>
      )}
    </AuthLayout>
  );
}
