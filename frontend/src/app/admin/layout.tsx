import type { ReactNode } from 'react';
import { Shell } from '@/components/shell';

/** Admin shell. requireAdmin only avoids rendering a page a USER cannot read -
 *  the refusal that matters happens at the API. */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return <Shell requireAdmin>{children}</Shell>;
}
