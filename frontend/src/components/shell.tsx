'use client';

import {
  LogOut,
  Moon,
  Search,
  ShieldCheck,
  Sun,
} from 'lucide-react';
import type { Route } from 'next';
import { useTheme } from 'next-themes';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { CommandPalette } from './command-palette';
import {
  ADMIN_NAV,
  CANDIDATE_NAV,
  isNavActive,
  MOBILE_NAV,
  type NavItem,
} from './nav';
import { Spinner } from './ui';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/utils';

function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const next = resolvedTheme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      title={`Switch to ${next} mode`}
      aria-label={`Switch to ${next} mode`}
      className={cn(
        'rounded-[var(--r-sm)] p-2 text-[var(--ink-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)]',
        className,
      )}
    >
      {resolvedTheme === 'dark' ? (
        <Sun size={16} aria-hidden />
      ) : (
        <Moon size={16} aria-hidden />
      )}
    </button>
  );
}

/** The wordmark. A lime tile with near-black glyph - the same pairing as the
 *  primary button, which is what makes the accent read as "the brand" rather than
 *  as one more colour on the page. */
function Brand() {
  return (
    <span className="flex items-center gap-2.5">
      <span
        aria-hidden
        className="flex h-7 w-7 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] text-[13px] font-black text-[var(--accent-ink)] shadow-[var(--glow-accent)]"
      >
        A
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-[var(--ink-primary)]">
        Autopilot
      </span>
    </span>
  );
}

