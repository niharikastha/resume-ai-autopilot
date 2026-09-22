'use client';

import { useMutation } from '@tanstack/react-query';
import {
  Building2,
  ClipboardList,
  ExternalLink,
  Linkedin,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { useToast } from '@/components/toast';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  controlClass,
  EmptyState,
  Table,
  Td,
  Th,
  Tr,
} from '@/components/ui';
import {
  api,
  type TrackedApplication,
  type TrackedApplicationPatch,
  type TrackedContact,
  type TrackedStage,
  type TrackerView,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  referralText,
  shortDay,
  STAGE_COLOR,
  STAGE_LABEL,
  STAGE_ORDER,
} from './stages';

/**
 * The form's own state, which is all strings and booleans.
 *
 * SEPARATE FROM TrackedApplication rather than a partial of it, because a form holds things
 * the API has no word for: an empty date box, a referrer select sitting on "nobody". Editing
 * the row shape directly would mean representing "the box is empty" as null and then being
 * unable to tell it from "this field was never touched" - which is exactly the distinction
 * the PATCH depends on.
 */
interface ApplicationForm {
  company: string;
  role: string;
  jobUrl: string;
  careersUrl: string;
  stage: TrackedStage;
  appliedOn: string;
  linkedInInviteSent: boolean;
  referralGiven: boolean;
  /** '' means "a referral happened and I am not naming who". */
  referrerId: string;
  notes: string;
}

function emptyForm(): ApplicationForm {
  return {
    company: '',
    role: '',
    jobUrl: '',
    careersUrl: '',
    // APPLIED and not SAVED, because the moment somebody opens this form is almost always
    // just after hitting submit somewhere. SAVED is the deliberate choice, so it costs a
    // click; the common case costs none.
    stage: 'APPLIED',
    // Today, prefilled, because the date being recorded is nearly always today and typing
    // it is the step at which somebody stops bothering. `en-CA` is the shortest honest way
    // to get YYYY-MM-DD in the READER's timezone; `toISOString().slice(0, 10)` would give
    // UTC, which in India is yesterday's date until half past five in the morning.
    appliedOn: new Date().toLocaleDateString('en-CA'),
    linkedInInviteSent: false,
    referralGiven: false,
    referrerId: '',
    notes: '',
  };
}

function formFrom(row: TrackedApplication): ApplicationForm {
  return {
    company: row.company,
    role: row.role ?? '',
    jobUrl: row.jobUrl ?? '',
    careersUrl: row.careersUrl ?? '',
    stage: row.stage,
    appliedOn: row.appliedOn ?? '',
    linkedInInviteSent: row.linkedInInviteSent,
    referralGiven: row.referralGiven,
    referrerId: row.referrer?.id ?? '',
    notes: row.notes ?? '',
  };
}

/** A box's contents as the API wants them: trimmed, or null when it is empty. */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * What actually changed, as a PATCH body.
 *
 * DIFFED RATHER THAN SENT WHOLE, even though this form shows every field and the reader
 * has just looked at all of them. Two reasons, and the second is the real one:
 *
 *   1. An unchanged row produces `{}`, which the screen can recognise and skip - so closing
 *      an edit panel without editing costs no request and logs nothing.
 *   2. It keeps ONE meaning for a PATCH from this app. If this panel sent every field while
 *      the stage dropdown in the row sent one, then "absent means leave alone" would be true
 *      of some requests and not others, and the next field added here would be a coin toss.
 *
 * The referral is the one pair that cannot be diffed field by field: `referralGiven` and
 * `referrerId` have to agree or the server refuses the pair outright, so they are resolved
 * together below.
 */
function changes(
  original: ApplicationForm,
  next: ApplicationForm,
): TrackedApplicationPatch {
  const patch: TrackedApplicationPatch = {};

  if (next.company.trim() !== original.company.trim()) {
    patch.company = next.company.trim();
  }
  if (orNull(next.role) !== orNull(original.role)) patch.role = orNull(next.role);
  if (orNull(next.jobUrl) !== orNull(original.jobUrl)) {
    patch.jobUrl = orNull(next.jobUrl);
  }
  if (orNull(next.careersUrl) !== orNull(original.careersUrl)) {
    patch.careersUrl = orNull(next.careersUrl);
  }
  if (next.stage !== original.stage) patch.stage = next.stage;
  if (orNull(next.appliedOn) !== orNull(original.appliedOn)) {
    patch.appliedOn = orNull(next.appliedOn);
  }
  if (next.linkedInInviteSent !== original.linkedInInviteSent) {
    patch.linkedInInviteSent = next.linkedInInviteSent;
  }
  if (orNull(next.notes) !== orNull(original.notes)) {
    patch.notes = orNull(next.notes);
  }

  // Unticked means nobody, regardless of what the select is still showing - the server's
  // CHECK forbids a named referrer on a row that says no referral was given.
  const nextReferrer = next.referralGiven ? orNull(next.referrerId) : null;
  const wasReferrer = original.referralGiven ? orNull(original.referrerId) : null;
  if (next.referralGiven !== original.referralGiven) {
    patch.referralGiven = next.referralGiven;
  }
  if (nextReferrer !== wasReferrer) patch.referrerId = nextReferrer;

  return patch;
}

