'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  CircleAlert,
  FileText,
  Pencil,
  Trash2,
  Upload,
} from 'lucide-react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { PageHeader } from '@/components/shell';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorNote,
  SkeletonCard,
  controlClass,
} from '@/components/ui';
import { useToast } from '@/components/toast';
import { api, type ResumeSummary, type UploadResult } from '@/lib/api';
import { cn, relativeTime } from '@/lib/utils';
import { KIND_LABEL, KIND_ORDER } from './kinds';
import { ReviewStep } from './review';

/** 5 MB, matching MAX_RESUME_BYTES on the server. Checked here as well so a
 *  20 MB scan fails instantly with a readable reason instead of after the
 *  upload. */
const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPT = '.pdf,.txt,.md';

/**
 * The resume library.
 *
 * A candidate ends up with several resumes - a general one, one leaning on the
 * data work, one written for a specific kind of role - and the question that
 * actually matters is WHICH ONE the daily run uses. That is what "In use" is:
 * one resume per account, enforced in the database by a partial unique index, so
 * matching and tailoring never have to guess and never silently pick.
 *
 * Adding one takes two steps on purpose. The file goes up and comes back as a
 * list of pieces; nothing is saved until those pieces have been looked at. See
 * review.tsx.
 */
export default function ResumesPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<UploadResult | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['me', 'resumes'],
    queryFn: () => api.get<ResumeSummary[]>('/api/me/resumes'),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['me', 'resumes'] });
    // The overview card names the selected resume, so it is stale the moment any
    // of this changes.
    void qc.invalidateQueries({ queryKey: ['me', 'overview'] });
  };

  const upload = useMutation({
    mutationFn: (file: File) =>
      api.upload<UploadResult>('/api/me/resumes/upload', file),
    onSuccess: (result) => setPending(result),
    onError: (err) => toast.error((err as Error).message),
  });

  const activate = useMutation({
    mutationFn: (id: string) => api.patch<void>(`/api/me/resumes/${id}/active`),
    onSuccess: () => {
      toast.success('That is the resume every run will use from now on.');
      refresh();
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const rename = useMutation({
    mutationFn: (input: { id: string; label: string }) =>
      api.patch<void>(`/api/me/resumes/${input.id}`, { label: input.label }),
    onSuccess: () => {
      setRenaming(null);
      toast.success('Renamed.');
      refresh();
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const remove = useMutation({
    mutationFn: (input: { id: string; force: boolean }) =>
      api.del<{ promoted: string | null }>(
        `/api/me/resumes/${input.id}?force=${input.force}`,
      ),
    onSuccess: (result) => {
      setConfirmDelete(null);
      toast.success(
        result?.promoted
          ? 'Deleted. Your next most recent resume is now the one in use.'
          : 'Deleted.',
      );
      refresh();
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const pick = (file: File | null | undefined) => {
    if (!file) return;
    if (file.size === 0) {
      toast.error('That file is empty.');
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error(
        `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 5 MB — a resume that large is usually a scan, which cannot be read as text anyway.`,
      );
      return;
    }
    upload.mutate(file);
  };

  // The confirmation step replaces the list rather than sitting beside it. It is
  // a long form and the decision it asks for - are these pieces right - is the
  // only thing on screen worth attention while it is open.
  if (pending) {
    return (
      <>
        <PageHeader
          title="New resume"
          subtitle="Read by a parser, which gets things wrong. This is where you fix them."
        />
        <ReviewStep
          upload={pending}
          onCancel={() => setPending(null)}
          onSaved={(label) => {
            setPending(null);
            toast.success(`"${label}" saved, and it is now the one in use.`);
            refresh();
          }}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Resumes"
        subtitle="Upload as many as you like. One of them is the one every daily run uses — you choose which."
      >
        <div className="flex items-center gap-3">
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              pick(e.target.files?.[0]);
              // Cleared so choosing the same file twice fires a change event the
              // second time too.
              e.target.value = '';
            }}
          />
          <Button
            variant="primary"
            icon={Upload}
            busy={upload.isPending}
            onClick={() => fileInput.current?.click()}
          >
            {upload.isPending ? 'Reading it…' : 'Add a resume'}
          </Button>
        </div>
      </PageHeader>

      <div className="max-w-4xl space-y-4 px-4 pb-10 sm:px-6">
        {list.isLoading && <SkeletonCard rows={3} />}
        {list.error && <ErrorNote message={(list.error as Error).message} />}

        {list.data?.length === 0 && (
          <Card>
            <EmptyState
              icon={FileText}
              title="No resumes yet"
              detail="Upload a PDF, or a plain text file if you have one. It gets split into your jobs, what you did, your skills and your education — and you get to correct all of it before anything is saved."
              action={
                <Button
                  variant="primary"
                  icon={Upload}
                  onClick={() => fileInput.current?.click()}
                >
                  Add a resume
                </Button>
              }
            />
          </Card>
        )}

        {list.data?.map((resume) => (
          <Card key={resume.id} glow={resume.isActive}>
            <CardHeader
              title={resume.label}
              subtitle={
                resume.filename ??
                'Added from the command line, before this screen existed.'
              }
              action={
                resume.isActive ? (
                  <Badge tone="accent">In use</Badge>
                ) : (
                  <Button size="sm" onClick={() => activate.mutate(resume.id)}>
                    Use this one
                  </Button>
                )
              }
            />

            <div className="space-y-3 px-5 py-4">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-[var(--ink-muted)]">
                {KIND_ORDER.map((kind) => (
                  <span key={kind}>
                    <span className="font-medium text-[var(--ink-secondary)]">
                      {resume.counts[kind]}
                    </span>{' '}
                    {KIND_LABEL[kind].toLowerCase()}
                  </span>
                ))}
                <span>
                  <span className="font-medium text-[var(--ink-secondary)]">
                    {resume.techCount}
                  </span>{' '}
                  technologies found
                </span>
              </div>

              <div className="flex items-center gap-2 text-xs">
                {resume.confirmedAt ? (
                  <CheckCircle2
                    size={13}
                    style={{ color: 'var(--status-good)' }}
                    aria-hidden
                  />
                ) : (
                  <CircleAlert
                    size={13}
                    style={{ color: 'var(--status-warning)' }}
                    aria-hidden
                  />
                )}
                <span className="text-[var(--ink-secondary)]">
                  {resume.confirmedAt
                    ? `Confirmed ${relativeTime(resume.confirmedAt)}`
                    : 'Never confirmed, so nothing will use it'}
                </span>
                <span className="text-[var(--ink-muted)]">
                  · changed {relativeTime(resume.updatedAt)}
                </span>
                {resume.variantCount > 0 && (
                  <span className="text-[var(--ink-muted)]">
                    · {resume.variantCount} tailored from it
                  </span>
                )}
              </div>

              {renaming?.id === resume.id ? (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    className={cn(controlClass, 'w-full max-w-xs')}
                    value={renaming.value}
                    maxLength={60}
                    autoFocus
                    onChange={(e) =>
                      setRenaming({ id: resume.id, value: e.target.value })
                    }
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    busy={rename.isPending}
                    onClick={() =>
                      rename.mutate({
                        id: resume.id,
                        label: renaming.value.trim(),
                      })
                    }
                  >
                    Save name
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setRenaming(null)}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/app/resumes/${resume.id}`}>
                    <Button size="sm" icon={Pencil}>
                      Edit the pieces
                    </Button>
                  </Link>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setRenaming({ id: resume.id, value: resume.label })
                    }
                  >
                    Rename
                  </Button>
                  {confirmDelete === resume.id ? (
                    <>
                      <Button
                        size="sm"
                        variant="danger"
                        busy={remove.isPending}
                        onClick={() =>
                          remove.mutate({
                            id: resume.id,
                            force: resume.variantCount > 0,
                          })
                        }
                      >
                        {resume.variantCount > 0
                          ? `Delete it and ${resume.variantCount} tailored resume${resume.variantCount === 1 ? '' : 's'}`
                          : 'Yes, delete it'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmDelete(null)}
                      >
                        Keep it
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={Trash2}
                      onClick={() => setConfirmDelete(resume.id)}
                    >
                      Delete
                    </Button>
                  )}
                </div>
              )}
            </div>
          </Card>
        ))}

        {list.data && list.data.length > 0 && (
          <p className="px-1 text-xs leading-relaxed text-[var(--ink-muted)]">
            Only the resume marked <span className="font-medium">In use</span> is
            read by the daily matching and tailoring run. The others are kept as
            they are — nothing happens to them, and nothing is generated from
            them.
          </p>
        )}
      </div>
    </>
  );
}