function NavSection({
  heading,
  items,
  pathname,
}: {
  heading: string;
  items: NavItem[];
  pathname: string;
}) {
  return (
    <div className="mb-5">
      <div className="mb-1.5 px-3 text-[10px] font-semibold tracking-[0.12em] text-[var(--ink-muted)] uppercase">
        {heading}
      </div>
      <nav className="space-y-0.5">
        {items.map(({ href, label, icon: Icon }) => {
          const active = isNavActive(href, pathname);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'group relative flex items-center gap-2.5 rounded-[var(--r-sm)] px-3 py-2 text-sm transition-colors duration-150',
                active
                  ? 'bg-[var(--surface-hover)] font-medium text-[var(--ink-primary)]'
                  : 'text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)]',
              )}
            >
              {/* The active marker is a lime bar, not a lime label: coloured text
                  in a nav makes every item look like a different kind of link. */}
              <span
                aria-hidden
                className={cn(
                  'absolute top-1/2 left-0 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-[var(--accent)] transition-opacity duration-150',
                  active ? 'opacity-100' : 'opacity-0',
                )}
              />
              <Icon
                size={15}
                aria-hidden
                className={cn(
                  'shrink-0 transition-colors',
                  active
                    ? 'text-[var(--accent)]'
                    : 'text-[var(--ink-muted)] group-hover:text-[var(--ink-secondary)]',
                )}
              />
              {label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/**
 * The mobile tab bar.
 *
 * The sidebar is `hidden md:flex`, and for a while nothing replaced it below that
 * breakpoint - the whole app was unreachable on a phone except by typing URLs.
 * Four candidate destinations fit comfortably; the admin section collapses to a
 * single tab, because five tabs of 20% width start truncating labels. WHICH four is
 * decided in nav.ts by MOBILE_NAV rather than by slicing the sidebar's list, so adding
 * a route to the sidebar no longer changes the tab bar behind anyone's back.
 *
 * pb-[env(safe-area-inset-bottom)] keeps the row above the iOS home indicator.
 */
function MobileTabs({
  pathname,
  isAdmin,
}: {
  pathname: string;
  isAdmin: boolean;
}) {
  const items: NavItem[] = isAdmin
    ? [...MOBILE_NAV.slice(0, 3), { ...ADMIN_NAV[0]!, label: 'Admin' }]
    : MOBILE_NAV;

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-50 flex border-t border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-raised)_92%,transparent)] pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden"
    >
      {items.map(({ href, label, icon: Icon }) => {
        const active = isNavActive(href, pathname);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'relative flex flex-1 flex-col items-center gap-1 py-2.5 text-[10px] font-medium transition-colors',
              active ? 'text-[var(--ink-primary)]' : 'text-[var(--ink-muted)]',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'absolute inset-x-4 top-0 h-[2px] rounded-b-full bg-[var(--accent)] transition-opacity',
                active ? 'opacity-100' : 'opacity-0',
              )}
            />
            <Icon
              size={19}
              aria-hidden
              className={active ? 'text-[var(--accent)]' : undefined}
            />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Initials, for when there is no avatar to show and never will be. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

/**
 * The authenticated shell.
 *
 * requireAdmin gates rendering, and it is ergonomics only: it stops a USER
 * seeing an admin page flash and then error. The page's data still comes from
 * @Roles(ADMIN) routes that reject a USER at the server, so a hand-typed
 * /admin URL yields no data even though this component could be bypassed.
 */
export function Shell({
  children,
  requireAdmin,
}: {
  children: ReactNode;
  requireAdmin?: boolean;
}) {
  const { user, loading, isAdmin, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  /* ⌘K / Ctrl+K, owned here so the header button and the shortcut share one piece
     of state. It is safe to bind unconditionally: the combination is a modifier
     chord, so it cannot collide with typing into a field, and preventDefault stops
     Firefox hijacking it for its search bar. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (loading) return <Spinner label="Checking your session…" />;
  if (!user) return null;

  if (requireAdmin && !isAdmin) {
    return (
      <div className="mx-auto max-w-md px-6 py-24 text-center">
        <ShieldCheck
          size={28}
          className="mx-auto mb-3 text-[var(--ink-muted)]"
          aria-hidden
        />
        <h1 className="text-base font-semibold text-[var(--ink-primary)]">
          Admin access required
        </h1>
        <p className="mt-1.5 text-sm text-[var(--ink-secondary)]">
          This page shows connector internals and account settings. Your account
          is a candidate account.
        </p>
        <Link
          href={'/app' as Route}
          className="mt-5 inline-block rounded-[var(--r-sm)] bg-[var(--accent)] px-3.5 py-2 text-sm font-semibold text-[var(--accent-ink)] transition-colors hover:bg-[var(--accent-hover)]"
        >
          Back to your dashboard
        </Link>
      </div>
    );
  }

  const signOut = () => {
    void logout().then(() => router.replace('/login'));
  };

  return (
    <div className="flex min-h-screen">
      {/*
        `sticky top-0 h-screen` and both halves are load-bearing.

        THE BUG THIS FIXES: the aside is a flex child of a `min-h-screen` row, so
        without a height of its own it stretched to the height of the DOCUMENT.
        The account block below is the last thing in a `flex-col`, so on any page
        taller than the window - the dashboard, the jobs list - it sat at the
        bottom of the whole scrollable page rather than the bottom of the
        sidebar. It was reachable only by scrolling to the very end, which is why
        it appeared to exist on the profile page and nowhere else: the profile
        page is the one short enough to fit.

        h-screen pins the column to the viewport and sticky keeps it there while
        the main column scrolls. The nav in the middle carries `flex-1
        overflow-y-auto`, so if the nav itself ever outgrows a short window it
        scrolls inside the sidebar and the account block still holds its place.
      */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-raised)_70%,transparent)] backdrop-blur-xl md:flex">
        <div className="px-4 py-4">
          <Brand />
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          <NavSection
            heading="Your job search"
            items={CANDIDATE_NAV}
            pathname={pathname}
          />
          {isAdmin && (
            <NavSection heading="Admin" items={ADMIN_NAV} pathname={pathname} />
          )}
        </div>

        <div className="border-t border-[var(--border)] p-3">
          <div className="mb-2 flex items-center gap-2.5 px-1">
            <span
              aria-hidden
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--r-full)] bg-[color-mix(in_srgb,var(--accent-violet)_20%,transparent)] text-[11px] font-semibold text-[var(--accent-violet)]"
            >
              {initials(user.name)}
            </span>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-[13px] font-medium text-[var(--ink-primary)]">
                  {user.name}
                </span>
                {/* The role, as a mark beside the name rather than a third line
                    of small grey text. Not decoration, so it is labelled rather
                    than aria-hidden - it is the only thing distinguishing an
                    admin session from a candidate one at a glance. */}
                {isAdmin && (
                  <ShieldCheck
                    size={12}
                    role="img"
                    aria-label="Administrator"
                    className="shrink-0 text-[var(--accent)]"
                  />
                )}
              </div>
              {/* WHICH ACCOUNT AM I IN. The name is chosen by the person and can
                  be anything; the email is the identity, and it is the thing
                  worth checking before signing out of the wrong session or
                  wondering why a page shows someone else's jobs.

                  `title` because the truncation is real - a work address in a
                  240px column runs out of room - and a tooltip is the cheapest
                  way to read the rest without leaving the page. */}
              <div
                title={user.email}
                className="truncate text-[11px] text-[var(--ink-muted)]"
              >
                {user.email}
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={signOut}
              className="flex items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-[13px] text-[var(--ink-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)]"
            >
              <LogOut size={14} aria-hidden />
              Sign out
            </button>
            <ThemeToggle />
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Sticky, translucent, and only as tall as it needs to be. On a phone it
            carries the brand and the account controls the sidebar would have
            held; on a desktop it is mostly the ⌘K affordance, because a shortcut
            nobody can see is a shortcut nobody uses. */}
        <header className="sticky top-0 z-40 flex items-center gap-2 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--canvas)_82%,transparent)] px-4 py-2.5 backdrop-blur-xl">
          <span className="md:hidden">
            <Brand />
          </span>

          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-label="Open command palette"
            className="ml-auto flex items-center gap-2 rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--surface-raised)] px-2.5 py-1.5 text-[13px] text-[var(--ink-muted)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--ink-secondary)] md:w-64 md:justify-start"
          >
            <Search size={14} aria-hidden />
            <span className="hidden md:inline">Jump to…</span>
            <kbd className="ml-auto hidden rounded border border-[var(--border)] px-1.5 py-px font-sans text-[10px] md:inline">
              ⌘K
            </kbd>
          </button>

          <span className="flex items-center md:hidden">
            <ThemeToggle />
            <button
              type="button"
              onClick={signOut}
              aria-label="Sign out"
              className="rounded-[var(--r-sm)] p-2 text-[var(--ink-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--ink-primary)]"
            >
              <LogOut size={16} aria-hidden />
            </button>
          </span>
        </header>

        {/* pb-24 clears the fixed tab bar on mobile; nothing needed above md. */}
        <main className="min-w-0 flex-1 pb-24 md:pb-0">{children}</main>
      </div>

      <MobileTabs pathname={pathname} isAdmin={isAdmin} />
      {/* Mounted only while open: a fresh mount is what clears the query and the
          selection, so the palette needs no reset effect. */}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 px-4 pt-6 pb-4 sm:px-6">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-[var(--ink-primary)]">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-[var(--ink-secondary)]">
            {subtitle}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}
