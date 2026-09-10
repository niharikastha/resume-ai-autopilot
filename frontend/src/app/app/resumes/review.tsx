'use client';

import { useMutation } from '@tanstack/react-query';
import { FileText, Plus, TriangleAlert, X } from 'lucide-react';
import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ErrorNote,
  controlClass,
} from '@/components/ui';
import {
  api,
  type AtomKind,
  type ExtractedText,
  type ParsedAtom,
  type ResumeContact,
  type UploadResult,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  DEGREES,
  DEGREE_GROUPS,
  DEGREE_OTHER,
  KIND_HINT,
  KIND_LABEL,
  KIND_ONE,
  KIND_ORDER,
  KIND_TEXT_PLACEHOLDER,
  composeEducation,
  composeYears,
  degreeName,
  emptyEducation,
  labelFromFilename,
  splitEducation,
  type EducationParts,
} from './kinds';

/**
 * The confirmation step: everything the parse thinks it found, before any of it
 * is saved.
 *
 * This screen is the gate, not a preview of one. Nothing has been written to the
 * database at this point - the file is on disk and that is all - so closing the
 * tab here leaves no resume behind. PLAN-v2 phase 3 put the gate in the CLI for
 * the same reason it is here: every stage downstream treats these pieces as
 * ground truth, so a misread employer or a date off by a year does not get
 * caught later, it gets printed onto a real application.
 *
 * EDITING IS EXPECTED HERE, not exceptional. A PDF parse gets things wrong, and
 * the cheapest moment to fix one is before it has been embedded and scored. That
 * is also why every box carries an example rather than an instruction: the boxes
 * a parse leaves empty are the ones a person has to fill, and an example is the
 * fastest way to say what belongs in one.
 */

/** One row being edited. `key` is local and never sent: the pieces have no ids
 *  yet, and using the array index as a React key makes a delete look like an
 *  edit to every row below it. */
interface Row extends ParsedAtom {
  key: number;
  /**
   * The education boxes, for an EDU row and nobody else.
   *
   * LOCAL, and never sent as-is. `text` and `dateRange` are recomposed from these
   * on every keystroke, so the piece that gets saved is always the sentence shown
   * on screen - there is no second, hidden version of it.
   */
  edu: EducationParts;
}

/** The scales an "out of" box suggests. A list, not a dropdown: a marking scheme
 *  this does not know about still has to be typeable. */
const SCORE_SCALES = ['10', '4', '100'];
const SCALE_LIST_ID = 'resume-score-scales';

