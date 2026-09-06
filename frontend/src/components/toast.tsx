'use client';

import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

type Tone = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  tone: Tone;
  message: string;
}

interface ToastApi {
  /** Confirm something that actually happened. */
  success: (message: string) => void;
  /** A failure the user needs to know about but that does not block the page. */
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TONE = {
  success: { icon: CheckCircle2, color: 'var(--status-good)' },
  error: { icon: AlertCircle, color: 'var(--status-critical)' },
  info: { icon: Info, color: 'var(--link)' },
} as const;

/**
 * Toasts for actions whose result would otherwise be invisible.
 *
 * Approving an account is the motivating case: the row moves out of the pending
 * list and that is the only feedback, so on a long list nothing appears to
 * happen. A toast says which account and that it worked.
 *
 * Errors get eight seconds, everything else four. An error is something you may
 * need to read twice, and it is the one case where the message is not also
 * implied by the screen changing.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (tone: Tone, message: string) => {
      // Date.now() would collide when two toasts land in the same millisecond,
      // which duplicate React keys turn into a dropped toast.
      const id = nextId++;
      setToasts((list) => [...list, { id, tone, message }]);
      setTimeout(() => dismiss(id), tone === 'error' ? 8000 : 4000);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (m) => push('success', m),
      error: (m) => push('error', m),
      info: (m) => push('info', m),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}

      {/*
        aria-live="polite" so a screen reader announces the toast when it is idle
        rather than interrupting, and role="status" so the region is recognised
        before anything is in it. Announcing only works if the container exists
        up front, which is why it renders even when the list is empty.

        bottom on mobile, top-right on desktop: at the bottom of a phone it sits
        over the tab bar, and on a desktop the eye is already near the top-right
        for account and theme controls.
      */}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-20 z-[70] flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:top-4 sm:right-4 sm:bottom-auto sm:items-end"
      >
        {toasts.map((t) => {
          const { icon: Icon, color } = TONE[t.tone];
          return (
            <div
              key={t.id}
              className="animate-slide-in pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-[var(--r-md)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3.5 py-3 text-[13px] leading-relaxed text-[var(--ink-primary)] shadow-[var(--glow-soft)]"
            >
              <Icon
                size={16}
                className="mt-px shrink-0"
                style={{ color }}
                aria-hidden
              />
              <span className="flex-1">{t.message}</span>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss"
                className="-m-1 shrink-0 rounded-md p-1 text-[var(--ink-muted)] transition-colors hover:text-[var(--ink-primary)]"
              >
                <X size={14} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

let nextId = 1;

/**
 * Returns a no-op API when there is no provider rather than throwing.
 *
 * A missing toast is a cosmetic problem; a thrown error from a hook called
 * during a mutation callback would take down the page the mutation just
 * succeeded on. The provider wraps the whole app, so this is a guard against a
 * future refactor, not an expected path.
 */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? NOOP;
}

const NOOP: ToastApi = {
  success: () => {},
  error: () => {},
  info: () => {},
};
