'use client';

import { Clock3, Lock, Mail } from 'lucide-react';
import { useState } from 'react';
import {
  AuthCard,
  AuthLayout,
  AuthLink,
  Field,
  FormError,
  PasswordField,
  SubmitButton,
} from '@/components/auth-ui';
import { api } from '@/lib/api';

const MIN_PASSWORD = 12;

export default function SignupPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState<string | null>(null);

  // Checked here only to save a round trip. The server enforces the same floor
  // and does not trust this - client-side validation is ergonomics.
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (tooShort) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ message: string }>('/api/auth/signup', {
        name,
        email,
        password,
      });
      setSubmitted(res.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign up');
    } finally {
      setBusy(false);
    }
  }

  if (submitted) {
    return (
      <AuthLayout
        title="Request received"
        subtitle="Nothing more to do for now."
        footer={
          <>
            Already approved? <AuthLink href="/login">Sign in</AuthLink>
          </>
        }
      >
        <div className="animate-rise rounded-[var(--r-lg)] border border-[var(--border)] bg-[var(--surface-raised)] p-6 shadow-[var(--glow-soft)]">
          <div
            className="flex h-10 w-10 items-center justify-center rounded-[var(--r-full)]"
            style={{
              // Waiting is a neutral state, not a warning: --link rather than
              // amber, because nothing has gone wrong.
              background: 'color-mix(in srgb, var(--link) 14%, transparent)',
              color: 'var(--link)',
            }}
          >
            <Clock3 size={18} aria-hidden />
          </div>
          <p className="mt-4 text-sm leading-relaxed text-[var(--ink-secondary)]">
            {submitted}
          </p>
          <p className="mt-3 text-[13px] leading-relaxed text-[var(--ink-muted)]">
            Signing in before then will tell you the account is still waiting -
            that is expected, not an error.
          </p>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Request access"
      subtitle="Anyone can ask. An administrator approves each account before it can sign in, so there is a wait between this form and your first login."
      footer={
        <>
          Already have an account? <AuthLink href="/login">Sign in</AuthLink>
        </>
      }
    >
      <AuthCard onSubmit={onSubmit}>
        {error && <FormError>{error}</FormError>}

        <Field
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          autoFocus
          required
          maxLength={120}
          placeholder="Your name"
        />

        <Field
          label="Email"
          icon={Mail}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          required
          placeholder="you@example.com"
          hint="Where the approval notice and any reset links are sent."
        />

        <PasswordField
          label="Password"
          icon={Lock}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          required
          // Length is the only rule, so the hint says that plainly instead of
          // demanding a symbol nobody remembers. See AuthService.
          hint={`At least ${MIN_PASSWORD} characters. Length is the only rule - a passphrase beats a short password with punctuation in it.`}
          error={
            tooShort
              ? `${MIN_PASSWORD - password.length} more character${
                  MIN_PASSWORD - password.length === 1 ? '' : 's'
                } needed`
              : undefined
          }
        />

        <SubmitButton busy={busy}>
          {busy ? 'Sending request' : 'Request access'}
        </SubmitButton>
      </AuthCard>
    </AuthLayout>
  );
}