export function ReviewStep({
  upload,
  onCancel,
  onSaved,
}: {
  upload: UploadResult;
  onCancel: () => void;
  onSaved: (label: string) => void;
}) {
  const [label, setLabel] = useState(() => labelFromFilename(upload.filename));
  const [contact, setContact] = useState<ResumeContact>(upload.contact);
  const [nextKey, setNextKey] = useState(upload.atoms.length);
  const [rows, setRows] = useState<Row[]>(() =>
    upload.atoms.map((atom, i) => {
      // A job line written as "Acme Corp — Software Engineer" on one row parses
      // with the whole thing in `employer` and nothing in `text`, and an empty box
      // that blocks saving with no hint at what belongs in it is the worst version
      // of this screen. The employer string IS the candidate's own words from
      // their own file, so it is the honest thing to put there - and it stays
      // editable like everything else.
      const text = atom.text.trim() || atom.employer?.trim() || '';
      if (atom.kind !== 'EDU') return { ...atom, text, edu: emptyEducation(), key: i };

      // An education line arrives as one sentence and is shown as boxes, so it has
      // to be taken apart. `splitEducation` keeps the wording whole when it cannot
      // recognise it, which is why recomposing here cannot lose anything.
      const edu = splitEducation(text, atom.dateRange);
      return {
        ...atom,
        text: composeEducation(edu) || text,
        dateRange: composeYears(edu) ?? atom.dateRange ?? null,
        edu,
        key: i,
      };
    }),
  );

  const save = useMutation({
    mutationFn: () =>
      api.post<{ id: string; isActive: boolean; atomCount: number }>(
        '/api/me/resumes',
        {
          label: label.trim(),
          uploadId: upload.uploadId,
          filename: upload.filename,
          contact,
          // Tech tags are deliberately not sent. The server re-derives them from
          // the text of every piece, because they are the list the provenance
          // guard checks a tailored rewrite against - a tag the words do not
          // support would license a claim the resume never made.
          atoms: rows.map((r) => ({
            kind: r.kind,
            text: r.text.trim(),
            employer: r.employer?.trim() || null,
            dateRange: r.dateRange?.trim() || null,
            link: r.link?.trim() || null,
            ctc: r.ctc?.trim() || null,
            // The education parts, and only for education. Sending a degree on a
            // bullet would store a value no screen shows and nothing reads.
            ...(r.kind === 'EDU'
              ? {
                  degree: degreeName(r.edu) || null,
                  fieldOfStudy: r.edu.fieldOfStudy.trim() || null,
                  // Together or not at all - the server refuses one without the
                  // other, because 8.6 alone does not say out of what.
                  score: scoredPair(r.edu)?.score ?? null,
                  scoreOutOf: scoredPair(r.edu)?.outOf ?? null,
                }
              : {}),
          })),
          makeActive: true,
        },
      ),
    onSuccess: () => onSaved(label.trim()),
  });

  const patch = (key: number, change: Partial<Row>) =>
    setRows((prev) =>
      prev.map((r) => (r.key === key ? { ...r, ...change } : r)),
    );

  /** Edits one education box, then rebuilds the line and the dates from all of them. */
  const patchEdu = (key: number, change: Partial<EducationParts>) =>
    setRows((prev) =>
      prev.map((r) => {
        if (r.key !== key) return r;
        const edu = { ...r.edu, ...change };
        return {
          ...r,
          edu,
          text: composeEducation(edu),
          dateRange: composeYears(edu),
        };
      }),
    );

  const remove = (key: number) =>
    setRows((prev) => prev.filter((r) => r.key !== key));

  const add = (kind: AtomKind) => {
    setRows((prev) => [
      ...prev,
      {
        key: nextKey,
        kind,
        text: '',
        tech: [],
        metrics: [],
        edu: emptyEducation(),
      },
    ]);
    setNextKey((k) => k + 1);
  };

  const empty = rows.filter((r) => r.text.trim().length < 2).length;
  // A score with nothing to compare it to is refused by the server, so it is caught
  // here instead: an error on submit that names a field nobody scrolled back to is a
  // worse version of the same message.
  const halfScored = rows.filter(
    (r) =>
      r.kind === 'EDU' &&
      Boolean(r.edu.score.trim()) !== Boolean(r.edu.scoreOutOf.trim()),
  ).length;
  const blocked =
    label.trim().length === 0 ||
    contact.fullName.trim().length === 0 ||
    contact.email.trim().length === 0 ||
    rows.length === 0 ||
    empty > 0 ||
    halfScored > 0;

  return (
    <div className="w-full space-y-5 px-4 pb-10 sm:px-6">
      {/* One shared list of marking scales for every education row on the page. An
          id has to be unique in a document, so this cannot live inside the row. */}
      <datalist id={SCALE_LIST_ID}>
        {SCORE_SCALES.map((scale) => (
          <option key={scale} value={scale} />
        ))}
      </datalist>

      {/* The gate on the left, what the file actually said on the right. Side by side
          because the two are read against each other: every box below is derived from
          that text, and a person checking a name or a missing bullet is comparing the
          two rather than reading either on its own. Stacked under 1280px, where two
          columns would make both of them too narrow to read. */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem] xl:items-start">
        <Card glow>
          <CardHeader
            title="Check this before it is saved"
            subtitle="Your file is saved; nothing has been added to your profile yet. Everything below is what was read out of it — correct anything that is wrong, then save."
            action={
              <span className="text-xs text-[var(--ink-muted)]">
                {upload.filename}
              </span>
            }
          />
          <div className="space-y-4 px-5 py-4">
            {upload.warnings.length > 0 && (
              <div className="space-y-1.5 rounded-[var(--r-sm)] border border-[color-mix(in_srgb,var(--status-warning)_35%,var(--border))] bg-[color-mix(in_srgb,var(--status-warning)_8%,transparent)] px-3.5 py-3">
                <p className="flex items-center gap-2 text-xs font-medium text-[var(--ink-primary)]">
                  <TriangleAlert
                    size={13}
                    style={{ color: 'var(--status-warning)' }}
                    aria-hidden
                  />
                  Worth a second look
                </p>
                <ul className="space-y-1 text-xs text-[var(--ink-secondary)]">
                  {upload.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            <Field
              label="Name this resume"
              hint="Your own handle for it, so you can tell three versions apart. Letters, numbers, spaces, hyphens and underscores."
            >
              <input
                className={cn(controlClass, 'w-full max-w-xs')}
                value={label}
                maxLength={60}
                placeholder="e.g. primary, or backend-roles"
                onChange={(e) => setLabel(e.target.value)}
              />
            </Field>
          </div>
        </Card>

        <ExtractedTextCard extracted={upload.extracted} />
      </div>

      <Card>
        <CardHeader
          title="Your details"
          subtitle="These go at the top of every resume that gets generated. Anything blank was not found in your file. The email is required — it is where replies go, and it is never filled in for you from your account."
        />
        {/* Three across once there is room. A phone number in a box the width of a
            monitor is harder to read back than one in a box the width of a phone
            number. */}
        <div className="grid gap-4 px-5 py-4 sm:grid-cols-2 xl:grid-cols-3">
          <Field label="Full name">
            <input
              className={cn(controlClass, 'w-full')}
              value={contact.fullName}
              placeholder="e.g. Priya Sharma"
              onChange={(e) =>
                setContact({ ...contact, fullName: e.target.value })
              }
            />
          </Field>
          <Field label="Email">
            <input
              type="email"
              className={cn(controlClass, 'w-full')}
              value={contact.email}
              placeholder="e.g. priya.sharma@gmail.com"
              onChange={(e) =>
                setContact({ ...contact, email: e.target.value })
              }
            />
          </Field>
          {(
            [
              ['phone', 'Phone', 'e.g. +91 98765 43210'],
              ['location', 'Where you are', 'e.g. Bengaluru, India'],
              ['linkedIn', 'LinkedIn', 'e.g. linkedin.com/in/priyasharma'],
              ['github', 'GitHub', 'e.g. github.com/priyasharma'],
              ['portfolio', 'Portfolio or website', 'e.g. priyasharma.dev'],
            ] as const
          ).map(([field, text, placeholder]) => (
            <Field key={field} label={text}>
              <input
                className={cn(controlClass, 'w-full')}
                value={contact[field] ?? ''}
                placeholder={placeholder}
                onChange={(e) =>
                  setContact({
                    ...contact,
                    [field]: e.target.value.trim() ? e.target.value : null,
                  })
                }
              />
            </Field>
          ))}
        </div>
      </Card>

      {KIND_ORDER.map((kind) => {
        const group = rows.filter((r) => r.kind === kind);
        return (
          <Card key={kind}>
            <CardHeader
              title={KIND_LABEL[kind]}
              subtitle={KIND_HINT[kind]}
              action={<Badge>{group.length}</Badge>}
            />
            <div className="divide-y divide-[var(--border)]">
              {group.map((row) => (
                <PieceRow key={row.key} onRemove={() => remove(row.key)}>
                  {row.kind === 'ROLE' && (
                    <RoleFields
                      row={row}
                      onChange={(change) => patch(row.key, change)}
                    />
                  )}
                  {row.kind === 'EDU' && (
                    <EducationFields
                      row={row}
                      onChange={(change) => patch(row.key, change)}
                      onEdu={(change) => patchEdu(row.key, change)}
                    />
                  )}
                  {(row.kind === 'BULLET' || row.kind === 'SKILL') && (
                    <PlainFields
                      row={row}
                      onChange={(change) => patch(row.key, change)}
                    />
                  )}
                </PieceRow>
              ))}
              {group.length === 0 && (
                <p className="px-5 py-4 text-xs text-[var(--ink-muted)]">
                  Nothing here. Either your resume has none, or the parse missed
                  the section — add them by hand if so.
                </p>
              )}
            </div>
            <div className="border-t border-[var(--border)] px-5 py-3">
              <Button size="sm" icon={Plus} onClick={() => add(kind)}>
                Add a {KIND_ONE[kind]}
              </Button>
            </div>
          </Card>
        );
      })}

      {save.error && <ErrorNote message={(save.error as Error).message} />}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          busy={save.isPending}
          disabled={blocked}
          onClick={() => save.mutate()}
        >
          Save this resume and use it
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={save.isPending}>
          Throw this away
        </Button>
        {empty > 0 && (
          <span className="text-xs text-[var(--ink-muted)]">
            {empty} piece{empty === 1 ? ' is' : 's are'} empty — fill it in or
            remove it.
          </span>
        )}
        {halfScored > 0 && (
          <span className="text-xs text-[var(--ink-muted)]">
            {halfScored} qualification{halfScored === 1 ? ' has' : 's have'} a
            score without saying what it is out of.
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The score and its scale, or nothing.
 *
 * One helper rather than two `.trim() || null` expressions, because they are not
 * independent: sending one without the other is a 400, and the pair being computed
 * in a single place is what stops that from being possible.
 */
function scoredPair(
  edu: EducationParts,
): { score: string; outOf: string } | null {
  const score = edu.score.trim();
  const outOf = edu.scoreOutOf.trim();
  return score && outOf ? { score, outOf } : null;
}

/**
 * The text the file gave up, before anything was split out of it.
 *
 * WHY IT IS AT THE TOP RIGHT. Every box on this screen is derived from these words,
 * so when a bullet is missing there are two quite different causes: the pdf never
 * gave up that line, or it did and the parser filed it somewhere unexpected. Only
 * this tells them apart - and only the first is worth re-exporting the file over.
 * Beside the form rather than below it, because it is the thing the form is being
 * checked against.
 *
 * Opens to a few lines and expands. The first lines are where a name and a phone
 * number are, which is what most people want to check; the rest is a wall of text
 * that would push the form off the screen if it were always open.
 */
function ExtractedTextCard({ extracted }: { extracted: ExtractedText }) {
  const [open, setOpen] = useState(false);
  const lines = extracted.text === '' ? 0 : extracted.text.split('\n').length;
  const teaser = extracted.text.split('\n').slice(0, 8).join('\n');

  return (
    <Card className="border-[color-mix(in_srgb,var(--accent-cyan)_40%,var(--border))]">
      <CardHeader
        icon={FileText}
        title="What your file actually said"
        subtitle="The text the reader got out of it. If a line is missing here, it was never in the file as text — no amount of correcting on the left will find it."
        action={
          extracted.chars > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
              {open ? 'Show less' : 'Show all'}
            </Button>
          )
        }
      />
      <div className="space-y-3 px-5 py-4">
        <p className="text-xs text-[var(--ink-muted)]">
          {extracted.chars.toLocaleString()} characters, {lines.toLocaleString()}{' '}
          line{lines === 1 ? '' : 's'}
          {extracted.truncated &&
            ` — showing the first ${extracted.text.length.toLocaleString()}`}
          .
        </p>

        {extracted.chars === 0 && (
          <p className="text-xs" style={{ color: 'var(--status-warning)' }}>
            Nothing came out of this file. That usually means it is a scan — a
            picture of a page rather than text — and the pieces on the left will
            be empty. Export a fresh PDF from the document it was written in.
          </p>
        )}

        {extracted.chars > 0 && (
          // Preserved exactly, blank lines and all: the line breaks and the run of
          // spaces are what the parser reads sections off, so a version reflowed
          // for looks would be a different document from the one being explained.
          <div className="relative">
            <pre
              className={cn(
                'overflow-auto rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3.5 py-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-[var(--ink-secondary)]',
                open ? 'max-h-[32rem]' : 'max-h-32 overflow-hidden',
              )}
            >
              {open ? extracted.text : teaser}
            </pre>
            {!open && (
              // Faded rather than cut, so it is obvious there is more below and the
              // last visible line is not mistaken for the end of the file.
              <div
                className="pointer-events-none absolute inset-x-0 bottom-0 h-12 rounded-b-[var(--r-sm)] bg-gradient-to-t from-[var(--surface-sunken)] to-transparent"
                aria-hidden
              />
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

/** The frame every piece sits in: the fields, and the button that removes it. */
function PieceRow({
  children,
  onRemove,
}: {
  children: React.ReactNode;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-start gap-3 px-5 py-4">
      <div className="min-w-0 flex-1 space-y-3">{children}</div>
      <Button
        variant="ghost"
        size="sm"
        icon={X}
        aria-label="Remove this piece"
        onClick={onRemove}
      />
    </div>
  );
}

/**
 * A job or a project.
 *
 * THE EMPLOYER IS FIRST because it is the thing being described and the rest is
 * detail about it - and because a parse that put the whole line in the employer
 * field is fixed by editing that box, which is hard to notice when it sits under a
 * textarea.
 */
function RoleFields({
  row,
  onChange,
}: {
  row: Row;
  onChange: (change: Partial<Row>) => void;
}) {
  return (
    <>
      <Field label="Employer or project">
        <input
          className={cn(controlClass, 'w-full')}
          value={row.employer ?? ''}
          placeholder="e.g. Zomato, or Walking Pal (a project of your own)"
          onChange={(e) => onChange({ employer: e.target.value || null })}
        />
      </Field>
      <Field label="Your title, or what it was">
        <textarea
          className={cn(controlClass, 'w-full resize-y leading-relaxed')}
          rows={2}
          value={row.text}
          placeholder={KIND_TEXT_PLACEHOLDER.ROLE}
          onChange={(e) => onChange({ text: e.target.value })}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Dates">
          <input
            className={cn(controlClass, 'w-full text-xs')}
            value={row.dateRange ?? ''}
            placeholder="e.g. Jan 2024 – Present"
            onChange={(e) => onChange({ dateRange: e.target.value || null })}
          />
        </Field>
        <Field
          label="What it paid"
          hint="Yours to keep. Never printed on a resume and never sent to an employer."
        >
          <input
            className={cn(controlClass, 'w-full text-xs')}
            value={row.ctc ?? ''}
            placeholder="e.g. 12.5 LPA"
            onChange={(e) => onChange({ ctc: e.target.value || null })}
          />
        </Field>
        <Field label="Link" hint="For a project: the repo, the site, the write-up.">
          <input
            className={cn(controlClass, 'w-full text-xs')}
            value={row.link ?? ''}
            placeholder="e.g. github.com/priyasharma/walking-pal"
            onChange={(e) => onChange({ link: e.target.value || null })}
          />
        </Field>
      </div>
    </>
  );
}

/**
 * A qualification, in parts.
 *
 * NO FREE-TEXT BOX HERE, unlike every other section. An education line is the same
 * five things every time - what, in what, where, how well, when - and typing them
 * into one box is how a CGPA ends up somewhere the form filler cannot find it. The
 * sentence they add up to is shown underneath rather than hidden, because that
 * sentence is what gets saved and printed.
 */
function EducationFields({
  row,
  onChange,
  onEdu,
}: {
  row: Row;
  onChange: (change: Partial<Row>) => void;
  onEdu: (change: Partial<EducationParts>) => void;
}) {
  const other = row.edu.degreeChoice === DEGREE_OTHER;

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Degree or qualification">
          <select
            className={cn(controlClass, 'w-full')}
            value={row.edu.degreeChoice}
            onChange={(e) => onEdu({ degreeChoice: e.target.value })}
          >
            <option value="">Pick one…</option>
            {DEGREE_GROUPS.map((group) => (
              <optgroup key={group} label={group}>
                {DEGREES.filter((d) => d.group === group).map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.value}
                  </option>
                ))}
              </optgroup>
            ))}
            <option value={DEGREE_OTHER}>Other — I will type it</option>
          </select>
        </Field>

        {other && (
          <Field
            label="What is it called?"
            hint="Written exactly as it should print."
          >
            <input
              className={cn(controlClass, 'w-full')}
              value={row.edu.degreeOther}
              placeholder="e.g. Integrated M.Tech, or NPTEL Certification"
              onChange={(e) => onEdu({ degreeOther: e.target.value })}
            />
          </Field>
        )}

        <Field label="Field of study">
          <input
            className={cn(controlClass, 'w-full')}
            value={row.edu.fieldOfStudy}
            placeholder="e.g. Computer Science and Engineering"
            onChange={(e) => onEdu({ fieldOfStudy: e.target.value })}
          />
        </Field>

        <Field label="Institution">
          <input
            className={cn(controlClass, 'w-full')}
            value={row.employer ?? ''}
            placeholder="e.g. VSSUT, Burla"
            onChange={(e) => onChange({ employer: e.target.value || null })}
          />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="CGPA or percentage">
          <input
            className={cn(controlClass, 'w-full text-xs')}
            value={row.edu.score}
            placeholder="e.g. 8.6"
            onChange={(e) => onEdu({ score: e.target.value })}
          />
        </Field>
        <Field label="Out of" hint="10 for a CGPA, 100 for a percentage.">
          <input
            className={cn(controlClass, 'w-full text-xs')}
            list={SCALE_LIST_ID}
            value={row.edu.scoreOutOf}
            placeholder="e.g. 10"
            onChange={(e) => onEdu({ scoreOutOf: e.target.value })}
          />
        </Field>
        <Field label="From year">
          <input
            className={cn(controlClass, 'w-full text-xs')}
            value={row.edu.fromYear}
            maxLength={12}
            placeholder="e.g. 2019"
            onChange={(e) => onEdu({ fromYear: e.target.value })}
          />
        </Field>
        <Field label="To year">
          <input
            className={cn(controlClass, 'w-full text-xs')}
            value={row.edu.toYear}
            maxLength={12}
            placeholder="e.g. 2023, or Present"
            onChange={(e) => onEdu({ toYear: e.target.value })}
          />
        </Field>
      </div>

      <p className="text-[11px] leading-relaxed text-[var(--ink-muted)]">
        This is saved and printed as{' '}
        {row.text.trim() ? (
          <span className="font-medium text-[var(--ink-secondary)]">
            {row.text}
            {row.dateRange && ` (${row.dateRange})`}
          </span>
        ) : (
          'nothing yet — pick a qualification above'
        )}
        .
      </p>
    </>
  );
}

/** A bullet or a skill: the words, and for a bullet where they came from. */
function PlainFields({
  row,
  onChange,
}: {
  row: Row;
  onChange: (change: Partial<Row>) => void;
}) {
  const skill = row.kind === 'SKILL';
  return (
    <>
      {skill ? (
        <input
          className={cn(controlClass, 'w-full')}
          value={row.text}
          placeholder={KIND_TEXT_PLACEHOLDER.SKILL}
          onChange={(e) => onChange({ text: e.target.value })}
        />
      ) : (
        <textarea
          className={cn(controlClass, 'w-full resize-y leading-relaxed')}
          rows={Math.min(5, Math.max(2, Math.ceil(row.text.length / 90)))}
          value={row.text}
          placeholder={KIND_TEXT_PLACEHOLDER.BULLET}
          onChange={(e) => onChange({ text: e.target.value })}
        />
      )}
      {!skill && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Which job or project">
            <input
              className={cn(controlClass, 'w-full text-xs')}
              value={row.employer ?? ''}
              placeholder="e.g. Zomato — so this sits under the right heading"
              onChange={(e) => onChange({ employer: e.target.value || null })}
            />
          </Field>
          <Field label="Dates">
            <input
              className={cn(controlClass, 'w-full text-xs')}
              value={row.dateRange ?? ''}
              placeholder="e.g. 2024"
              onChange={(e) => onChange({ dateRange: e.target.value || null })}
            />
          </Field>
        </div>
      )}
    </>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-xs font-medium text-[var(--ink-secondary)]">
        {label}
      </span>
      {children}
      {hint && (
        <span className="block text-[11px] leading-relaxed text-[var(--ink-muted)]">
          {hint}
        </span>
      )}
    </label>
  );
}
