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
 *
 * WHY THE CHANGES ARE SHOWN TWO WAYS. "What changed" is a word-level diff against the
 * candidate's own sentences, which is the question a person actually has after a run and
 * cannot answer by reading two documents side by side. "Changes marked" is the document
 * itself with those lines highlighted, which is the only way to see WHERE on the page they
 * are. The marked copy is a separate file the server renders on request, it is pdf-only and
 * it is never what a download hands over - a resume reaching an employer in highlighter is
 * worse than one with no highlighting at all.
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
  Highlighter,
  Search,
  Trash2,
  Wand2,
} from 'lucide-react';
import { useState } from 'react';
import { PdfFrame } from '@/components/pdf-frame';
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
  type AtomKind,
  type DiffSegment,
  type JobRow,
  type MarkedResult,
  type ResumeSummary,
  type ResumeTemplate,
  type TailoredChanges,
  type TailoredSummary,
  type TemplateChoice,
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

      {/*
        Two columns on a wide screen, the whole width of it: the description goes in on the
        left and the document comes out on the right, pinned, so a run can be read against
        the posting it was written for without scrolling between them. One column below xl,
        with the document under the button that produced it.
      */}
      <div className="grid grid-cols-1 items-start gap-4 px-4 pb-10 sm:px-6 xl:grid-cols-2">
        <div className="min-w-0 space-y-4">
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
                          Nothing matched. Paste the description instead — it
                          works the same way.
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
                says. A technology your pieces do not mention, or a number that
                is not in them, is rejected before the document is written —
                which is why a run can come back saying it kept your base
                resume.
              </p>
            </>
          )}
        </div>

        <div className="min-w-0 xl:sticky xl:top-16">
          {result ? (
            // Re-typesetting rewrites the files and returns the updated row, and the row
            // lives here - so the new template has to come back up rather than being
            // held in two places that can disagree about which one is on disk.
            <TailoredCard row={result} onChange={setResult} />
          ) : (
            <Card>
              <EmptyState
                icon={Wand2}
                title="The resume appears here"
                detail="Written by the same code that writes a real application, so what you read here is the file. Nothing is downloaded until you ask for it."
              />
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * The run that just finished, in full: the document, what the guard said, the letter.
 *
 * THE DOCUMENT IS ON SCREEN, not behind the download button. A resume the candidate has
 * not read is the one thing this whole pipeline is arranged to avoid producing, and
 * "download it and open it in Word to find out what it says" is how that happens. The pdf
 * already exists on disk by the time this renders - the run wrote it - so showing it costs
 * one GET and no conversion.
 */
function TailoredCard({
  row,
  onChange,
}: {
  row: TailoredSummary;
  /** Called with the row as the server rewrote it, after a re-typeset. */
  onChange?: (row: TailoredSummary) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();

  /** Showing the highlighted review copy instead of the document itself. */
  const [showMarked, setShowMarked] = useState(false);
  /** Bumped whenever a render has overwritten a file the frame below is showing. */
  const [stamp, setStamp] = useState(0);

  const mark = useMutation({
    mutationFn: () => api.post<MarkedResult>(`/api/me/tailor/${row.id}/marked`),
    onSuccess: (result) => {
      if (!result.pdf) {
        toast.error(
          'LibreOffice could not produce the marked-up pdf on this machine. ' +
            '“What changed” below says the same thing in words.',
        );
        return;
      }
      if (result.marked === 0) {
        toast.error(
          'Nothing to highlight — this run re-used every sentence exactly as you ' +
            'wrote it and only chose which ones to include.',
        );
        return;
      }
      setStamp(Date.now());
      setShowMarked(true);
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <Card>
      <CardHeader
        title={row.guardPassed ? 'Ready to send' : 'Tailoring was rejected'}
        subtitle={
          row.guardPassed
            ? `Written for ${row.title}${row.company ? ` at ${row.company}` : ''}. Every sentence in it traces back to a piece of your resume.`
            : 'The rewrite claimed something your pieces do not support, so the file below is your base resume, untailored.'
        }
        icon={row.guardPassed ? CheckCircle2 : AlertTriangle}
        action={<Downloads row={row} />}
      />

      <TemplateRow
        row={row}
        onChange={(updated) => {
          onChange?.(updated);
          // The run's own files were just rewritten at the same paths, and the marked
          // copy was rendered in the OLD template - so it is asked for again rather
          // than shown stale beside a document that has moved.
          setShowMarked(false);
          setStamp(Date.now());
          void qc.invalidateQueries({ queryKey: ['me', 'tailor'] });
        }}
      />

      <div className="space-y-3 px-5 pb-5">
        {row.pdf ? (
          <>
            <PdfFrame
              path={
                showMarked
                  ? `/api/me/tailor/${row.id}/marked/pdf`
                  : `/api/me/tailor/${row.id}/pdf`
              }
              reloadKey={stamp}
              title={
                showMarked
                  ? `Resume for ${row.title} at ${row.company}, with the re-worded lines highlighted`
                  : `Resume for ${row.title} at ${row.company}`
              }
              className="h-[calc(100vh-22rem)] min-h-[30rem] w-full"
            />
            {row.guardPassed && (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  size="sm"
                  variant={showMarked ? 'primary' : 'secondary'}
                  icon={Highlighter}
                  busy={mark.isPending}
                  onClick={() => {
                    if (showMarked) setShowMarked(false);
                    else mark.mutate();
                  }}
                >
                  {showMarked ? 'Show the real document' : 'Mark what changed'}
                </Button>
                <p className="text-xs text-[var(--ink-muted)]">
                  {showMarked
                    ? 'A reading copy. The highlighting is not in the file you download or send.'
                    : 'Renders a second copy with the re-worded lines highlighted, to read rather than send.'}
                </p>
              </div>
            )}
          </>
        ) : (
          <p className="text-xs text-[var(--ink-muted)]">
            LibreOffice could not produce a pdf on this machine, so there is
            nothing to show here — the Word file above is the same document.
          </p>
        )}

        <ChangesPanel id={row.id} />

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

/**
 * The template this run's files are written in, and the other ones on offer.
 *
 * RE-TYPESETS, IT DOES NOT RE-TAILOR. Switching costs a docx write and a LibreOffice
 * conversion, not a model call: the decision about which pieces to use and how to word them
 * is already stored, so the same words are laid out again on different margins. That is
 * worth having next to the document rather than only on the resume screen, because the
 * reason to change template is almost always "this one runs six lines onto a second page"
 * and that is a thing you notice while looking at it.
 *
 * THE LIST COMES FROM THE SERVER, cached for the session. A template named here and missing
 * from the renderer's writer table would be a button that produces the wrong document.
 */
function TemplateRow({
  row,
  onChange,
}: {
  row: TailoredSummary;
  onChange: (row: TailoredSummary) => void;
}) {
  const toast = useToast();

  const templates = useQuery({
    queryKey: ['resume-templates'],
    queryFn: () =>
      api.get<TemplateChoice[]>('/api/me/resume-preview/templates'),
    // The set of templates the server can write does not change while a tab is open.
    staleTime: Infinity,
  });

  const retypeset = useMutation({
    mutationFn: (template: ResumeTemplate) =>
      api.post<TailoredSummary>(`/api/me/tailor/${row.id}/retypeset`, {
        template,
      }),
    onSuccess: onChange,
    onError: (err) => toast.error((err as Error).message),
  });

  if (!templates.data) return null;
  const chosen = templates.data.find((t) => t.id === row.template);

  return (
    <div className="border-t border-[var(--border)] px-5 py-3">
      <div
        className="flex flex-wrap items-center gap-1 rounded-[var(--r-full)] bg-[var(--surface-hover)] p-1"
        role="group"
        aria-label="Template for this tailored resume"
      >
        {templates.data.map((template) => (
          <Button
            key={template.id}
            size="sm"
            variant={template.id === row.template ? 'primary' : 'ghost'}
            busy={retypeset.isPending && retypeset.variables === template.id}
            aria-pressed={template.id === row.template}
            onClick={() => retypeset.mutate(template.id)}
          >
            {template.label}
          </Button>
        ))}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-[var(--ink-muted)]">
        {chosen?.detail} Switching re-typesets this run — the same words on a
        different page, and no second model call.
      </p>
    </div>
  );
}

/**
 * What tailoring did to the candidate's own sentences, word by word.
 *
 * WHY A DIFF AND NOT A BEFORE-AND-AFTER PAIR. Two versions of the same bullet differ in
 * four words out of thirty, and finding those four by reading both is exactly the work this
 * screen should be doing. So each line is shown once with the changed runs coloured.
 *
 * FETCHED ONLY WHEN OPENED. It is one request and no render - the server rebuilds the diff
 * from the stored decision - but a history page that pulled one of these per row would make
 * forty requests to show text nobody asked to see.
 *
 * AGAINST THE RESUME AS IT IS NOW, which is said on screen rather than glossed over: the
 * server stores which pieces were used and how they were re-worded, not a copy of the
 * pieces, so a bullet edited since is diffed in its edited form. `missing` is the honest
 * consequence - pieces this run used that have since been deleted.
 */
function ChangesPanel({ id }: { id: string }) {
  const [open, setOpen] = useState(false);

  const changes = useQuery({
    queryKey: ['me', 'tailor', id, 'changes'],
    queryFn: () => api.get<TailoredChanges>(`/api/me/tailor/${id}/changes`),
    enabled: open,
  });

  return (
    <div>
      <button
        type="button"
        className="text-left text-xs text-[var(--ink-secondary)] underline decoration-dotted"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {open ? 'Hide what changed' : 'What changed from what I wrote'}
      </button>

      {open && (
        <div className="mt-2 space-y-3">
          {changes.isLoading && <SkeletonCard rows={2} />}
          {changes.error && (
            <ErrorNote message={(changes.error as Error).message} />
          )}
          {changes.data && <Changes changes={changes.data} />}
        </div>
      )}
    </div>
  );
}

function Changes({ changes }: { changes: TailoredChanges }) {
  const nothing =
    changes.rewritten.length === 0 &&
    changes.dropped.length === 0 &&
    !changes.headline;

  return (
    <>
      {!changes.applied && (
        <p className="rounded-[var(--r-sm)] border border-[var(--status-warning)] px-3.5 py-2.5 text-xs leading-relaxed text-[var(--ink-secondary)]">
          These are the changes that were <em>proposed and refused</em>. The
          document above is your base resume, so nothing below is in the file
          you would send.
        </p>
      )}

      <p className="text-xs leading-relaxed text-[var(--ink-muted)]">
        {changes.rewritten.length} sentence
        {changes.rewritten.length === 1 ? '' : 's'} re-worded, {changes.kept}{' '}
        used exactly as you wrote {changes.kept === 1 ? 'it' : 'them'},{' '}
        {changes.dropped.length} left off the page. Compared against your resume
        as it stands today — if you have edited it since this run, the
        comparison is with the edited version.
        {changes.missing > 0 &&
          ` ${changes.missing} piece${changes.missing === 1 ? '' : 's'} this run used no longer exist${changes.missing === 1 ? 's' : ''} on your resume.`}
      </p>

      {nothing && (
        <p className="text-xs leading-relaxed text-[var(--ink-secondary)]">
          Not one word was changed. Tailoring chose which of your pieces to
          include and left the wording alone — which is the safest outcome it
          has, not a failure.
        </p>
      )}

      {changes.headline && (
        <div className="rounded-[var(--r-sm)] border border-[var(--border)] px-3.5 py-3">
          <p className="mb-1.5 text-[11px] tracking-wide text-[var(--ink-muted)] uppercase">
            The line under your name
          </p>
          <Diff segments={changes.headline.segments} />
        </div>
      )}

      {changes.rewritten.map((line) => (
        <div
          key={line.atomId}
          className="rounded-[var(--r-sm)] border border-[var(--border)] px-3.5 py-3"
        >
          <p className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px] text-[var(--ink-muted)]">
            <span className="tracking-wide uppercase">
              {KIND_LABEL[line.kind]}
            </span>
            {line.employer && <span>{line.employer}</span>}
            <span>
              {line.added} added, {line.removed} removed
            </span>
          </p>
          <Diff segments={line.segments} />
        </div>
      ))}

      {changes.dropped.length > 0 && (
        <div className="rounded-[var(--r-sm)] bg-[var(--surface-hover)] px-3.5 py-3">
          <p className="mb-1.5 text-[11px] tracking-wide text-[var(--ink-muted)] uppercase">
            Left off for this job
          </p>
          <ul className="space-y-1.5">
            {changes.dropped.map((line) => (
              <li
                key={line.atomId}
                className="text-xs leading-relaxed text-[var(--ink-secondary)]"
              >
                {line.text}
                {line.employer ? (
                  <span className="text-[var(--ink-muted)]">
                    {' '}
                    · {line.employer}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs leading-relaxed text-[var(--ink-muted)]">
            Still on your resume — they were just not the strongest things to
            say to this employer.
          </p>
        </div>
      )}
    </>
  );
}

const KIND_LABEL: Record<AtomKind, string> = {
  BULLET: 'Bullet',
  SKILL: 'Skill',
  ROLE: 'Role',
  EDU: 'Education',
};

/**
 * One sentence, with the words that changed coloured.
 *
 * The space between two runs is OUTSIDE the coloured span, so a strikethrough on removed
 * words does not trail across the gap into the words that stayed.
 */
function Diff({ segments }: { segments: DiffSegment[] }) {
  return (
    <p className="text-xs leading-relaxed text-[var(--ink-secondary)]">
      {segments.map((segment, at) => (
        <span key={at}>
          {at > 0 ? ' ' : ''}
          <span className={DIFF_CLASS[segment.change]}>{segment.text}</span>
        </span>
      ))}
    </p>
  );
}

const DIFF_CLASS: Record<DiffSegment['change'], string> = {
  same: '',
  added:
    'rounded-[3px] bg-[color-mix(in_srgb,var(--status-good)_18%,transparent)] px-0.5 ' +
    'text-[var(--status-good)]',
  removed:
    'rounded-[3px] bg-[color-mix(in_srgb,var(--status-critical)_14%,transparent)] px-0.5 ' +
    'text-[var(--status-critical)] line-through',
};

function HistoryRow({ row }: { row: TailoredSummary }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [open, setOpen] = useState(false);
  const [showing, setShowing] = useState(false);

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

      <div className="mt-1.5 flex flex-wrap items-center gap-3">
        {row.pdf && (
          <button
            type="button"
            className="text-left text-xs text-[var(--ink-secondary)] underline decoration-dotted"
            onClick={() => setShowing(!showing)}
          >
            {showing ? 'Hide the resume' : 'Read the resume'}
          </button>
        )}
        <button
          type="button"
          className="text-left text-xs text-[var(--ink-muted)] underline decoration-dotted"
          onClick={() => setOpen(!open)}
        >
          {open ? 'Hide the description' : 'What it was written against'}
        </button>
      </div>

      {/* Below the row of links rather than in it, because the diff it opens is
          full-width prose and would be squeezed into a column beside them. */}
      <div className="mt-1.5">
        <ChangesPanel id={row.id} />
      </div>

      {/* Fetched only once it is asked for. A history of forty runs would otherwise pull
          forty pdfs into the tab to show four lines of text each. */}
      {showing && row.pdf && (
        <PdfFrame
          path={`/api/me/tailor/${row.id}/pdf`}
          title={`Resume for ${row.title} at ${row.company}`}
          className="mt-2 h-[32rem] w-full"
        />
      )}

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
