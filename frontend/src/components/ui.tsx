'use client';

import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/utils';

/**
 * useLayoutEffect warns when it runs during server rendering, and useEffect
 * fires after the browser has painted. The count-up needs pre-paint, so it takes
 * the layout effect on the client and the harmless one on the server.
 */
const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect;

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function subscribeReducedMotion(onChange: () => void) {
  const mq = window.matchMedia(REDUCED_MOTION);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

/**
 * prefers-reduced-motion as React state, for the animations CSS cannot reach.
 *
 * useSyncExternalStore rather than useState + an effect: a media query IS an
 * external store, and reading it in an effect means one render at the wrong value
 * plus a lint rule complaining about cascading renders. The server snapshot is
 * `false` because there is no query to read during prerender - the first client
 * paint corrects it before anything animates.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
}

/* ============================================================================
 * Surfaces
 * ==========================================================================*/

export function Card({
  children,
  className,
  interactive,
  glow,
}: {
  children: ReactNode;
  className?: string;
  /** Lifts and brightens on hover. Only for cards that are a link or a button -
   *  a card that moves under the cursor and does nothing is a broken promise. */
  interactive?: boolean;
  /** Accent-tinted edge, for the one card on a screen that wants attention. */
  glow?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-[var(--r-lg)] border bg-[var(--surface-raised)] shadow-[var(--glow-soft)]',
        glow
          ? 'border-[color-mix(in_srgb,var(--accent)_35%,var(--border))]'
          : 'border-[var(--border)]',
        interactive &&
          'transition-[transform,border-color,background-color] duration-200 hover:-translate-y-0.5 hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
  icon: Icon,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
      <div className="flex min-w-0 gap-3">
        {Icon && (
          <span
            className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--r-sm)] bg-[color-mix(in_srgb,var(--link)_14%,transparent)] text-[var(--link)]"
            aria-hidden
          >
            <Icon size={15} />
          </span>
        )}
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight text-[var(--ink-primary)]">
            {title}
          </h2>
          {subtitle && (
            <p className="mt-1 text-xs leading-relaxed text-[var(--ink-muted)]">
              {subtitle}
            </p>
          )}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/* ============================================================================
 * Numbers
 * ==========================================================================*/

/**
 * Counts from zero to the value once, on mount.
 *
 * Deliberately not a spring or a per-digit roll: this is a KPI, and the point of
 * animating it is to draw the eye, not to make the number hard to read while it
 * settles. Roughly 700ms with an ease-out, and large numbers are stepped so the
 * final frames do not crawl.
 *
 * Honours prefers-reduced-motion by jumping straight to the value - a number
 * that never stops moving is exactly what that setting exists to prevent.
 */
function useCountUp(value: number): number {
  const reduced = useReducedMotion();
  const [display, setDisplay] = useState(value);
  const frame = useRef<number>(0);

  useIsomorphicLayoutEffect(() => {
    if (reduced || value === 0) {
      setDisplay(value);
      return;
    }

    const duration = 700;
    const start = performance.now();
    setDisplay(0);

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // ease-out cubic: fast at the start, so the number is legible early
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(value * eased));
      if (t < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [value, reduced]);

  return display;
}

/**
 * A stat tile, not a chart. Per the form heuristic: a single headline number has
 * no shape to show, so a bar of one bar would be decoration.
 */
export function StatTile({
  label,
  value,
  hint,
  emphasis,
  icon: Icon,
  tone = 'default',
}: {
  label: string;
  /** The raw number, so it can be animated and formatted here. */
  value: number;
  hint?: string;
  emphasis?: boolean;
  icon?: LucideIcon;
  /** `accent` marks the tile that means "something is waiting for you". */
  tone?: 'default' | 'accent';
}) {
  const shown = useCountUp(value);

  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-[var(--r-lg)] border bg-[var(--surface-raised)] px-5 py-4 shadow-[var(--glow-soft)] transition-colors duration-200',
        tone === 'accent'
          ? 'border-[color-mix(in_srgb,var(--accent)_35%,var(--border))]'
          : 'border-[var(--border)] hover:border-[var(--border-strong)]',
      )}
    >
      {/* Hairline of colour along the top edge. Decorative, and the tone is also
          carried by the icon tint and the hint text, so nothing is colour-only. */}
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-px"
        style={{
          background:
            tone === 'accent'
              ? 'linear-gradient(90deg, transparent, var(--accent), transparent)'
              : 'linear-gradient(90deg, transparent, var(--border-strong), transparent)',
        }}
      />

      <div className="flex items-start justify-between gap-3">
        <div className="text-[11px] font-medium tracking-[0.08em] text-[var(--ink-muted)] uppercase">
          {label}
        </div>
        {Icon && (
          <Icon
            size={15}
            aria-hidden
            className="shrink-0 transition-colors"
            style={{
              color: tone === 'accent' ? 'var(--accent)' : 'var(--ink-muted)',
            }}
          />
        )}
      </div>

      <div
        className={cn(
          'figure mt-2.5 font-semibold text-[var(--ink-primary)]',
          emphasis ? 'text-[32px] leading-none' : 'text-[26px] leading-none',
        )}
      >
        {shown.toLocaleString('en-IN')}
      </div>

      {hint && (
        <div className="mt-2 text-xs leading-relaxed text-[var(--ink-secondary)]">
          {hint}
        </div>
      )}
    </div>
  );
}

