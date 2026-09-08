'use client';

import { useMutation } from '@tanstack/react-query';
import { Plus, TriangleAlert, X } from 'lucide-react';
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
  type ParsedAtom,
  type ResumeContact,
  type UploadResult,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  KIND_HAS_META,
  KIND_HINT,
  KIND_LABEL,
  KIND_ONE,
  KIND_ORDER,
  labelFromFilename,
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
 * the cheapest moment to fix one is before it has been embedded and scored.
 */

/** One row being edited. `key` is local and never sent: the pieces have no ids
 *  yet, and using the array index as a React key makes a delete look like an
 *  edit to every row below it. */
interface Row extends ParsedAtom {
  key: number;
}

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
    upload.atoms.map((atom, i) => ({
      ...atom,
      // A job line written as "Acme Corp — Software Engineer" on one row parses
      // with the whole thing in `employer` and nothing in `text`, and an empty box
      // that blocks saving with no hint at what belongs in it is the worst version
      // of this screen. The employer string IS the candidate's own words from
      // their own file, so it is the honest thing to put there - and it stays
      // editable like everything else.
      text: atom.text.trim() || atom.employer?.trim() || '',
      key: i,
    })),
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
            employer: r.employer ?? null,
            dateRange: r.dateRange ?? null,
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

  const remove = (key: number) =>
    setRows((prev) => prev.filter((r) => r.key !== key));

  const add = (kind: AtomKind) => {
    setRows((prev) => [
      ...prev,
      { key: nextKey, kind, text: '', tech: [], metrics: [] },
    ]);
    setNextKey((k) => k + 1);
  };

  const empty = rows.filter((r) => r.text.trim().length < 2).length;
  const blocked =
    label.trim().length === 0 ||
    contact.fullName.trim().length === 0 ||
    contact.email.trim().length === 0 ||
    rows.length === 0 ||
    empty > 0;

  return (
    <div className="max-w-4xl space-y-5 px-4 pb-10 sm:px-6">
      <Card glow>
        <CardHeader
          title="Check this before it is saved"
          subtitle="Nothing is stored yet. Everything below is what was read out of your file — correct anything that is wrong, then save."
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
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Your details"
          subtitle="These go at the top of every resume that gets generated. The email is required — it is where replies go, and it is never filled in for you from your account."
        />
        <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
          <Field label="Full name">
            <input
              className={cn(controlClass, 'w-full')}
              value={contact.fullName}
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
              onChange={(e) =>
                setContact({ ...contact, email: e.target.value })
              }
            />
          </Field>
          {(
            [
              ['phone', 'Phone'],
              ['location', 'Where you are'],
              ['linkedIn', 'LinkedIn'],
              ['github', 'GitHub'],
              ['portfolio', 'Portfolio or website'],
            ] as const
          ).map(([field, text]) => (
            <Field key={field} label={text}>
              <input
                className={cn(controlClass, 'w-full')}
                value={contact[field] ?? ''}
                placeholder="not found in your resume"
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
                <RowEditor
                  key={row.key}
                  row={row}
                  onChange={(change) => patch(row.key, change)}
                  onRemove={() => remove(row.key)}
                />
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
      </div>
    </div>
  );
}

function RowEditor({
  row,
  onChange,
  onRemove,
}: {
  row: Row;
  onChange: (change: Partial<Row>) => void;
  onRemove: () => void;
}) {
  const short = row.kind === 'SKILL';
  return (
    <div className="flex items-start gap-3 px-5 py-3">
      <div className="min-w-0 flex-1 space-y-2">
        {short ? (
          <input
            className={cn(controlClass, 'w-full')}
            value={row.text}
            onChange={(e) => onChange({ text: e.target.value })}
          />
        ) : (
          <textarea
            className={cn(controlClass, 'w-full resize-y leading-relaxed')}
            rows={Math.min(5, Math.max(2, Math.ceil(row.text.length / 90)))}
            value={row.text}
            onChange={(e) => onChange({ text: e.target.value })}
          />
        )}
        {KIND_HAS_META[row.kind] && (
          <div className="flex flex-wrap gap-2">
            <input
              className={cn(controlClass, 'w-full max-w-[15rem] text-xs')}
              placeholder="Employer or project"
              value={row.employer ?? ''}
              onChange={(e) =>
                onChange({ employer: e.target.value || null })
              }
            />
            <input
              className={cn(controlClass, 'w-full max-w-[12rem] text-xs')}
              placeholder="Dates, e.g. Jan 2024 – Present"
              value={row.dateRange ?? ''}
              onChange={(e) =>
                onChange({ dateRange: e.target.value || null })
              }
            />
          </div>
        )}
      </div>
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
