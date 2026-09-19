'use client';

import { useMutation } from '@tanstack/react-query';
import { Download, Eye, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
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
 * RENDERED ON A CLICK, never automatically. A render is a docx write plus a LibreOffice
 * conversion - a couple of seconds - and doing that after every keystroke in the editor
 * below would make typing feel broken. The button says what it costs.
 */
export function PreviewPane({ resumeId }: { resumeId: string }) {
  const toast = useToast();
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  // The object URL holds the pdf in memory for as long as it exists, so the PREVIOUS one
  // is released whenever this changes and the last one is released on unmount. Without
  // this, re-rendering the preview ten times keeps ten pdfs of somebody's resume alive
  // in the tab.
  useEffect(() => {
    if (!url) return;
    return () => URL.revokeObjectURL(url);
  }, [url]);

  const render = useMutation({
    mutationFn: async () => {
      const rendered = await api.post<PreviewResult>(
        `/api/me/resume-preview/${resumeId}`,
      );
      // Two requests on purpose: the POST does the slow work and says what came out, and
      // the file is only fetched when there is one. A GET that rendered on the way past
      // would hold the connection open for the whole conversion.
      const pdf = rendered.pdf
        ? await api.blob(`/api/me/resume-preview/${resumeId}/pdf`)
        : null;
      return { rendered, pdf };
    },
    onSuccess: ({ rendered, pdf }) => {
      setResult(rendered);
      setUrl(pdf ? URL.createObjectURL(pdf) : null);
      if (!rendered.pdf) {
        toast.error(
          'The Word file was written but could not be converted to a pdf on this ' +
            'machine. Download it to see the document.',
        );
      }
    },
    onError: (err) => toast.error((err as Error).message),
  });

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
        subtitle="Rendered by the same code that writes the file an employer receives — this is the document, not an impression of it."
        action={
          <div className="flex items-center gap-2">
            {result && (
              <Button
                size="sm"
                icon={Download}
                busy={download.isPending}
                onClick={() => download.mutate('docx')}
              >
                Word file
              </Button>
            )}
            <Button
              size="sm"
              variant={result ? 'secondary' : 'primary'}
              icon={result ? RefreshCw : Eye}
              busy={render.isPending}
              onClick={() => render.mutate()}
            >
              {result ? 'Render again' : 'Show the document'}
            </Button>
          </div>
        }
      />

      {url ? (
        <div className="px-5 pb-5">
          <iframe
            // `key` on the url so a new render replaces the frame rather than asking the
            // pdf viewer to swap its source, which some builds of Chrome ignore.
            key={url}
            src={url}
            title="Your resume as it will be sent"
            className="h-[70vh] w-full rounded-[var(--r-sm)] border border-[var(--border)] bg-white"
          />
          <p className="mt-2 text-xs text-[var(--ink-muted)]">
            {result?.atomCount} piece{result?.atomCount === 1 ? '' : 's'},
            rendered{' '}
            {result
              ? new Date(result.renderedAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : ''}
            . Edit a piece below, then render again to see it change.
          </p>
        </div>
      ) : (
        <EmptyState
          icon={Eye}
          title={
            result
              ? 'Rendered, but there is no pdf to show'
              : 'Nothing rendered yet'
          }
          detail={
            result
              ? 'LibreOffice is not available here, so only the Word file was written. It is the same document — download it above.'
              : 'Takes a couple of seconds: the Word file is written and then converted, exactly as it is for a real application.'
          }
        />
      )}
    </Card>
  );
}
