'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { ApiError, api, type SessionUser } from './api';

interface AuthValue {
  user: SessionUser | null;
  loading: boolean;
  isAdmin: boolean;
  login: (email: string, password: string) => Promise<SessionUser>;
  logout: () => Promise<void>;
  /** Re-read /me from the server. For the cases where the session changed
   *  underneath us - a password reset revoking everything, for instance - and
   *  the cached user is no longer something the server would agree with. */
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: async () => {
      try {
        return (await api.get<{ user: SessionUser }>('/api/auth/me')).user;
      } catch (err) {
        // A 401 here is the normal "not signed in" state, not an error worth
        // retrying or surfacing.
        if (err instanceof ApiError && err.isAuth) return null;
        throw err;
      }
    },
    retry: false,
    staleTime: 60_000,
  });

  const login = useCallback(
    async (email: string, password: string) => {
      const { user } = await api.post<{ user: SessionUser }>(
        '/api/auth/login',
        { email, password },
      );
      queryClient.setQueryData(['auth', 'me'], user);
      return user;
    },
    [queryClient],
  );

  const refreshUser = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
  }, [queryClient]);

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout');
    // Everything cached was fetched as this user. Clearing rather than
    // invalidating means the next account cannot briefly see stale data from
    // the previous one.
    queryClient.clear();
    queryClient.setQueryData(['auth', 'me'], null);
  }, [queryClient]);

  const user = data ?? null;

  return (
    <AuthContext.Provider
      value={{
        user,
        loading: isLoading,
        isAdmin: user?.role === 'ADMIN',
        login,
        logout,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
