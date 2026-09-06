import type { ReactNode } from 'react';
import { Shell } from '@/components/shell';

/** Candidate shell. Open to both roles - an admin uses these screens for their
 *  own job search rather than a duplicate set. */
export default function CandidateLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <Shell>{children}</Shell>;
}
