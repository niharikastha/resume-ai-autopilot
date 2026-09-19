'use client';

import { useMutation } from '@tanstack/react-query';
import { Download, Eye, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { PdfFrame } from '@/components/pdf-frame';
import { useToast } from '@/components/toast';
import { Button, Card, CardHeader, EmptyState } from '@/components/ui';
import { api, type PreviewResult } from '@/lib/api';
import { saveBlob } from '@/lib/download';

/**
 * The resume as a document, rendered by the code that sends it.
 *
 * NOT A SECOND LAYOUT. Nothing here draws a resume. The server runs the same two
 * functions the apply pipeline runs - `buildResume` then `renderResume` - writes the same
 * docx and converts it with the same LibreOffice, and this shows the pdf that came out.
 * A resume drawn in HTML beside the editor would have been easier and would have been a
 * second implementation of the template: right on the day it was written, and quietly
 * different from what the employer opens a month later.
 *
 * ON SCREEN THE WHOLE TIME, and re-rendered on every save. It was behind a button first,
 * on the reasoning that a docx write plus a LibreOffice conversion is too slow to do
 * often - and that was the wrong trade. Editing pieces without the document in view is
 * editing blind: the candidate cannot see that a bullet now wraps onto a third line or
 * that a section has pushed onto a second page, which are the only reasons to want a
 * preview at all. `version` is bumped by the page after every successful write, and the
 * conversion (about a second) happens while the reader is still looking at the piece they
 * just changed.
 *
 * The button remains, because a render can fail on its own - LibreOffice absent, a file
 * locked - and because "re-render this" is the obvious thing to reach for when the
 * document on screen looks wrong.
 */
export function PreviewPane({
  resumeId,
  /** Bumped by the editor whenever a piece is saved, added or removed. */
  version = 0,
}: {
  resumeId: string;
  version?: number;
}) {
  const toast = useToast();
  const [result, setResult] = useState<PreviewResult | null>(null);
  /** Changes on every completed render, so PdfFrame re-fetches the overwritten file. */
  const [stamp, setStamp] = useState(0);

  const render = useMutation({
    mutationFn: () =>
      api.post<PreviewResult>(`/api/me/resume-preview/${resumeId}`),
    onSuccess: (rendered) => {
      setResult(rendered);
      setStamp(Date.now());
      if (!rendered.pdf) {
        toast.error(
          'The Word file was written but could not be converted to a pdf on this ' +
            'machine. Download it to see the document.',
        );
      }
    },
    onError: (err) => toast.error((err as Error).message),
  });

  // What has already been asked for, so this renders once per change rather than once per
  // React pass - and, in development, not twice for the same version when effects are
  // deliberately run twice.
  const asked = useRef<string | null>(null);
  const { mutate } = render;

  useEffect(() => {
    const wanted = `${resumeId}:${version}`;
    if (asked.current === wanted) return;
    asked.current = wanted;
    mutate();
  }, [resumeId, version, mutate]);

  const download = useMutation({
    mutationFn: async (format: 'pdf' | 'docx') => {
      const blob = await api.blob(
        `/api/me/resume-preview/${resumeId}/${format}`,
      );
      saveBlob(blob, `${result?.label ?? 'resume'}.${format}`);
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <Card>
      <CardHeader
        title="How it looks"
        subtitle="Rendered by the same code that writes the file an employer receives — this is the document, not an impression of it. It re-renders every time you save a piece."
        action={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              icon={Download}
              busy={download.isPending}
              onClick={() => download.mutate('docx')}
            >
              Word file
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={RefreshCw}
              busy={render.isPending}
              onClick={() => render.mutate()}
              aria-label="Render the document again"
            />
          </div>
        }
      />

      <div className="px-5 pb-5">
        {result && !result.pdf ? (
          <EmptyState
            icon={Eye}
            title="Rendered, but there is no pdf to show"
            detail="LibreOffice is not available here, so only the Word file was written. It is the same document — download it above."
          />
        ) : (
          <>
            <PdfFrame
              // Null until the first render has finished, or the GET would 404 on a file
              // that does not exist yet.
              path={stamp > 0 ? `/api/me/resume-preview/${resumeId}/pdf` : null}
              reloadKey={stamp}
              title="Your resume as it will be sent"
              pendingLabel="Rendering the document"
              className="h-[calc(100vh-17rem)] min-h-[32rem] w-full"
            />
            <p className="mt-2 text-xs text-[var(--ink-muted)]">
              {render.isPending
                ? 'Re-rendering…'
                : result
                  ? `${result.atomCount} piece${result.atomCount === 1 ? '' : 's'}, rendered ${new Date(
                      result.renderedAt,
                    ).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}.`
                  : 'Rendering the document…'}
            </p>
          </>
        )}
      </div>
    </Card>
  );
}
