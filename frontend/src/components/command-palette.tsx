'use client';

import {
  ArrowRight,
  CornerDownLeft,
  LogOut,
  Moon,
  Search,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import type { Route } from 'next';
import { useTheme } from 'next-themes';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ADMIN_NAV, CANDIDATE_NAV } from './nav';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/utils';

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  group: string;
  /** Extra words that should match but are not worth showing. */
  keywords?: string;
  run: () => void;
}

/**
 * Substring match across label, hint and keywords, scored so a prefix wins.
 *
 * Not a fuzzy matcher. Fuzzy matching earns its keep over hundreds of files; over
 * nine commands it mostly produces surprising hits ("apn" matching "Pipeline")
 * that make the list feel unpredictable.
 */
function score(cmd: Command, q: string): number {
  if (!q) return 0;
  const hay = `${cmd.label} ${cmd.hint ?? ''} ${cmd.keywords ?? ''}`.toLowerCase();
  const label = cmd.label.toLowerCase();
  if (label.startsWith(q)) return 3;
  if (label.includes(q)) return 2;
  if (hay.includes(q)) return 1;
  return -1;
}

/**
 * ⌘K navigation.
 *
 * The sidebar is the discoverable way to move around; this is the fast one. It
 * covers every route the current account can reach - admin entries appear only for
 * an admin, matching the sidebar, though as ever the server is what actually
 * refuses a USER hitting an admin route.
 *
 * Shell owns the open flag and MOUNTS this only while open, rather than passing
 * `open` in and returning null. Mounting is what resets the query and the
 * selection, so reopening is a fresh prompt without a single reset effect - and
 * "set state when the thing opens" is exactly the cascading render React 19 warns
 * about.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { isAdmin, logout } = useAuth();
  const { resolvedTheme, setTheme } = useTheme();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const go = useCallback(
    (href: Route) => {
      onClose();
      router.push(href);
    },
    [onClose, router],
  );

  const commands = useMemo<Command[]>(() => {
    const nav = (group: string) => (item: (typeof CANDIDATE_NAV)[number]) => ({
      id: item.href,
      label: item.label,
      hint: item.hint,
      icon: item.icon,
      group,
      run: () => go(item.href),
    });

    const list: Command[] = [
      ...CANDIDATE_NAV.map(nav('Your job search')),
      ...(isAdmin ? ADMIN_NAV.map(nav('Admin')) : []),
      {
        id: 'theme',
        label: resolvedTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
        icon: resolvedTheme === 'dark' ? Sun : Moon,
        group: 'Settings',
        keywords: 'theme dark light appearance colour color',
        run: () => {
          setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
          onClose();
        },
      },
      {
        id: 'signout',
        label: 'Sign out',
        icon: LogOut,
        group: 'Settings',
        keywords: 'logout log out leave',
        run: () => {
          onClose();
          void logout().then(() => router.replace('/login'));
        },
      },
    ];
    return list;
  }, [go, isAdmin, logout, onClose, resolvedTheme, router, setTheme]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands
      .map((c) => ({ c, s: score(c, q) }))
      .filter(({ s }) => s >= 0)
      .sort((a, b) => b.s - a.s)
      .map(({ c }) => c);
  }, [commands, query]);

  /* Clamped at render, not corrected in an effect. Typing shrinks the list under
     a selection that may now be past the end; fixing that in an effect means one
     painted frame with nothing highlighted, plus a state write React 19 flags. */
  const active = Math.min(selected, Math.max(0, results.length - 1));

  /* Take focus, and hand it back on unmount.
     Deliberately not the `autoFocus` attribute: React applies that during commit,
     so activeElement is already the input by the time any effect could record
     where focus came from, and Escape would return it nowhere. */
  useEffect(() => {
    const cameFrom = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => cameFrom?.focus?.();
  }, []);

  /* Scroll-lock the page behind the overlay. Without it a trackpad scroll moves
     the dashboard under a modal that looks fixed, which reads as a glitch. */
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  /* Keep the highlighted row visible when arrowing past the fold. */
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const count = Math.max(1, results.length);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((active + 1) % count);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((active - 1 + count) % count);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      results[active]?.run();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center px-4 pt-[12vh]"
      // Backdrop click closes. The dialog stops propagation, so only a click on
      // the empty area counts.
      onMouseDown={onClose}
    >
      <div
        className="animate-pop absolute inset-0 bg-black/60 backdrop-blur-sm"
        aria-hidden
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className="animate-pop relative w-full max-w-lg overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-strong)] bg-[var(--surface-raised)] shadow-[0_24px_64px_-16px_rgb(0_0_0/0.7)]"
      >
        <div className="flex items-center gap-2.5 border-b border-[var(--border)] px-4">
          <Search size={16} className="shrink-0 text-[var(--ink-muted)]" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to a page, or type an action…"
            aria-label="Search commands"
            className="w-full bg-transparent py-3.5 text-sm text-[var(--ink-primary)] placeholder:text-[var(--ink-muted)] focus:outline-none"
          />
          <kbd className="shrink-0 rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--ink-muted)]">
            esc
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-2">
          {results.length === 0 && (
            <p className="px-3 py-8 text-center text-sm text-[var(--ink-muted)]">
              Nothing matches “{query}”.
            </p>
          )}

          {results.map((cmd, i) => {
            const Icon = cmd.icon;
            // Read backwards off the list rather than carrying a mutable
            // `lastGroup` down the loop: a variable reassigned during render is
            // state in disguise, and React 19's lint says so.
            const showGroup = i === 0 || results[i - 1]!.group !== cmd.group;
            const isActive = i === active;
            return (
              <div key={cmd.id}>
                {showGroup && (
                  <div className="px-3 pt-3 pb-1.5 text-[10px] font-medium tracking-[0.1em] text-[var(--ink-muted)] uppercase">
                    {cmd.group}
                  </div>
                )}
                <button
                  type="button"
                  data-active={isActive}
                  // Hover moves the selection so mouse and keyboard never
                  // disagree about which row Enter would fire.
                  onMouseEnter={() => setSelected(i)}
                  onClick={cmd.run}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-[var(--r-sm)] px-3 py-2 text-left',
                    isActive
                      ? 'bg-[var(--surface-hover)]'
                      : 'hover:bg-[var(--surface-hover)]',
                  )}
                >
                  <Icon
                    size={15}
                    aria-hidden
                    className={
                      isActive ? 'text-[var(--accent)]' : 'text-[var(--ink-muted)]'
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-[var(--ink-primary)]">
                      {cmd.label}
                    </span>
                    {cmd.hint && (
                      <span className="block truncate text-xs text-[var(--ink-muted)]">
                        {cmd.hint}
                      </span>
                    )}
                  </span>
                  {isActive && (
                    <CornerDownLeft
                      size={13}
                      className="shrink-0 text-[var(--ink-muted)]"
                      aria-hidden
                    />
                  )}
                </button>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-4 border-t border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-[11px] text-[var(--ink-muted)]">
          <span className="flex items-center gap-1.5">
            <ArrowRight size={11} className="rotate-90" aria-hidden />
            <ArrowRight size={11} className="-rotate-90" aria-hidden />
            to move
          </span>
          <span className="flex items-center gap-1.5">
            <CornerDownLeft size={11} aria-hidden />
            to open
          </span>
        </div>
      </div>
    </div>
  );
}
