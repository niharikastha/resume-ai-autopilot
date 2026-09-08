'use client';

import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  ShieldCheck,
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
  eyebrow,
  title,
  subtitle,
  children,
  footer,
}: {
  /** Small label above the heading. Optional - a page with nothing useful to put
   *  here should print nothing rather than a decorative word. */
  eyebrow?: string;
  title: string;
  subtitle: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-screen">
      <BrandPanel />

      {/* `relative` and `overflow-hidden` scope the wash below to this column. The
          form side used to be a flat rectangle of --canvas with a card sitting on
          it, which is most of the reason the page read as unfinished next to the
          lit panel beside it. */}
      <main className="relative flex flex-1 items-center justify-center overflow-hidden px-6 py-12">
        {/* The artwork, at full strength and behind the form itself rather than
            fading out around it. It is also the layer that matters on a PHONE -
            the brand panel is hidden below lg, so without this a small screen
            gets no picture at all.

            `bg-right` and not `bg-center`: the panel beside it crops the same
            file from the middle, and two halves showing the identical crop with a
            divider between them looks like a rendering mistake. Cropping this one
            from the other edge makes them read as one continuous scene.

            `mix-blend-mode: screen` is what makes one asset safe in both themes
            without a second file or a theme check in JS. Screen keeps the lighter
            of what it is given, so the artwork's near-black base disappears
            entirely and only its colour survives: on the dark canvas the glows
            come through, and against light mode's white nothing can be lighter
            than the page, so the layer vanishes by arithmetic rather than by a
            rule someone has to remember to write. */}
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-[6%] bg-cover bg-right mix-blend-screen"
          style={{ backgroundImage: "url('/auth-bg.svg')" }}
        />

        {/* The scrim that keeps the form legible over a picture, pulled from
            --canvas rather than written as a dark rgba. That is what lets one
            rule serve both themes: in dark mode it settles the artwork back
            towards near-black, and in light mode the same mix is towards white,
            which is the direction light mode needs. A hardcoded dark tint would
            put a grey cloud in the middle of a white page.

            Centred and elliptical, so it is densest exactly where the heading,
            the card and the footer sit, and gone by the edges where the artwork
            is the only thing there. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(46rem 40rem at 50% 50%, color-mix(in srgb, var(--canvas) 82%, transparent), color-mix(in srgb, var(--canvas) 30%, transparent) 62%, transparent 88%)',
          }}
        />

        <div
          aria-hidden
          className="grain pointer-events-none absolute inset-0 opacity-[0.05]"
        />

        <div className="animate-rise relative w-full max-w-[416px]">
          {/* Only shown where the brand panel is hidden, so the logo never
              appears twice. */}
          <div className="mb-8 lg:hidden">
            <Wordmark />
          </div>

          {eyebrow && (
            <p className="mb-2.5 text-[11px] font-semibold tracking-[0.14em] text-[var(--ink-muted)] uppercase">
              {eyebrow}
            </p>
          )}

          <h1 className="text-[30px] leading-[1.15] font-semibold tracking-[-0.02em] text-[var(--ink-primary)]">
            {title}
          </h1>
          <p className="mt-2.5 text-[14px] leading-relaxed text-[var(--ink-secondary)]">
            {subtitle}
          </p>

          <div className="mt-7">{children}</div>

          {footer && (
            <div className="mt-6 text-center text-sm text-[var(--ink-muted)]">
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
    // The right border is a hairline in white, not in --border: the panel is
    // near-black in both themes, so a token that goes pale in light mode would
    // draw a bright line down the middle of the page.
    <aside className="relative hidden w-[46%] max-w-[560px] flex-col justify-between overflow-hidden border-r border-white/[0.06] bg-[#08090d] p-12 lg:flex">
      {/* The artwork, on its own layer so it can drift without taking the text
          with it. `-inset-[10%]` is what buys the drift its room: the layer is
          20% larger than the panel in both axes, so a 2% translate and a 6%
          scale never expose an edge.

          Inset over the panel's own near-black rather than replacing it, so the
          panel is still the right colour for the fraction of a second before an
          image request finishes - and stays the right colour if it fails. */}
      <div
        aria-hidden
        className="animate-aurora pointer-events-none absolute -inset-[10%] bg-cover bg-center"
        style={{ backgroundImage: "url('/auth-bg.svg')" }}
      />

      {/* The scrim, and it is not decoration - it is what makes the copy on top
          of a picture readable. Angled rather than a flat tint: the text is all
          on the left, so the right side keeps its colour at full strength while
          the left is pulled back to near the base. The second gradient darkens
          the bottom edge, where the artwork's lime glow sits directly behind the
          promise line. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'linear-gradient(100deg, rgb(8 9 13 / 0.62) 0%, rgb(8 9 13 / 0.26) 48%, rgb(8 9 13 / 0) 100%),' +
            'linear-gradient(to top, rgb(8 9 13 / 0.55), transparent 38%)',
        }}
      />

      {/* Grain last of the decorative layers, so it textures the artwork AND the
          scrim as one image rather than sitting under half of it. */}
      <div
        aria-hidden
        className="grain pointer-events-none absolute inset-0 opacity-[0.055]"
      />

      <div className="relative">
        <Wordmark inverse />
      </div>

      <div className="relative">
        <h2 className="max-w-[420px] text-[32px] leading-[1.16] font-semibold tracking-[-0.02em] text-white">
          Every opening worth applying to,{' '}
          <span className="text-[var(--accent)]">prepared</span> before you sit
          down.
        </h2>

        <ol className="mt-10">
          {stages.map(([label, detail], i) => (
            // `relative` anchors the connector below; the last item does not draw
            // one, so the line ends at the final stage rather than trailing off
            // into the panel.
            <li key={label} className="relative flex gap-4 pb-5 last:pb-0">
              {i < stages.length - 1 && (
                <span
                  aria-hidden
                  className="absolute top-7 left-3 h-[calc(100%-1.25rem)] w-px bg-gradient-to-b from-white/20 to-white/[0.04]"
                />
              )}
              {/* Numbered, because these are ordered stages of one pipeline and
                  the order is the point. The connector is what makes that visible
                  rather than merely stated. */}
              <span
                className="figure relative mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--r-full)] bg-white/10 text-[11px] font-semibold text-[var(--accent)] ring-1 ring-white/15"
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

      {/* The one promise the product makes, so it gets a mark rather than sitting
          as a loose sentence in the corner. */}
      <p className="relative flex max-w-[380px] items-start gap-2.5 text-[13px] leading-relaxed text-white/55">
        <ShieldCheck
          size={15}
          className="mt-0.5 shrink-0 text-[var(--accent)]"
          aria-hidden
        />
        It never presses submit for you. The last click is always yours.
      </p>
    </aside>
  );
}

/**
 * The visual container for a form, raised off the page behind it.
 *
 * The `before:` line is a hairline top highlight, brightest in the middle and
 * fading at both ends. It is what the theme's own note about depth prescribes -
 * on a near-black canvas a black shadow is invisible, so an edge catching the
 * light is the only thing that reads as height. A plain 1px border on all four
 * sides does not: it reads as a drawn rectangle.
 *
 * FROSTED, not opaque, now that there is artwork behind it. An opaque panel over
 * a picture punches a rectangular hole in it and the picture might as well not be
 * there; a translucent one with `backdrop-blur` lets the colour behind show
 * through while blurring it enough that no contour line runs under a word. The
 * surface colour is still --surface-raised, only mixed with transparency, so the
 * card is the same object in both themes rather than a dark pane that would go
 * wrong the moment light mode is selected.
 *
 * NOT `overflow-hidden`, deliberately. A focused input casts --ring 3px beyond
 * itself and the password toggle sits at the field's edge; clipping the card
 * would crop both.
 */
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
      className="relative space-y-5 rounded-[var(--r-xl)] border border-[var(--border-strong)] bg-[color-mix(in_srgb,var(--surface-raised)_72%,transparent)] p-7 shadow-[0_24px_60px_-24px_rgb(0_0_0/0.7)] backdrop-blur-2xl before:pointer-events-none before:absolute before:inset-x-6 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-white/25 before:to-transparent"
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
  'w-full rounded-[var(--r-md)] border border-[var(--border-strong)] bg-[var(--surface)] px-3.5 py-3 text-sm text-[var(--ink-primary)] placeholder:text-[var(--ink-muted)] transition-[border-color,box-shadow] hover:border-[var(--ink-muted)] focus:border-[var(--accent)] focus:shadow-[var(--ring)] focus:outline-none focus-visible:outline-none';

/** Shared by both field types, so a label here and a label there cannot drift. */
function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label
      htmlFor={htmlFor}
      className="block text-[13px] font-medium text-[var(--ink-secondary)]"
    >
      {children}
    </label>
  );
}

/**
 * The hint or the error under a field, never both.
 *
 * The message is linked to the input by id rather than merely placed near it, so
 * a screen reader reads it as part of the field instead of as loose text
 * somewhere on the page.
 */
function FieldMessage({
  hintId,
  errorId,
  hint,
  error,
}: {
  hintId: string;
  errorId: string;
  hint?: string;
  error?: string;
}) {
  if (error) {
    return (
      <p
        id={errorId}
        className="mt-1.5 text-xs"
        style={{ color: 'var(--status-critical)' }}
      >
        {error}
      </p>
    );
  }
  if (hint) {
    return (
      <p id={hintId} className="mt-1.5 text-xs text-[var(--ink-muted)]">
        {hint}
      </p>
    );
  }
  return null;
}

/**
 * A leading glyph inside the field.
 *
 * Optional, and worth having where the field's type is obvious enough for one
 * icon to be unambiguous - an envelope for an address, a padlock for a secret. A
 * decorative icon on a field like "Full name" earns nothing, so it is passed per
 * field rather than applied to all of them.
 *
 * aria-hidden and duplicated by the visible label, so nothing is conveyed by the
 * glyph alone.
 */
function LeadingIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <Icon
      size={16}
      aria-hidden
      className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-[var(--ink-muted)]"
    />
  );
}

