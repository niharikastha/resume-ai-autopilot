'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Spinner } from '@/components/ui';
import { useAuth } from '@/lib/auth-context';

/** Role decides the landing page, so neither role has to navigate past a screen
 *  that is not theirs. */
export default function Home() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) router.replace('/login');
    else router.replace(user.role === 'ADMIN' ? '/admin' : '/app');
  }, [loading, user, router]);

  return <Spinner />;
}