/* ============================================================================
 * State
 * ==========================================================================*/

const STATUS_META: Record<
  'healthy' | 'degraded' | 'dead',
  { icon: LucideIcon; label: string; color: string }
> = {
  healthy: { icon: CheckCircle2, label: 'Healthy', color: 'var(--status-good)' },
  degraded: {
    icon: AlertTriangle,
    label: 'Degraded',
    color: 'var(--status-warning)',
  },
  dead: { icon: XCircle, label: 'Dead', color: 'var(--status-critical)' },
};

/**
 * Status is ALWAYS icon + text + colour, never colour alone.
 *
 * Here that is load-bearing, not belt-and-braces. The palette clears every CVD
 * check, but light-mode --status-good sits at 2.01:1 on white - a contrast WARN
 * whose required relief IS a visible label (see the forced-trade note in
 * globals.css). So the word is the encoding and the tint is reinforcement, which
 * is why the label renders in --ink-primary rather than in the status colour.
 */
export function StatusBadge({
  status,
}: {
  status: 'healthy' | 'degraded' | 'dead';
}) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-[var(--r-full)] py-1 pr-2.5 pl-2 text-xs font-medium text-[var(--ink-primary)]"
      style={{
        background: `color-mix(in srgb, ${meta.color} 14%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${meta.color} 30%, transparent)`,
      }}
    >
      <Icon size={13} style={{ color: meta.color }} aria-hidden />
      {meta.label}
    </span>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'good' | 'warning' | 'critical';
}) {
  const styles: Record<string, string> = {
    accent: 'var(--accent)',
    good: 'var(--status-good)',
    warning: 'var(--status-warning)',
    critical: 'var(--status-critical)',
  };
  const color = styles[tone];

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-[var(--r-full)] px-2 py-0.5 text-[11px] font-medium whitespace-nowrap',
        color
          ? 'text-[var(--ink-primary)]'
          : 'bg-[var(--surface-hover)] text-[var(--ink-secondary)] ring-1 ring-[var(--border)] ring-inset',
      )}
      style={
        color
          ? {
              background: `color-mix(in srgb, ${color} 16%, transparent)`,
              boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 32%, transparent)`,
            }
          : undefined
      }
    >
      {children}
    </span>
  );
}

/**
 * The honest empty state.
 *
 * An empty chart must say WHY it is empty. "No data" reads as broken; naming the
 * phase that will fill it reads as not-built-yet, which is the truth for
 * everything past discovery right now.
 */
export function EmptyState({
  title,
  detail,
  phase,
  icon: Icon,
  action,
}: {
  title: string;
  detail?: string;
  phase?: string;
  icon?: LucideIcon;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-[180px] flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {Icon && (
        <span
          aria-hidden
          className="mb-1 flex h-11 w-11 items-center justify-center rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--surface-hover)] text-[var(--ink-muted)]"
        >
          <Icon size={19} />
        </span>
      )}
      <p className="text-sm font-medium text-[var(--ink-secondary)]">{title}</p>
      {detail && (
        <p className="max-w-sm text-xs leading-relaxed text-[var(--ink-muted)]">
          {detail}
        </p>
      )}
      {phase && (
        <span className="mt-1 rounded-[var(--r-full)] border border-dashed border-[var(--border-strong)] px-2.5 py-0.5 text-[11px] text-[var(--ink-muted)]">
          arrives in {phase}
        </span>
      )}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2.5 py-16 text-sm text-[var(--ink-muted)]">
      <Loader2 size={16} className="animate-spin" aria-hidden />
      {label ?? 'Loading…'}
    </div>
  );
}

/* ============================================================================
 * Skeletons
 *
 * A spinner says "something is happening". A skeleton says "something is
 * happening AND here is the shape of what is coming", which stops the layout
 * jumping when the data lands. Used wherever the shape is known in advance.
 * ==========================================================================*/

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn('skeleton rounded-[var(--r-sm)]', className)}
    />
  );
}

export function SkeletonTiles({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="rounded-[var(--r-lg)] border border-[var(--border)] bg-[var(--surface-raised)] px-5 py-4"
        >
          <Skeleton className="h-2.5 w-24" />
          <Skeleton className="mt-3.5 h-7 w-20" />
          <Skeleton className="mt-3 h-2.5 w-32" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonCard({ rows = 4 }: { rows?: number }) {
  return (
    <Card>
      <div className="border-b border-[var(--border)] px-5 py-4">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="mt-2.5 h-2.5 w-64" />
      </div>
      <div className="space-y-3 px-5 py-4">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton
            key={i}
            className="h-3"
            // Uneven widths, because a stack of identical bars reads as a
            // graphic rather than as text that has not arrived.
            {...{ style: { width: `${90 - i * 12}%` } }}
          />
        ))}
      </div>
    </Card>
  );
}

/** The full loading shape for a dashboard: tiles, then a wide panel. */
export function SkeletonDashboard() {
  return (
    <div className="space-y-5 p-4 sm:p-6">
      <SkeletonTiles />
      <SkeletonCard rows={5} />
    </div>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-[var(--r-md)] border px-4 py-3 text-sm"
      style={{
        borderColor: 'color-mix(in srgb, var(--status-critical) 40%, transparent)',
        background: 'color-mix(in srgb, var(--status-critical) 7%, transparent)',
      }}
    >
      <XCircle
        size={16}
        style={{ color: 'var(--status-critical)' }}
        className="mt-0.5 shrink-0"
        aria-hidden
      />
      <span className="text-[var(--ink-secondary)]">{message}</span>
    </div>
  );
}

/* ============================================================================
 * Controls
 * ==========================================================================*/

/**
 * One button, four variants, so "the primary action" looks the same everywhere.
 *
 * `primary` is lime with near-black text - the only combination allowed on the
 * accent, because white on lime is 1.3:1. There should be at most one primary
 * button visible on a screen; if two things are equally important, neither is.
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  busy,
  icon: Icon,
  children,
  className,
  ...props
}: {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  busy?: boolean;
  icon?: LucideIcon;
  children?: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const variants: Record<string, string> = {
    primary:
      'bg-[var(--accent)] text-[var(--accent-ink)] font-semibold hover:bg-[var(--accent-hover)] hover:shadow-[var(--glow-accent)]',
    secondary:
      'border border-[var(--border-strong)] text-[var(--ink-secondary)] hover:border-[var(--ink-muted)] hover:text-[var(--ink-primary)] hover:bg-[var(--surface-hover)]',
    ghost:
      'text-[var(--ink-muted)] hover:text-[var(--ink-primary)] hover:bg-[var(--surface-hover)]',
    danger:
      'border border-[var(--border-strong)] text-[var(--ink-secondary)] hover:border-[var(--status-critical)] hover:text-[var(--status-critical)]',
  };

  return (
    <button
      type="button"
      {...props}
      disabled={busy || props.disabled}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[var(--r-sm)] transition-all duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-55',
        size === 'sm'
          ? 'px-2.5 py-1.5 text-xs font-medium'
          : 'px-3.5 py-2 text-[13px] font-medium',
        variants[variant],
        className,
      )}
    >
      {busy ? (
        <Loader2
          size={size === 'sm' ? 12 : 14}
          className="animate-spin"
          aria-hidden
        />
      ) : (
        Icon && <Icon size={size === 'sm' ? 12 : 14} aria-hidden />
      )}
      {children}
    </button>
  );
}

/**
 * The shape of a filter control - text input, select, anything in a filter row.
 *
 * Exported as a class string rather than wrapped in a component because these are
 * plain inputs with page-specific props; a wrapper would exist only to forward
 * every attribute of two different elements. No focus:outline-none here: the
 * global :focus-visible ring is the indicator and it should not be overridden.
 */
export const controlClass =
  'rounded-[var(--r-sm)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 py-1.5 text-sm text-[var(--ink-primary)] transition-colors placeholder:text-[var(--ink-muted)] hover:border-[var(--ink-muted)]';

/* ============================================================================
 * Tables
 * ==========================================================================*/

export function Table({
  head,
  children,
}: {
  head: ReactNode;
  children: ReactNode;
}) {
  return (
    // -mx-px so the horizontal scroll shadow does not clip the card's border.
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-left">{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** A row that highlights under the cursor, so the eye can track across a wide
 *  table without losing its line. */
export function Tr({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <tr
      className={cn(
        'transition-colors duration-100 hover:bg-[var(--surface-hover)]',
        className,
      )}
    >
      {children}
    </tr>
  );
}

/**
 * nowrap is for short, atomic values - "Not stated", "12m ago", a score.
 *
 * Left to wrap, the table's auto layout steals width from these narrow columns
 * to give it to the long title column, and a two-word value breaks across two
 * lines. That reads as two facts stacked rather than one, and it makes every row
 * in the table taller. Table already scrolls horizontally, so nowrap costs
 * nothing worse than a scrollbar on a narrow viewport.
 */
export function Th({
  children,
  numeric,
  nowrap,
}: {
  children: ReactNode;
  numeric?: boolean;
  nowrap?: boolean;
}) {
  return (
    <th
      className={cn(
        'px-4 py-3 text-[11px] font-medium tracking-[0.08em] text-[var(--ink-muted)] uppercase',
        numeric && 'text-right',
        nowrap && 'whitespace-nowrap',
      )}
      scope="col"
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  numeric,
  nowrap,
  className,
}: {
  children: ReactNode;
  numeric?: boolean;
  nowrap?: boolean;
  className?: string;
}) {
  return (
    <td
      className={cn(
        'border-b border-[var(--border)] px-4 py-3 text-[var(--ink-secondary)]',
        numeric && 'figure text-right',
        nowrap && 'whitespace-nowrap',
        className,
      )}
    >
      {children}
    </td>
  );
}
