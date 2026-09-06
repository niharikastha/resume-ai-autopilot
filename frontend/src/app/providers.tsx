'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { useState, type ReactNode } from 'react';
import { ToastProvider } from '@/components/toast';
import { ApiError } from '@/lib/api';
import { AuthProvider } from '@/lib/auth-context';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            // 401 and 403 are answers, not transient failures. Retrying them
            // just delays the redirect and triples the log noise.
            retry: (attempt, error) =>
              error instanceof ApiError && (error.isAuth || error.isForbidden)
                ? false
                : attempt < 2,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      {/* Dark by default rather than "system". The theme is designed dark-first
          - the light steps are a re-validated alternate, not the reference - so
          the default should be the one that was designed, not whatever the OS
          happens to say. `light` is in the value list explicitly because
          next-themes otherwise only emits a class for non-default themes, and
          globals.css keys its light overrides off `.light`. */}
      <ThemeProvider
        attribute="class"
        defaultTheme="dark"
        enableSystem={false}
        themes={['dark', 'light']}
        disableTransitionOnChange
      >
        <ToastProvider>
          <AuthProvider>{children}</AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