export function Field({
  label,
  hint,
  error,
  icon,
  children: _children,
  ...input
}: {
  label: string;
  hint?: string;
  error?: string;
  icon?: LucideIcon;
  children?: never;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  return (
    <div>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="relative mt-1.5">
        {icon && <LeadingIcon icon={icon} />}
        <input
          {...input}
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={
            [error ? errorId : null, hint ? hintId : null]
              .filter(Boolean)
              .join(' ') || undefined
          }
          className={`${inputClass} ${icon ? 'pl-10' : ''} ${
            error ? 'border-[var(--status-critical)]' : ''
          }`}
        />
      </div>
      <FieldMessage
        hintId={hintId}
        errorId={errorId}
        hint={hint}
        error={error}
      />
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
  icon,
  ...input
}: {
  label: string;
  hint?: string;
  error?: string;
  icon?: LucideIcon;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  const [shown, setShown] = useState(false);
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  return (
    <div>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="relative mt-1.5">
        {icon && <LeadingIcon icon={icon} />}
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
          className={`${inputClass} pr-11 ${icon ? 'pl-10' : ''} ${
            error ? 'border-[var(--status-critical)]' : ''
          }`}
        />
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          // tabIndex -1 would be wrong here: a keyboard user is exactly the
          // person most likely to want to check what they typed.
          aria-label={shown ? 'Hide password' : 'Show password'}
          className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-[var(--r-sm)] p-2 text-[var(--ink-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)]"
        >
          {shown ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
        </button>
      </div>
      <FieldMessage
        hintId={hintId}
        errorId={errorId}
        hint={hint}
        error={error}
      />
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
      // `group` so the arrow can react to the button's hover rather than needing
      // its own. The arrow is hidden while busy: an idle nudge-forward next to a
      // spinner says the opposite of what the spinner says.
      className="group flex w-full items-center justify-center gap-2 rounded-[var(--r-md)] bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-[var(--accent-ink)] transition-all hover:bg-[var(--accent-hover)] hover:shadow-[var(--glow-accent)] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:shadow-none"
    >
      {busy && <Loader2 size={15} className="animate-spin" aria-hidden />}
      {children}
      {!busy && (
        <ArrowRight
          size={15}
          aria-hidden
          className="transition-transform duration-200 group-hover:translate-x-0.5"
        />
      )}
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
