'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Clock, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { PageHeader } from '@/components/shell';
import { useToast } from '@/components/toast';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ErrorNote,
  SkeletonCard,
  controlClass,
} from '@/components/ui';
import { api, type AtomKind, type AtomRow, type ResumeSummary } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  KIND_HAS_META,
  KIND_HINT,
  KIND_LABEL,
  KIND_ONE,
  KIND_ORDER,
} from '../kinds';

/**
 * Editing the pieces of a saved resume.
 *
 * The uploaded file is never touched. What gets edited here is what was READ out
 * of it - the pieces matching scores and tailoring is allowed to quote - and that
 * distinction is the point: rewriting the PDF would leave the pipeline reading
 * the old text, and rewriting the pieces without saying so would leave the
 * candidate thinking their file had changed.
 *
 * Every save re-embeds. A piece whose words changed keeps a vector describing
 * the old wording until it is redone, and a stale vector does not look wrong from
 * the outside - the scores stay plausible and are simply about a sentence that no
 * longer exists. The server handles it; the "waiting for indexing" note below is
 * what makes the gap visible while it happens.
 */
export default function ResumeEditorPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const toast = useToast();
  const qc = useQueryClient();
  const [adding, setAdding] = useState<AtomKind | null>(null);

  const resumes = useQuery({
    queryKey: ['me', 'resumes'],
    queryFn: () => api.get<ResumeSummary[]>('/api/me/resumes'),
  });
  const resume = resumes.data?.find((r) => r.id === id);

  const atoms = useQuery({
    queryKey: ['me', 'resumes', id, 'atoms'],
    queryFn: () => api.get<AtomRow[]>(`/api/me/resumes/${id}/atoms`),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['me', 'resumes', id, 'atoms'] });
    void qc.invalidateQueries({ queryKey: ['me', 'resumes'] });
  };

  const update = useMutation({
    mutationFn: (input: {
      atomId: string;
      text: string;
      employer: string | null;
      dateRange: string | null;
    }) =>
      api.patch<AtomRow>(`/api/me/resumes/${id}/atoms/${input.atomId}`, {
        text: input.text,
        employer: input.employer,
        dateRange: input.dateRange,
      }),
    onSuccess: () => {
      toast.success('Saved.');
      refresh();
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const create = useMutation({
    mutationFn: (input: {
      kind: AtomKind;
      text: string;
      employer: string | null;
      dateRange: string | null;
    }) => api.post<AtomRow>(`/api/me/resumes/${id}/atoms`, input),
    onSuccess: () => {
      setAdding(null);
      toast.success('Added.');
      refresh();
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const destroy = useMutation({
    mutationFn: (atomId: string) =>
      api.del<void>(`/api/me/resumes/${id}/atoms/${atomId}`),
    onSuccess: () => {
      toast.success('Removed.');
      refresh();
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <>
      <PageHeader
        title={resume ? resume.label : 'Resume'}
        subtitle="What was read out of your file. Your original upload is left exactly as it is — only these pieces change, and these are what applications are built from."
      >
        <div className="flex items-center gap-3">
          {resume?.isActive && <Badge tone="accent">In use</Badge>}
          <Link href="/app/resumes">
            <Button size="sm" icon={ArrowLeft}>
              All resumes
            </Button>
          </Link>
        </div>
      </PageHeader>

      <div className="max-w-4xl space-y-4 px-4 pb-10 sm:px-6">
        {(atoms.isLoading || resumes.isLoading) && <SkeletonCard rows={4} />}
        {atoms.error && <ErrorNote message={(atoms.error as Error).message} />}

        {atoms.data &&
          KIND_ORDER.map((kind) => {
            const group = atoms.data.filter((a) => a.kind === kind);
            return (
              <Card key={kind}>
                <CardHeader
                  title={KIND_LABEL[kind]}
                  subtitle={KIND_HINT[kind]}
                  action={<Badge>{group.length}</Badge>}
                />
                <div className="divide-y divide-[var(--border)]">
                  {group.map((atom) => (
                    <AtomEditor
                      // The stored VALUES are part of the key, not just the id.
                      // A save comes back through the query and has to reset the
                      // boxes below; keying on the values remounts exactly the
                      // piece that changed, which is React's own answer to
                      // "reset state when a prop changes" and avoids an effect
                      // that writes state on every render pass.
                      key={`${atom.id}|${atom.text}|${atom.employer ?? ''}|${atom.dateRange ?? ''}`}
                      atom={atom}
                      busy={update.isPending || destroy.isPending}
                      onSave={(change) =>
                        update.mutate({ atomId: atom.id, ...change })
                      }
                      onDelete={() => destroy.mutate(atom.id)}
                    />
                  ))}
                  {group.length === 0 && (
                    <p className="px-5 py-4 text-xs text-[var(--ink-muted)]">
                      Nothing here yet.
                    </p>
                  )}
                </div>

                <div className="border-t border-[var(--border)] px-5 py-3">
                  {adding === kind ? (
                    <NewAtom
                      kind={kind}
                      busy={create.isPending}
                      onCancel={() => setAdding(null)}
                      onAdd={(input) => create.mutate({ kind, ...input })}
                    />
                  ) : (
                    <Button size="sm" icon={Plus} onClick={() => setAdding(kind)}>
                      Add a {KIND_ONE[kind]}
                    </Button>
                  )}
                </div>
              </Card>
            );
          })}

        <p className="px-1 text-xs leading-relaxed text-[var(--ink-muted)]">
          The technologies listed under each piece are worked out from its words,
          not typed in — they are the list a tailored version is allowed to
          mention, so a tag your own sentence does not support is not something
          this screen can add.
        </p>
      </div>
    </>
  );
}

function AtomEditor({
  atom,
  busy,
  onSave,
  onDelete,
}: {
  atom: AtomRow;
  busy: boolean;
  onSave: (change: {
    text: string;
    employer: string | null;
    dateRange: string | null;
  }) => void;
  onDelete: () => void;
}) {
  const [text, setText] = useState(atom.text);
  const [employer, setEmployer] = useState(atom.employer ?? '');
  const [dateRange, setDateRange] = useState(atom.dateRange ?? '');
  const [confirming, setConfirming] = useState(false);

  const dirty =
    text !== atom.text ||
    employer !== (atom.employer ?? '') ||
    dateRange !== (atom.dateRange ?? '');

  return (
    <div className="space-y-2 px-5 py-3.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          {atom.kind === 'SKILL' ? (
            <input
              className={cn(controlClass, 'w-full')}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          ) : (
            <textarea
              className={cn(controlClass, 'w-full resize-y leading-relaxed')}
              rows={Math.min(6, Math.max(2, Math.ceil(text.length / 90)))}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          )}
          {KIND_HAS_META[atom.kind] && (
            <div className="flex flex-wrap gap-2">
              <input
                className={cn(controlClass, 'w-full max-w-[15rem] text-xs')}
                placeholder="Employer or project"
                value={employer}
                onChange={(e) => setEmployer(e.target.value)}
              />
              <input
                className={cn(controlClass, 'w-full max-w-[12rem] text-xs')}
                placeholder="Dates"
                value={dateRange}
                onChange={(e) => setDateRange(e.target.value)}
              />
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {dirty && (
            <Button
              size="sm"
              variant="primary"
              busy={busy}
              disabled={text.trim().length < 2}
              onClick={() =>
                onSave({
                  text: text.trim(),
                  employer: employer.trim() || null,
                  dateRange: dateRange.trim() || null,
                })
              }
            >
              Save
            </Button>
          )}
          {confirming ? (
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="danger"
                busy={busy}
                onClick={() => {
                  setConfirming(false);
                  onDelete();
                }}
              >
                Remove
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirming(false)}
              >
                Keep
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              icon={Trash2}
              aria-label="Remove this piece"
              onClick={() => setConfirming(true)}
            />
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {atom.tech.map((tech) => (
          <span
            key={tech}
            className="rounded-[var(--r-full)] bg-[var(--surface-hover)] px-2 py-0.5 text-[10px] text-[var(--ink-muted)] ring-1 ring-[var(--border)] ring-inset"
          >
            {tech}
          </span>
        ))}
        {atom.metrics.map((metric) => (
          <span
            key={metric}
            className="rounded-[var(--r-full)] px-2 py-0.5 text-[10px] text-[var(--ink-secondary)]"
            style={{
              background: 'color-mix(in srgb, var(--accent-cyan) 12%, transparent)',
            }}
            title="A number from your own words. Only these may be repeated on an application."
          >
            {metric}
          </span>
        ))}
        {!atom.embeddedTextHash && (
          <span className="flex items-center gap-1 text-[10px] text-[var(--ink-muted)]">
            <Clock size={10} aria-hidden />
            waiting to be indexed — matching cannot see it yet
          </span>
        )}
      </div>
    </div>
  );
}

function NewAtom({
  kind,
  busy,
  onAdd,
  onCancel,
}: {
  kind: AtomKind;
  busy: boolean;
  onAdd: (input: {
    text: string;
    employer: string | null;
    dateRange: string | null;
  }) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const [employer, setEmployer] = useState('');
  const [dateRange, setDateRange] = useState('');

  return (
    <div className="space-y-2">
      {kind === 'SKILL' ? (
        <input
          className={cn(controlClass, 'w-full')}
          placeholder="e.g. PostgreSQL"
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
        />
      ) : (
        <textarea
          className={cn(controlClass, 'w-full resize-y leading-relaxed')}
          rows={2}
          placeholder={`In your own words — this is quoted, never invented.`}
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
        />
      )}
      {KIND_HAS_META[kind] && (
        <div className="flex flex-wrap gap-2">
          <input
            className={cn(controlClass, 'w-full max-w-[15rem] text-xs')}
            placeholder="Employer or project"
            value={employer}
            onChange={(e) => setEmployer(e.target.value)}
          />
          <input
            className={cn(controlClass, 'w-full max-w-[12rem] text-xs')}
            placeholder="Dates"
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value)}
          />
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          busy={busy}
          disabled={text.trim().length < 2}
          onClick={() =>
            onAdd({
              text: text.trim(),
              employer: employer.trim() || null,
              dateRange: dateRange.trim() || null,
            })
          }
        >
          Add it
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
