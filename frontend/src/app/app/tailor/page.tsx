'use client';

/**
 * One job description in, one resume for that job out.
 *
 * WHAT THIS IS NOT. It is not a second resume editor and it does not draw a resume. The
 * server runs the same prompt, the same provenance guard, the same `buildResume` and the
 * same `renderResume` that a real application goes through - so the file downloaded here
 * is the file an employer would have received, in the same template, and nothing about
 * the layout is decided on this page.
 *
 * WHY THE GUARD RESULT IS ON SCREEN. A tailored resume that fails the guard is not
 * silently discarded and it is not silently sent: the server writes the BASE resume
 * instead and records why the rewrite was rejected. Hiding that would mean a candidate
 * downloading an untailored resume believing it had been tailored, so the failure and its
 * reasons are shown as plainly as the success.
 *
 * WHY THERE IS A HISTORY. Tailoring costs a deep model call and a LibreOffice conversion,
 * and the thing people actually do is come back to a resume they made last week for an
 * interview this week. Every run is kept with the description it was written against,
 * re-downloadable, until it is deleted here.
 */

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileText,
  Search,
  Trash2,
  Wand2,
} from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/shell';
import { useToast } from '@/components/toast';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  controlClass,
  EmptyState,
  ErrorNote,
  SkeletonCard,
} from '@/components/ui';
import {
  api,
  type JobRow,
  type ResumeSummary,
  type TailoredSummary,
} from '@/lib/api';
import { saveBlob } from '@/lib/download';
import { relativeTime } from '@/lib/utils';

/**
 * The shortest pasted description the server will accept - it rejects anything under
 * this, so the number is repeated here to say so before the request is made rather than
 * after. Kept in step with MIN_JD_CHARS in backend/src/tailoring/on-demand.service.ts.
 */
const MIN_JD = 120;

/** Postings offered in the picker at a time. A search narrows it; nobody scrolls 200. */
const JOB_LIMIT = 20;

