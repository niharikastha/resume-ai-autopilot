'use client';

import { Lock, Mail } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  AuthCard,
  AuthLayout,
  AuthLink,
  Field,
  FormError,
  PasswordField,
  SubmitButton,
} from '@/components/auth-ui';
import { useAuth } from '@/lib/auth-context';

export default function LoginPage() {
  const { user, loading, login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // An admin lands on the pipeline view, a candidate on their own dashboard -
  // each role's first screen is the one they actually use.
  useEffect(() => {
    if (!loading && user) {
      router.replace(user.role === 'ADMIN' ? '/admin' : '/app');
    }
  }, [loading, user, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const signedIn = await login(email, password);
      router.replace(signedIn.role === 'ADMIN' ? '/admin' : '/app');
    } catch (err) {
      // Shown verbatim. The server already decided what is safe to say here -
      // "invalid email or password" for a credential failure, and something
      // specific for an account awaiting approval, which is only reachable with
      // a correct password and so is not an enumeration leak.
      setError(err instanceof Error ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      eyebrow="Welcome back"
      title="Sign in"
      subtitle="Pick up where the overnight run left off."
      footer={
        <>
          No account yet? <AuthLink href="/signup">Request access</AuthLink>
        </>
      }
    >
      <AuthCard onSubmit={onSubmit}>
        {error && <FormError>{error}</FormError>}

        <Field
          label="Email"
          icon={Mail}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          // The one field worth autofocusing: this page exists to be typed into,
          // and there is nothing above it to read first.
          autoFocus
          required
          placeholder="you@example.com"
        />

        <div>
          <PasswordField
            label="Password"
            icon={Lock}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            placeholder="••••••••"
          />
          <div className="mt-2 text-right text-[13px]">
            <AuthLink href="/forgot-password">Forgot your password?</AuthLink>
          </div>
        </div>

        <SubmitButton busy={busy}>
          {busy ? 'Signing in' : 'Sign in'}
        </SubmitButton>
      </AuthCard>
    </AuthLayout>
  );
}