/**
 * The fields of one application, shared by the add form and every edit panel.
 *
 * One component rather than two, because the alternative is two lists of ten inputs that
 * have to be kept in step by hand - and the way that fails is silent: a field added to the
 * add form and forgotten here becomes a value nobody can ever correct.
 */
function ApplicationFields({
  form,
  set,
  contacts,
  idPrefix,
}: {
  form: ApplicationForm;
  set: (next: ApplicationForm) => void;
  contacts: TrackedContact[];
  /** Ids have to be unique per panel: several of these can be open at once. */
  idPrefix: string;
}) {
  const field = (name: string) => `${idPrefix}-${name}`;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label
            htmlFor={field('company')}
            className="mb-1 block text-xs text-[var(--ink-muted)]"
          >
            Company
          </label>
          <input
            id={field('company')}
            className={cn(controlClass, 'w-full')}
            placeholder="Zoho"
            value={form.company}
            maxLength={120}
            onChange={(event) => set({ ...form, company: event.target.value })}
          />
        </div>
        <div>
          <label
            htmlFor={field('role')}
            className="mb-1 block text-xs text-[var(--ink-muted)]"
          >
            Role <span className="text-[var(--ink-muted)]">(optional)</span>
          </label>
          <input
            id={field('role')}
            className={cn(controlClass, 'w-full')}
            placeholder="Backend Engineer, SDE-2"
            value={form.role}
            maxLength={160}
            onChange={(event) => set({ ...form, role: event.target.value })}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label
            htmlFor={field('job-url')}
            className="mb-1 block text-xs text-[var(--ink-muted)]"
          >
            Link to the job
          </label>
          <input
            id={field('job-url')}
            className={cn(controlClass, 'w-full')}
            placeholder="careers.zoho.com/jobs/1234"
            value={form.jobUrl}
            maxLength={500}
            onChange={(event) => set({ ...form, jobUrl: event.target.value })}
          />
        </div>
        <div>
          <label
            htmlFor={field('careers-url')}
            className="mb-1 block text-xs text-[var(--ink-muted)]"
          >
            Their careers page
          </label>
          <input
            id={field('careers-url')}
            className={cn(controlClass, 'w-full')}
            placeholder="zoho.com/careers"
            value={form.careersUrl}
            maxLength={500}
            onChange={(event) => set({ ...form, careersUrl: event.target.value })}
          />
        </div>
      </div>
      {/* Says why both boxes are here. Without this the second one reads as a duplicate of
          the first and gets left empty - which is the one that is still working a year
          later, when the posting has 404'd. */}
      <p className="text-xs text-[var(--ink-muted)]">
        Both, if you have them. The posting disappears the week the role is filled; the
        careers page is how you check next year whether it reopened.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label
            htmlFor={field('stage')}
            className="mb-1 block text-xs text-[var(--ink-muted)]"
          >
            Where it got to
          </label>
          <select
            id={field('stage')}
            className={cn(controlClass, 'w-full')}
            value={form.stage}
            onChange={(event) =>
              set({ ...form, stage: event.target.value as TrackedStage })
            }
          >
            {STAGE_ORDER.map((stage) => (
              <option key={stage} value={stage}>
                {STAGE_LABEL[stage]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            htmlFor={field('applied-on')}
            className="mb-1 block text-xs text-[var(--ink-muted)]"
          >
            Applied on{' '}
            <span className="text-[var(--ink-muted)]">
              {form.stage === 'SAVED' ? '(not yet)' : '(optional)'}
            </span>
          </label>
          <input
            id={field('applied-on')}
            type="date"
            className={cn(controlClass, 'w-full')}
            value={form.appliedOn}
            onChange={(event) => set({ ...form, appliedOn: event.target.value })}
          />
        </div>
      </div>

      <div className="space-y-2.5 rounded-[var(--r-md)] border border-[var(--border)] px-4 py-3">
        <label className="flex cursor-pointer items-start gap-2.5 text-sm text-[var(--ink-secondary)]">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={form.linkedInInviteSent}
            onChange={(event) =>
              set({ ...form, linkedInInviteSent: event.target.checked })
            }
          />
          <span>
            I sent a LinkedIn request
            <span className="block text-xs text-[var(--ink-muted)]">
              To the recruiter or the hiring manager. Here so you do not send a second
              one three weeks later.
            </span>
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-2.5 text-sm text-[var(--ink-secondary)]">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={form.referralGiven}
            // Unticking clears the name too. The server would refuse the pair otherwise,
            // and a form that can be put into a state the server rejects is a form that
            // fails on save rather than on the click that caused it.
            onChange={(event) =>
              set({
                ...form,
                referralGiven: event.target.checked,
                referrerId: event.target.checked ? form.referrerId : '',
              })
            }
          />
          <span>
            Somebody referred me
            <span className="block text-xs text-[var(--ink-muted)]">
              A referral that actually went in, rather than one you asked for and are
              still waiting on.
            </span>
          </span>
        </label>

        {form.referralGiven && (
          <div className="pl-7">
            <label
              htmlFor={field('referrer')}
              className="mb-1 block text-xs text-[var(--ink-muted)]"
            >
              Who
            </label>
            <select
              id={field('referrer')}
              className={cn(controlClass, 'w-full sm:max-w-sm')}
              value={form.referrerId}
              onChange={(event) =>
                set({ ...form, referrerId: event.target.value })
              }
            >
              {/* Not "— none —". Leaving this unset records a referral whose source you
                  cannot remember, which is a real answer and worth saying out loud, so
                  that nobody invents a name to satisfy the dropdown. */}
              <option value="">I do not remember</option>
              {contacts.map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contact.company
                    ? `${contact.name} — ${contact.company}`
                    : contact.name}
                </option>
              ))}
            </select>
            {contacts.length === 0 && (
              <p className="mt-1 text-xs text-[var(--ink-muted)]">
                Nobody on your list yet — add them on the People tab and they will
                appear here.
              </p>
            )}
          </div>
        )}
      </div>

      <div>
        <label
          htmlFor={field('notes')}
          className="mb-1 block text-xs text-[var(--ink-muted)]"
        >
          Notes <span className="text-[var(--ink-muted)]">(optional)</span>
        </label>
        <textarea
          id={field('notes')}
          rows={2}
          className={cn(controlClass, 'w-full resize-y')}
          placeholder="Recruiter said they would come back in two weeks. Take-home due Friday."
          value={form.notes}
          maxLength={2000}
          onChange={(event) => set({ ...form, notes: event.target.value })}
        />
      </div>
    </div>
  );
}

