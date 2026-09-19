'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { ErrorNote, Spinner } from '@/components/ui';
import { api } from '@/lib/api';

/**
 * A pdf the API holds, on screen.
 *
 * WHY NOT `<iframe src="http://api/...">`. The session is an HttpOnly cookie on the API's
 * origin and the app is served from another one, so a cross-origin frame src is not
 * guaranteed to carry it - the candidate would get the API's 401 page where their resume
 * should be. So the file is fetched exactly the way every other call is made, turned into
 * an object URL, and framed from memory. `lib/download.ts` says the same thing about
 * saving one.
 *
 * THE OBJECT URL IS RELEASED on every change and on unmount. It pins the whole pdf in
 * memory for as long as it exists, and this component is re-pointed every time a resume is
 * re-rendered - ten renders while editing would otherwise leave ten copies of somebody's
 * address alive in the tab. `gcTime: 0` is the other half of that: React Query must not
 * keep a blob of somebody's resume in its cache after the screen showing it has gone.
 *
 * `reloadKey` is how a caller says "the file at this path has changed". The path alone
 * cannot say it: a re-render overwrites the same preview file, so nothing in the URL
 * differs and without this the frame would go on showing the previous document.
 *
 * A NULL PATH IS "not yet", not "nothing". The editor's preview has to be rendered before
 * it can be fetched, and a component that fetched anyway would show the server's 404 for
 * the second between the two requests.
 */
export function PdfFrame({
  path,
  reloadKey,
  title,
  className,
  pendingLabel = 'Loading the document',
}: {
  path: string | null;
  reloadKey?: string | number;
  title: string;
  className?: string;
  pendingLabel?: string;
}) {
  const file = useQuery({
    queryKey: ['pdf-frame', path, reloadKey],
    queryFn: async () => {
      if (!path) throw new Error('there is no document to show');
      return api.blob(path);
    },
    enabled: path !== null,
    gcTime: 0,
    retry: false,
  });

  const url = useMemo(
    () => (file.data ? URL.createObjectURL(file.data) : null),
    [file.data],
  );

  useEffect(() => {
    if (!url) return;
    return () => URL.revokeObjectURL(url);
  }, [url]);

  if (file.error) return <ErrorNote message={(file.error as Error).message} />;

  if (!url) {
    return (
      <div
        className={`flex items-center justify-center rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--surface-hover)] ${className ?? ''}`}
      >
        <Spinner label={pendingLabel} />
      </div>
    );
  }

  return (
    <iframe
      // Keyed on the url so a new document replaces the frame rather than asking the
      // built-in pdf viewer to swap its source, which some builds of Chrome ignore.
      key={url}
      src={url}
      title={title}
      className={`rounded-[var(--r-sm)] border border-[var(--border)] bg-white ${className ?? ''}`}
    />
  );
}
