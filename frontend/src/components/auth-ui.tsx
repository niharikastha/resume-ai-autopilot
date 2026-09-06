'use client';

import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useId, useState, type ReactNode } from 'react';

/**
 * The shared chrome for /login, /signup, /forgot-password and /reset-password.
 *
 * Four pages that are the same object in different states, so they are one
 * layout with different contents rather than four hand-built forms. The previous
 * login page was a bordered box floating in an empty viewport; the split gives
 * the form somewhere to sit and the left panel says what the product is to
 * someone who has arrived at a signup link with no other context.
 */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-screen">
      <BrandPanel />

      <main className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-[400px]">
          {/* Only shown where the brand panel is hidden, so the logo never
              appears twice. */}
          <div className="mb-8 lg:hidden">
            <Wordmark />
          </div>

          <h1 className="text-[26px] font-semibold tracking-tight text-[var(--ink-primary)]">
            {title}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-[var(--ink-secondary)]">
            {subtitle}
          </p>

          <div className="mt-8">{children}</div>

          {footer && (
            <div className="mt-6 border-t border-[var(--border)] pt-6 text-sm text-[var(--ink-muted)]">
              {footer}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function Wordmark({ inverse = false }: { inverse?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      {/* Lime tile, near-black glyph, in both variants. It is the brand mark, so
          it should not restyle itself depending on what it is sitting on. */}
      <div
        className="flex h-8 w-8 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] text-sm font-black text-[var(--accent-ink)]"
        aria-hidden
      >
        A
      </div>
      <span
        className={`text-[15px] font-semibold tracking-tight ${
          inverse ? 'text-white' : 'text-[var(--ink-primary)]'
        }`}
      >
        Autopilot
      </span>
    </div>
  );
}

/**
 * Hidden below lg. On a phone this would push the form off the fold, and a form
 * you have to scroll to reach is worse than no illustration.
 *
 * The stage list is the real pipeline, in order, and stops where the product
 * stops - "Prepare" is the last step and submitting is not on the list. That is
 * the same promise the rest of the app makes, so the first screen should not
 * imply otherwise.
 */
function BrandPanel() {
  const stages = [
    ['Discover', 'Company career pages, checked daily'],
    ['Score', 'Ranked against your actual profile'],
    ['Tailor', 'A resume rewritten per opening'],
    ['Prepare', 'The form filled, up to the submit button'],
  ];

  return (
    <aside
      className="relative hidden w-[46%] max-w-[560px] flex-col justify-between overflow-hidden p-12 lg:flex"
      // Literal hexes, not tokens. This panel is night-time in BOTH themes - the
      // form beside it flips, this does not - so it cannot borrow --accent-cyan
      // and friends, which go deep and muted in light mode and would leave the
      // glows invisible against the near-black.
      style={{
        background:
          'radial-gradient(38rem 30rem at 8% -8%, rgb(53 224 216 / 0.22), transparent 68%),' +
          'radial-gradient(34rem 28rem at 108% 22%, rgb(167 139 250 / 0.22), transparent 65%),' +
          'radial-gradient(26rem 22rem at 78% 108%, rgb(198 255 61 / 0.14), transparent 62%),' +
          '#08090d',
      }}
    >
      {/* Decorative only, so it is aria-hidden and carries no information that
          is not also in the text beside it. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.05]"
        style={{
          backgroundImage:
            'linear-gradient(#ffffff 1px, transparent 1px), linear-gradient(90deg, #ffffff 1px, transparent 1px)',
          backgroundSize: '32px 32px',
        }}
      />

      <div className="relative">
        <Wordmark inverse />
      </div>

      <div className="relative">
        <h2 className="max-w-[400px] text-[30px] leading-[1.2] font-semibold tracking-tight text-white">
          Every opening worth applying to,{' '}
          <span className="text-[var(--accent)]">prepared</span> before you sit
          down.
        </h2>

        <ol className="mt-10 space-y-5">
          {stages.map(([label, detail], i) => (
            <li key={label} className="flex gap-4">
              {/* Numbered, because these are ordered stages of one pipeline and
                  the order is the point. */}
              <span
                className="figure mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--r-full)] bg-white/10 text-[11px] font-semibold text-[var(--accent)] ring-1 ring-white/15"
                aria-hidden
              >
                {i + 1}
              </span>
              <div>
                <div className="text-sm font-medium text-white">{label}</div>
                <div className="mt-0.5 text-[13px] leading-snug text-white/60">
                  {detail}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </div>

      <p className="relative max-w-[380px] text-[13px] leading-relaxed text-white/55">
        It never presses submit for you. The last click is always yours.
      </p>
    </aside>
  );
}

/** The visual container for a form. A plain surface card, so the inputs inside
 *  it read as raised off the sunken page background. */
export function AuthCard({
  onSubmit,
  children,
}: {
  onSubmit: (e: React.FormEvent) => void;
  children: ReactNode;
}) {
  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="space-y-5 rounded-[var(--r-lg)] border border-[var(--border)] bg-[var(--surface-raised)] p-6 shadow-[var(--glow-soft)]"
    >
      {children}
    </form>
  );
}

/**
 * focus-visible:outline-none is safe here, and only here, because the ring below
 * replaces it: the field lights up its own border and casts --ring, which is a
 * bigger and clearer focus indicator than the default outline it removes.
 */
const inputClass =
  'w-full rounded-[var(--r-md)] border border-[var(--border-strong)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--ink-primary)] placeholder:text-[var(--ink-muted)] transition-[border-color,box-shadow] hover:border-[var(--ink-muted)] focus:border-[var(--accent)] focus:shadow-[var(--ring)] focus:outline-none focus-visible:outline-none';

export function Field({
  label,
  hint,
  error,
  children: _children,
  ...input
}: {
  label: string;
  hint?: string;
  error?: string;
  children?: never;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  return (
    <div>
      <label
        htmlFor={id}
        className="block text-[13px] font-medium text-[var(--ink-secondary)]"
      >
        {label}
      </label>
      <input
        {...input}
        id={id}
        // The message is linked to the input rather than merely placed near it,
        // so a screen reader reads it as part of the field and not as loose text
        // somewhere on the page.
        aria-invalid={error ? true : undefined}
        aria-describedby={
          [error ? errorId : null, hint ? hintId : null]
            .filter(Boolean)
            .join(' ') || undefined
        }
        className={`mt-1.5 ${inputClass} ${
          error ? 'border-[var(--status-critical)]' : ''
        }`}
      />
      {hint && !error && (
        <p id={hintId} className="mt-1.5 text-xs text-[var(--ink-muted)]">
          {hint}
        </p>
      )}
      {error && (
        <p
          id={errorId}
          className="mt-1.5 text-xs"
          style={{ color: 'var(--status-critical)' }}
        >
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A password field with a reveal toggle.
 *
 * Worth the extra control: the alternative to letting someone check what they
 * typed is a confirm-password field, and a reveal toggle catches the same typo
 * with one input instead of two.
 */
export function PasswordField({
  label,
  hint,
  error,
  ...input
}: {
  label: string;
  hint?: string;
  error?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  const [shown, setShown] = useState(false);
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  return (
    <div>
      <label
        htmlFor={id}
        className="block text-[13px] font-medium text-[var(--ink-secondary)]"
      >
        {label}
      </label>
      <div className="relative mt-1.5">
        <input
          {...input}
          id={id}
          type={shown ? 'text' : 'password'}
          aria-invalid={error ? true : undefined}
          aria-describedby={
            [error ? errorId : null, hint ? hintId : null]
              .filter(Boolean)
              .join(' ') || undefined
          }
          className={`${inputClass} pr-11 ${
            error ? 'border-[var(--status-critical)]' : ''
          }`}
        />
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          // tabIndex -1 would be wrong here: a keyboard user is exactly the
          // person most likely to want to check what they typed.
          aria-label={shown ? 'Hide password' : 'Show password'}
          className="absolute top-1/2 right-1 -translate-y-1/2 rounded-md p-2 text-[var(--ink-muted)] transition-colors hover:text-[var(--ink-primary)]"
        >
          {shown ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
        </button>
      </div>
      {hint && !error && (
        <p id={hintId} className="mt-1.5 text-xs text-[var(--ink-muted)]">
          {hint}
        </p>
      )}
      {error && (
        <p
          id={errorId}
          className="mt-1.5 text-xs"
          style={{ color: 'var(--status-critical)' }}
        >
          {error}
        </p>
      )}
    </div>
  );
}

export function SubmitButton({
  busy,
  children,
}: {
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="flex w-full items-center justify-center gap-2 rounded-[var(--r-md)] bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-[var(--accent-ink)] transition-all hover:bg-[var(--accent-hover)] hover:shadow-[var(--glow-accent)] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:shadow-none"
    >
      {busy && <Loader2 size={15} className="animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

/** Banner for a whole-form outcome. Icon + text, never colour alone - the same
 *  rule StatusBadge follows. */
function Banner({
  icon: Icon,
  color,
  tint,
  role,
  children,
}: {
  icon: LucideIcon;
  color: string;
  tint: string;
  role: 'alert' | 'status';
  children: ReactNode;
}) {
  return (
    <div
      role={role}
      className="animate-rise flex gap-2.5 rounded-[var(--r-md)] border p-3.5 text-[13px] leading-relaxed"
      style={{ borderColor: color, background: tint, color: 'var(--ink-primary)' }}
    >
      <Icon size={16} className="mt-px shrink-0" style={{ color }} aria-hidden />
      <div>{children}</div>
    </div>
  );
}

export function FormError({ children }: { children: ReactNode }) {
  return (
    <Banner
      icon={AlertCircle}
      color="var(--status-critical)"
      // color-mix rather than a hardcoded pink, so the tint is derived from the
      // status token and stays correct in dark mode.
      tint="color-mix(in srgb, var(--status-critical) 8%, transparent)"
      role="alert"
    >
      {children}
    </Banner>
  );
}

export function FormSuccess({ children }: { children: ReactNode }) {
  return (
    <Banner
      icon={CheckCircle2}
      color="var(--status-good)"
      tint="color-mix(in srgb, var(--status-good) 8%, transparent)"
      role="status"
    >
      {children}
    </Banner>
  );
}

/**
 * `typedRoutes` checks the href against the real route tree, so a literal union
 * here would be a second, hand-maintained copy of it that drifts. Instead this
 * mirrors Link's own signature - generic in the route it is given - so a typo in
 * a path is still a build error, checked against one source of truth.
 */
export function AuthLink<T extends string>({
  href,
  children,
}: {
  href: React.ComponentProps<typeof Link<T>>['href'];
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="font-medium text-[var(--link)] underline-offset-2 hover:underline"
    >
      {children}
    </Link>
  );
}