/** A URL as a chip, or nothing at all when there is no URL. */
function LinkChip({ href, label }: { href: string | null; label: string }) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--ink-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
    >
      {label}
      <ExternalLink size={10} aria-hidden />
    </a>
  );
}

/**
 * The applications you tracked yourself.
 *
 * A TABLE FOR READING AND A PANEL FOR WRITING. Eleven fields will not fit across a row at
 * any width worth having, and the ones that matter when you are scanning are not the ones
 * that matter when you are correcting: the scan wants company, stage and date, the
 * correction wants the URLs and the notes. So the row carries the first set plus the one
 * control that gets used daily - the stage dropdown, because moving something from Applied
 * to Interviewing is the whole reason to come back here - and everything else lives behind
 * Edit.
 *
 * THE STAGE DROPDOWN SAVES ON CHANGE, with no confirm step. It is one field, the value is
 * visible after the write, and undoing it is choosing the previous option - so a
 * confirmation would be asking permission for something already reversible.
 */
export function TrackedApplicationsTab({
  view,
  onSettled,
}: {
  view: TrackerView;
  onSettled: (next: TrackerView) => void;
}) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<ApplicationForm>(emptyForm);
  const [editing, setEditing] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<ApplicationForm | null>(null);
  const [stageFilter, setStageFilter] = useState('');

  /**
   * NO INVALIDATION ANYWHERE IN THIS FILE, which is unlike most write paths here.
   *
   * `onSettled` writes the server's own response into the cache, and invalidating the same
   * key straight after would refetch what was just received - a second round trip whose only
   * possible effect is to briefly disagree with the list already on screen. Nothing else
   * reads this data either: the overview, the shortlist and the digest do not count
   * hand-tracked rows, so there is no other cache entry that goes stale when one changes.
   */
  const settle = onSettled;

  const add = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<TrackerView>('/api/me/tracker/applications', body),
    onSuccess: (next) => {
      settle(next);
      setForm(emptyForm());
      setAdding(false);
      toast.success('Tracked.');
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const edit = useMutation({
    mutationFn: (vars: { id: string; patch: TrackedApplicationPatch }) =>
      api.patch<TrackerView>(
        `/api/me/tracker/applications/${vars.id}`,
        vars.patch,
      ),
    onSuccess: (next) => {
      settle(next);
      setEditing(null);
      setEditForm(null);
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const remove = useMutation({
    mutationFn: (vars: { id: string; company: string }) =>
      api.del<TrackerView>(`/api/me/tracker/applications/${vars.id}`),
    onSuccess: (next, vars) => {
      settle(next);
      toast.success(`${vars.company} is off the list.`);
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const full = view.applications.length >= view.maxApplications;
  const ready = form.company.trim().length > 0;

  const submit = () => {
    if (!ready || full) return;
    // Blanks are omitted rather than sent as empty strings: the server reads an absent
    // field as "not given", and an empty string through the link validator is a different
    // code path for no reason.
    add.mutate({
      company: form.company.trim(),
      ...(form.role.trim() ? { role: form.role.trim() } : {}),
      ...(form.jobUrl.trim() ? { jobUrl: form.jobUrl.trim() } : {}),
      ...(form.careersUrl.trim() ? { careersUrl: form.careersUrl.trim() } : {}),
      stage: form.stage,
      ...(form.appliedOn ? { appliedOn: form.appliedOn } : {}),
      linkedInInviteSent: form.linkedInInviteSent,
      referralGiven: form.referralGiven,
      ...(form.referralGiven && form.referrerId
        ? { referrerId: form.referrerId }
        : {}),
      ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
    });
  };

  const saveEdit = (row: TrackedApplication) => {
    if (!editForm) return;
    if (editForm.company.trim().length === 0) {
      toast.error('An application needs a company name.');
      return;
    }
    const patch = changes(formFrom(row), editForm);
    // Nothing touched: close the panel without a request. The alternative spends a round
    // trip to be told the row is what it already was.
    if (Object.keys(patch).length === 0) {
      setEditing(null);
      setEditForm(null);
      return;
    }
    edit.mutate({ id: row.id, patch });
  };

  const shown = stageFilter
    ? view.applications.filter((row) => row.stage === stageFilter)
    : view.applications;

  // Counted over everything rather than over `shown`, so the filter dropdown can say how
  // many rows each option would reveal instead of only describing the current one.
  const counts = view.applications.reduce<Record<string, number>>(
    (acc, row) => ({ ...acc, [row.stage]: (acc[row.stage] ?? 0) + 1 }),
    {},
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Applications you made yourself"
          subtitle="Nothing here is filled in for you, and nothing here is sent anywhere. It is the record of what you did, so that “did I already apply there?” has an answer."
          icon={ClipboardList}
          action={
            <Button
              variant={adding ? 'ghost' : 'primary'}
              size="sm"
              icon={adding ? X : Plus}
              disabled={!adding && full}
              onClick={() => setAdding(!adding)}
            >
              {adding ? 'Cancel' : 'Track one'}
            </Button>
          }
        />

        {adding && (
          <div className="space-y-4 border-b border-[var(--border)] px-5 py-4">
            <ApplicationFields
              form={form}
              set={setForm}
              contacts={view.contacts}
              idPrefix="new-application"
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                icon={Plus}
                busy={add.isPending}
                disabled={!ready}
                onClick={submit}
              >
                Add to tracker
              </Button>
              <p className="text-xs text-[var(--ink-muted)]">
                Only the company is required. The rest can be filled in later.
              </p>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-5 py-3">
          <select
            value={stageFilter}
            onChange={(event) => setStageFilter(event.target.value)}
            aria-label="Filter by stage"
            className={controlClass}
          >
            <option value="">
              Every stage ({view.applications.length})
            </option>
            {STAGE_ORDER.filter((stage) => counts[stage]).map((stage) => (
              <option key={stage} value={stage}>
                {STAGE_LABEL[stage]} ({counts[stage]})
              </option>
            ))}
          </select>
          {full && (
            <p className="text-xs" style={{ color: 'var(--status-warning)' }}>
              That is {view.maxApplications} applications, which is as many as this list
              holds.
            </p>
          )}
        </div>

        {view.applications.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title="Nothing tracked yet"
            detail="This list is entirely yours to fill in. Add the last thing you applied to — the company alone is enough to start."
          />
        ) : shown.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title="Nothing at that stage"
            detail="Choose “Every stage” to see the rest of the list."
          />
        ) : (
          <Table
            head={
              <>
                <Th>Company</Th>
                <Th>Stage</Th>
                <Th nowrap>Applied</Th>
                <Th>Links</Th>
                <Th>Outreach</Th>
                <Th> </Th>
              </>
            }
          >
            {shown.map((row) => {
              const open = editing === row.id;
              return (
                <Tr key={row.id}>
                  <Td className="align-top">
                    <span className="font-medium text-[var(--ink-primary)]">
                      {row.company}
                    </span>
                    {row.role && (
                      <span className="block text-xs text-[var(--ink-secondary)]">
                        {row.role}
                      </span>
                    )}
                    {row.notes && (
                      <span className="mt-1 block max-w-xs text-xs whitespace-pre-line text-[var(--ink-muted)]">
                        {row.notes}
                      </span>
                    )}

                    {/* The edit panel, in a cell of the row it belongs to rather than in a
                        dialog. A dialog would cover the list you were comparing against,
                        which on this screen is usually why the panel was opened. */}
                    {open && editForm && (
                      <div className="mt-3 max-w-2xl space-y-4 rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--surface-hover)] p-4">
                        <ApplicationFields
                          form={editForm}
                          set={setEditForm}
                          contacts={view.contacts}
                          idPrefix={`edit-${row.id}`}
                        />
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="primary"
                            size="sm"
                            busy={edit.isPending && edit.variables?.id === row.id}
                            onClick={() => saveEdit(row)}
                          >
                            Save
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setEditing(null);
                              setEditForm(null);
                            }}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}
                  </Td>

                  <Td className="align-top">
                    <select
                      aria-label={`Stage for ${row.company}`}
                      className={cn(controlClass, 'py-1 text-xs')}
                      // Tinted by outcome, so a column of forty rows can be read without
                      // reading any of the words in it. Colour is never the only signal -
                      // the selected option says the same thing.
                      style={
                        STAGE_COLOR[row.stage]
                          ? {
                              borderColor: `color-mix(in srgb, ${STAGE_COLOR[row.stage]} 45%, transparent)`,
                              background: `color-mix(in srgb, ${STAGE_COLOR[row.stage]} 10%, var(--surface-raised))`,
                            }
                          : undefined
                      }
                      value={row.stage}
                      disabled={edit.isPending && edit.variables?.id === row.id}
                      onChange={(event) =>
                        edit.mutate({
                          id: row.id,
                          patch: { stage: event.target.value as TrackedStage },
                        })
                      }
                    >
                      {STAGE_ORDER.map((stage) => (
                        <option key={stage} value={stage}>
                          {STAGE_LABEL[stage]}
                        </option>
                      ))}
                    </select>
                  </Td>

                  <Td nowrap className="align-top">
                    {shortDay(row.appliedOn)}
                  </Td>

                  <Td className="align-top">
                    <span className="flex flex-wrap gap-1.5">
                      <LinkChip href={row.jobUrl} label="Job" />
                      <LinkChip href={row.careersUrl} label="Careers" />
                      {!row.jobUrl && !row.careersUrl && (
                        <span className="text-xs text-[var(--ink-muted)]">—</span>
                      )}
                    </span>
                  </Td>

                  <Td className="align-top">
                    <span className="flex flex-col items-start gap-1">
                      {row.linkedInInviteSent && (
                        <Badge tone="neutral">
                          <Linkedin size={10} className="mr-1" aria-hidden />
                          Invite sent
                        </Badge>
                      )}
                      <Badge tone={row.referralGiven ? 'good' : 'neutral'}>
                        {referralText(row)}
                      </Badge>
                    </span>
                  </Td>

                  <Td nowrap className="align-top">
                    <span className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          if (open) {
                            setEditing(null);
                            setEditForm(null);
                          } else {
                            setEditing(row.id);
                            setEditForm(formFrom(row));
                          }
                        }}
                      >
                        {open ? 'Close' : 'Edit'}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        icon={Trash2}
                        busy={remove.isPending && remove.variables?.id === row.id}
                        onClick={() =>
                          remove.mutate({ id: row.id, company: row.company })
                        }
                        aria-label={`Remove ${row.company}`}
                      />
                    </span>
                  </Td>
                </Tr>
              );
            })}
          </Table>
        )}
      </Card>

      <p className="flex items-start gap-1.5 px-1 text-xs text-[var(--ink-muted)]">
        <Building2 size={13} className="mt-0.5 shrink-0" aria-hidden />
        Separate from the Applications screen on purpose. That one is what this system
        prepared for you; this one is what you did yourself, and nothing you write here
        changes what gets discovered or scored.
      </p>
    </div>
  );
}