export default function TailorPage() {
  const toast = useToast();
  const qc = useQueryClient();

  const [resumeId, setResumeId] = useState<string>('');
  const [mode, setMode] = useState<'pick' | 'paste'>('pick');
  const [jobId, setJobId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [jdText, setJdText] = useState('');
  const [title, setTitle] = useState('');
  const [company, setCompany] = useState('');
  const [result, setResult] = useState<TailoredSummary | null>(null);

  const resumes = useQuery({
    queryKey: ['me', 'resumes'],
    queryFn: () => api.get<ResumeSummary[]>('/api/me/resumes'),
  });

  // The one in use, unless the reader has chosen otherwise. Not held in state on load,
  // because a default written into state before the list arrives is a default that
  // silently stays empty when the list is slow.
  const usable = (resumes.data ?? []).filter(
    (r) => r.confirmedAt && r.atomCount > 0,
  );
  const chosen =
    usable.find((r) => r.id === resumeId) ??
    usable.find((r) => r.isActive) ??
    usable[0];

  const jobs = useQuery({
    queryKey: ['me', 'jobs', 'tailor-picker', q],
    queryFn: () =>
      api.get<{ total: number; items: JobRow[] }>(
        `/api/me/jobs?limit=${JOB_LIMIT}&only=suits${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`,
      ),
    placeholderData: keepPreviousData,
    enabled: mode === 'pick',
  });
  const postings = jobs.data?.items;

  const history = useQuery({
    queryKey: ['me', 'tailor', chosen?.id ?? null],
    queryFn: () =>
      api.get<TailoredSummary[]>(
        chosen ? `/api/me/tailor?resumeId=${chosen.id}` : '/api/me/tailor',
      ),
    enabled: !resumes.isLoading,
  });

  const picked = postings?.find((j) => j.id === jobId) ?? null;
  const ready = Boolean(
    chosen && (mode === 'pick' ? jobId : jdText.trim().length >= MIN_JD),
  );

  const run = useMutation({
    mutationFn: () =>
      api.post<TailoredSummary>('/api/me/tailor', {
        resumeId: chosen?.id,
        ...(mode === 'pick'
          ? { jobId }
          : {
              jdText: jdText.trim(),
              title: title.trim() || undefined,
              company: company.trim() || undefined,
            }),
      }),
    onSuccess: (data) => {
      setResult(data);
      void qc.invalidateQueries({ queryKey: ['me', 'tailor'] });
      void qc.invalidateQueries({ queryKey: ['me', 'resumes'] });
      if (data.guardPassed) toast.success('Tailored. The file is ready below.');
      else
        toast.error(
          'The tailored wording was rejected — your base resume was written instead. ' +
            'The reasons are below.',
        );
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <>
      <PageHeader
        title="Tailor to a job"
        subtitle="Point it at a description and it rewrites the wording of your own pieces for that job — the same template, the same file an employer would open, nothing invented."
      />

      <div className="max-w-4xl space-y-4 px-4 pb-10 sm:px-6">
        {resumes.isLoading && <SkeletonCard rows={3} />}
        {resumes.error && (
          <ErrorNote message={(resumes.error as Error).message} />
        )}

        {resumes.data && usable.length === 0 && (
          <Card>
            <EmptyState
              icon={FileText}
              title="No resume to tailor yet"
              detail="Upload one under Resumes and confirm what was read out of it — the pieces are what a tailored version is allowed to quote."
            />
          </Card>
        )}

        {chosen && (
          <>
            <Card>
              <CardHeader
                title="Which resume"
                subtitle="Only the pieces of this resume may appear in the tailored one."
                action={
                  <select
                    className={controlClass}
                    value={chosen.id}
                    onChange={(e) => {
                      setResumeId(e.target.value);
                      setResult(null);
                    }}
                    aria-label="Resume to tailor"
                  >
                    {usable.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                        {r.isActive ? ' (in use)' : ''} — {r.atomCount} pieces
                      </option>
                    ))}
                  </select>
                }
              />
            </Card>

            <Card>
              <CardHeader
                title="The job"
                subtitle="Pick one of the postings found for you, or paste a description from anywhere."
                action={
                  <div className="flex items-center gap-1 rounded-[var(--r-full)] bg-[var(--surface-hover)] p-1">
                    <Button
                      size="sm"
                      variant={mode === 'pick' ? 'primary' : 'ghost'}
                      onClick={() => setMode('pick')}
                    >
                      One of my jobs
                    </Button>
                    <Button
                      size="sm"
                      variant={mode === 'paste' ? 'primary' : 'ghost'}
                      onClick={() => setMode('paste')}
                    >
                      Paste a description
                    </Button>
                  </div>
                }
              />

              <div className="space-y-3 px-5 pb-5">
                {mode === 'pick' ? (
                  <>
                    <div className="relative">
                      <Search
                        size={14}
                        className="absolute top-1/2 left-3 -translate-y-1/2 text-[var(--ink-muted)]"
                        aria-hidden
                      />
                      <input
                        className={`${controlClass} w-full pl-8`}
                        placeholder="Search your jobs by title"
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        aria-label="Search your jobs"
                      />
                    </div>

                    {jobs.isLoading && <SkeletonCard rows={3} />}
                    {jobs.error && (
                      <ErrorNote message={(jobs.error as Error).message} />
                    )}
                    {postings && postings.length === 0 && (
                      <p className="py-3 text-xs text-[var(--ink-muted)]">
                        Nothing matched. Paste the description instead — it works
                        the same way.
                      </p>
                    )}

                    <ul className="divide-y divide-[var(--border)]">
                      {(postings ?? []).map((job) => (
                        <li key={job.id}>
                          <button
                            type="button"
                            onClick={() => {
                              setJobId(job.id === jobId ? null : job.id);
                              setResult(null);
                            }}
                            className={`flex w-full items-start justify-between gap-3 px-1 py-2.5 text-left ${
                              job.id === jobId
                                ? 'text-[var(--ink-primary)]'
                                : 'text-[var(--ink-secondary)]'
                            }`}
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-sm">
                                {job.title}
                              </span>
                              <span className="block truncate text-xs text-[var(--ink-muted)]">
                                {job.company?.name ?? 'Unknown company'}
                                {job.location ? ` · ${job.location}` : ''}
                              </span>
                            </span>
                            {job.id === jobId && (
                              <Badge tone="accent">Chosen</Badge>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-2">
                      <input
                        className={`${controlClass} w-full max-w-[16rem]`}
                        placeholder="Job title (optional)"
                        value={title}
                        maxLength={200}
                        onChange={(e) => setTitle(e.target.value)}
                        aria-label="Job title"
                      />
                      <input
                        className={`${controlClass} w-full max-w-[16rem]`}
                        placeholder="Company (optional)"
                        value={company}
                        maxLength={200}
                        onChange={(e) => setCompany(e.target.value)}
                        aria-label="Company"
                      />
                    </div>
                    <textarea
                      className={`${controlClass} w-full resize-y leading-relaxed`}
                      rows={10}
                      placeholder="Paste the whole posting — responsibilities and requirements included. The more of it there is, the less guessing there is."
                      value={jdText}
                      maxLength={40_000}
                      onChange={(e) => setJdText(e.target.value)}
                      aria-label="Job description"
                    />
                    <p className="text-xs text-[var(--ink-muted)]">
                      {jdText.trim().length < MIN_JD
                        ? `${MIN_JD - jdText.trim().length} more characters needed — a couple of lines is not enough to tailor against.`
                        : `${jdText.trim().length} characters.`}
                    </p>
                  </>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3 border-t border-[var(--border)] px-5 py-3.5">
                <Button
                  variant="primary"
                  icon={Wand2}
                  busy={run.isPending}
                  disabled={!ready}
                  onClick={() => run.mutate()}
                >
                  Tailor this resume
                </Button>
                <p className="text-xs text-[var(--ink-muted)]">
                  {run.isPending
                    ? 'Reading the description, rewriting your own sentences, then writing the document — about half a minute.'
                    : mode === 'pick' && picked
                      ? `For ${picked.title} at ${picked.company?.name ?? 'that company'}.`
                      : 'Costs one model call. The result is kept below.'}
                </p>
              </div>
            </Card>

            {result && <TailoredCard row={result} />}

            <Card>
              <CardHeader
                title="Tailored earlier"
                subtitle="Every run against this resume, with the description it was written for. Downloadable until you delete it."
              />
              {history.isLoading && <SkeletonCard rows={3} />}
              {history.error && (
                <ErrorNote message={(history.error as Error).message} />
              )}
              {history.data && history.data.length === 0 ? (
                <EmptyState
                  icon={Wand2}
                  title="Nothing tailored yet"
                  detail="The first run appears here as soon as it finishes."
                />
              ) : (
                <div className="divide-y divide-[var(--border)]">
                  {(history.data ?? []).map((row) => (
                    <HistoryRow key={row.id} row={row} />
                  ))}
                </div>
              )}
            </Card>

            <p className="px-1 text-xs leading-relaxed text-[var(--ink-muted)]">
              Tailoring only re-words and re-orders what your resume already
              says. A technology your pieces do not mention, or a number that is
              not in them, is rejected before the document is written — which is
              why a run can come back saying it kept your base resume.
            </p>
          </>
        )}
      </div>
    </>
  );
}

/** The run that just finished, in full: what the guard said, the letter, the files. */
function TailoredCard({ row }: { row: TailoredSummary }) {
  return (
    <Card>
      <CardHeader
        title={row.guardPassed ? 'Ready to download' : 'Tailoring was rejected'}
        subtitle={
          row.guardPassed
            ? `Written for ${row.title}${row.company ? ` at ${row.company}` : ''}. Every sentence in it traces back to a piece of your resume.`
            : 'The rewrite claimed something your pieces do not support, so the file below is your base resume, untailored.'
        }
        icon={row.guardPassed ? CheckCircle2 : AlertTriangle}
        action={<Downloads row={row} />}
      />

      <div className="space-y-3 px-5 pb-5">
        {row.counts && row.guardPassed && (
          <p className="text-xs text-[var(--ink-muted)]">
            {row.counts.selected} pieces used, {row.counts.rewrites} re-worded,{' '}
            {row.counts.numbersChecked} numbers and{' '}
            {row.counts.techTokensChecked} technology mentions checked against
            your own words.
          </p>
        )}

        {row.violations.length > 0 && (
          <ul className="space-y-1.5 rounded-[var(--r-sm)] bg-[var(--surface-hover)] px-3.5 py-2.5">
            {row.violations.map((violation, at) => (
              <li
                key={at}
                className="text-xs leading-relaxed text-[var(--ink-secondary)]"
              >
                {violation}
              </li>
            ))}
          </ul>
        )}

        {row.coverLetter && (
          <div>
            <p className="mb-1.5 text-xs text-[var(--ink-muted)]">
              A cover letter written from the same pieces. Read it before you
              send it anywhere.
            </p>
            <p className="rounded-[var(--r-sm)] border border-[var(--border)] px-3.5 py-3 text-xs leading-relaxed whitespace-pre-wrap text-[var(--ink-secondary)]">
              {row.coverLetter}
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}

function HistoryRow({ row }: { row: TailoredSummary }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [open, setOpen] = useState(false);

  const destroy = useMutation({
    mutationFn: () => api.del<void>(`/api/me/tailor/${row.id}`),
    onSuccess: () => {
      toast.success('Deleted.');
      void qc.invalidateQueries({ queryKey: ['me', 'tailor'] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <div className="px-5 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm text-[var(--ink-primary)]">
            {row.title}
            {row.company ? ` · ${row.company}` : ''}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-[var(--ink-muted)]">
            <span>{relativeTime(row.createdAt)}</span>
            {!row.jobId && <span>pasted description</span>}
            {!row.guardPassed && (
              <Badge tone="warning">base resume — rewrite rejected</Badge>
            )}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Downloads row={row} />
          {confirming ? (
            <>
              <Button
                size="sm"
                variant="danger"
                busy={destroy.isPending}
                onClick={() => {
                  setConfirming(false);
                  destroy.mutate();
                }}
              >
                Delete
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirming(false)}
              >
                Keep
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              icon={Trash2}
              aria-label="Delete this tailored resume"
              onClick={() => setConfirming(true)}
            />
          )}
        </div>
      </div>

      <button
        type="button"
        className="mt-1.5 text-left text-xs text-[var(--ink-muted)] underline decoration-dotted"
        onClick={() => setOpen(!open)}
      >
        {open ? 'Hide the description' : 'What it was written against'}
      </button>
      {open && (
        <p className="mt-1.5 rounded-[var(--r-sm)] bg-[var(--surface-hover)] px-3.5 py-2.5 text-xs leading-relaxed whitespace-pre-wrap text-[var(--ink-secondary)]">
          {row.jdPreview}
        </p>
      )}
    </div>
  );
}

/**
 * The two files, fetched as blobs.
 *
 * Not links at the API: the session is an HttpOnly cookie on another origin, so a plain
 * href would hand the reader a 401 in a new tab. `saveBlob` explains the rest.
 */
function Downloads({ row }: { row: TailoredSummary }) {
  const toast = useToast();

  const download = useMutation({
    mutationFn: async (format: 'pdf' | 'docx') => {
      const blob = await api.blob(`/api/me/tailor/${row.id}/${format}`);
      const name = `${row.title} ${row.company}`
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-');
      saveBlob(blob, `${name || 'resume'}.${format}`);
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <div className="flex items-center gap-2">
      {row.pdf && (
        <Button
          size="sm"
          variant="primary"
          icon={Download}
          busy={download.isPending}
          onClick={() => download.mutate('pdf')}
        >
          PDF
        </Button>
      )}
      {row.docx && (
        <Button
          size="sm"
          icon={Download}
          busy={download.isPending}
          onClick={() => download.mutate('docx')}
        >
          Word
        </Button>
      )}
    </div>
  );
}
