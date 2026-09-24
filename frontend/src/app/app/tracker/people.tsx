"use client";

import { useMutation } from "@tanstack/react-query";
import {
  ArrowRight,
  ExternalLink,
  Mail,
  Plus,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { useState } from "react";
import { useToast } from "@/components/toast";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  controlClass,
  EmptyState,
} from "@/components/ui";
import {
  api,
  type TrackedContact,
  type TrackedContactPatch,
  type TrackerView,
} from "@/lib/api";
import { cn } from "@/lib/utils";

/** The form's own state: all strings, because that is what an input holds. */
interface ContactForm {
  name: string;
  company: string;
  role: string;
  linkedInUrl: string;
  email: string;
  note: string;
}

function emptyForm(): ContactForm {
  return {
    name: "",
    company: "",
    role: "",
    linkedInUrl: "",
    email: "",
    note: "",
  };
}

function formFrom(contact: TrackedContact): ContactForm {
  return {
    name: contact.name,
    company: contact.company ?? "",
    role: contact.role ?? "",
    linkedInUrl: contact.linkedInUrl ?? "",
    email: contact.email ?? "",
    note: contact.note ?? "",
  };
}

function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** What changed, as a PATCH body. Same reasoning as the applications tab. */
function changes(
  original: ContactForm,
  next: ContactForm,
): TrackedContactPatch {
  const patch: TrackedContactPatch = {};
  if (next.name.trim() !== original.name.trim()) patch.name = next.name.trim();
  if (orNull(next.company) !== orNull(original.company)) {
    patch.company = orNull(next.company);
  }
  if (orNull(next.role) !== orNull(original.role))
    patch.role = orNull(next.role);
  if (orNull(next.linkedInUrl) !== orNull(original.linkedInUrl)) {
    patch.linkedInUrl = orNull(next.linkedInUrl);
  }
  if (orNull(next.email) !== orNull(original.email)) {
    patch.email = orNull(next.email);
  }
  if (orNull(next.note) !== orNull(original.note))
    patch.note = orNull(next.note);
  return patch;
}

/** The fields of one person, shared by the add form and every edit panel. */
function ContactFields({
  form,
  set,
  idPrefix,
}: {
  form: ContactForm;
  set: (next: ContactForm) => void;
  idPrefix: string;
}) {
  const field = (name: string) => `${idPrefix}-${name}`;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label
            htmlFor={field("name")}
            className="mb-1 block text-xs text-[var(--ink-muted)]"
          >
            Name
          </label>
          <input
            id={field("name")}
            className={cn(controlClass, "w-full")}
            placeholder="Priya Nair"
            value={form.name}
            maxLength={120}
            onChange={(event) => set({ ...form, name: event.target.value })}
          />
        </div>
        <div>
          <label
            htmlFor={field("company")}
            className="mb-1 block text-xs text-[var(--ink-muted)]"
          >
            Where they work
          </label>
          <input
            id={field("company")}
            className={cn(controlClass, "w-full")}
            placeholder="Zoho"
            value={form.company}
            maxLength={120}
            onChange={(event) => set({ ...form, company: event.target.value })}
          />
        </div>
        <div>
          <label
            htmlFor={field("role")}
            className="mb-1 block text-xs text-[var(--ink-muted)]"
          >
            Their role
          </label>
          <input
            id={field("role")}
            className={cn(controlClass, "w-full")}
            placeholder="Engineering Manager"
            value={form.role}
            maxLength={160}
            onChange={(event) => set({ ...form, role: event.target.value })}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label
            htmlFor={field("linkedin")}
            className="mb-1 block text-xs text-[var(--ink-muted)]"
          >
            LinkedIn
          </label>
          <input
            id={field("linkedin")}
            className={cn(controlClass, "w-full")}
            placeholder="linkedin.com/in/priya-nair"
            value={form.linkedInUrl}
            maxLength={500}
            onChange={(event) =>
              set({ ...form, linkedInUrl: event.target.value })
            }
          />
        </div>
        <div>
          <label
            htmlFor={field("email")}
            className="mb-1 block text-xs text-[var(--ink-muted)]"
          >
            Email
          </label>
          <input
            id={field("email")}
            type="email"
            className={cn(controlClass, "w-full")}
            placeholder="priya@example.com"
            value={form.email}
            maxLength={200}
            onChange={(event) => set({ ...form, email: event.target.value })}
          />
        </div>
      </div>

      <div>
        <label
          htmlFor={field("note")}
          className="mb-1 block text-xs text-[var(--ink-muted)]"
        >
          How you know them
        </label>
        <input
          id={field("note")}
          className={cn(controlClass, "w-full")}
          // An example rather than an instruction, for the reason KIND_TEXT_PLACEHOLDER
          // gives: "enter a note" tells nobody anything they had not worked out.
          placeholder="Worked together at Freshworks; happy to be asked again"
          value={form.note}
          maxLength={500}
          onChange={(event) => set({ ...form, note: event.target.value })}
        />
      </div>
    </div>
  );
}

/**
 * The people who might put a word in for you.
 *
 * WHY THIS IS A TAB AND NOT A TEXT BOX ON EACH APPLICATION. A referrer typed per row becomes
 * "Priya Nair", "priya" and "Priya (Zoho)" inside a month, and then the question this list
 * exists to answer - who is actually vouching for me, and how often have I asked them -
 * cannot be answered at all. Kept as people, each one carries their own count, and asking
 * the same person a fifth time is something you can see before you do it.
 *
 * ADDING SOMEBODY HERE IS NOT CONTACTING THEM. Nothing on this screen sends an email or a
 * LinkedIn request; the address and the profile link are stored so that you do not have to
 * go and find them again.
 */
export function PeopleTab({
  view,
  onSettled,
  onShowApplications,
}: {
  view: TrackerView;
  onSettled: (next: TrackerView) => void;
  /** Hands the reader over to the Applications tab, filtered to this person's referrals. */
  onShowApplications: (contactId: string) => void;
}) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<ContactForm>(emptyForm);
  const [editing, setEditing] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<ContactForm | null>(null);

  /** The server's response is the new cache. See the note in applications.tsx. */
  const settle = onSettled;

  const add = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<TrackerView>("/api/me/tracker/contacts", body),
    onSuccess: (next) => {
      settle(next);
      setForm(emptyForm());
      setAdding(false);
      toast.success("Added. They will show up in the referrer list.");
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const edit = useMutation({
    mutationFn: (vars: { id: string; patch: TrackedContactPatch }) =>
      api.patch<TrackerView>(`/api/me/tracker/contacts/${vars.id}`, vars.patch),
    onSuccess: (next) => {
      settle(next);
      setEditing(null);
      setEditForm(null);
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const remove = useMutation({
    mutationFn: (vars: { id: string; name: string }) =>
      api.del<TrackerView>(`/api/me/tracker/contacts/${vars.id}`),
    onSuccess: (next, vars) => {
      settle(next);
      toast.success(`${vars.name} is off your list.`);
    },
    // The interesting failure: the server refuses to delete somebody who is named as the
    // referrer on an application, and says which ones. That message is the whole point of
    // the refusal, so it goes to the reader unedited.
    onError: (err) => toast.error((err as Error).message),
  });

  const full = view.contacts.length >= view.maxContacts;
  const ready = form.name.trim().length > 0;

  const submit = () => {
    if (!ready || full) return;
    add.mutate({
      name: form.name.trim(),
      ...(form.company.trim() ? { company: form.company.trim() } : {}),
      ...(form.role.trim() ? { role: form.role.trim() } : {}),
      ...(form.linkedInUrl.trim()
        ? { linkedInUrl: form.linkedInUrl.trim() }
        : {}),
      ...(form.email.trim() ? { email: form.email.trim() } : {}),
      ...(form.note.trim() ? { note: form.note.trim() } : {}),
    });
  };

  const saveEdit = (contact: TrackedContact) => {
    if (!editForm) return;
    if (editForm.name.trim().length === 0) {
      toast.error("A person needs a name.");
      return;
    }
    const patch = changes(formFrom(contact), editForm);
    if (Object.keys(patch).length === 0) {
      setEditing(null);
      setEditForm(null);
      return;
    }
    edit.mutate({ id: contact.id, patch });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="People who could refer you"
          subtitle="Added by hand, because nothing here can be discovered: who owes you a favour is not on a careers page. Once somebody is on this list they can be picked as the referrer on any application — and their count below opens the ones they referred."
          icon={Users}
          action={
            <Button
              variant={adding ? "ghost" : "primary"}
              size="sm"
              icon={adding ? X : UserPlus}
              disabled={!adding && full}
              onClick={() => setAdding(!adding)}
            >
              {adding ? "Cancel" : "Add someone"}
            </Button>
          }
        />

        {adding && (
          <div className="space-y-4 border-b border-[var(--border)] px-5 py-4">
            <ContactFields form={form} set={setForm} idPrefix="new-contact" />
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                icon={Plus}
                busy={add.isPending}
                disabled={!ready}
                onClick={submit}
              >
                Add person
              </Button>
              <p className="text-xs text-[var(--ink-muted)]">
                Only the name is required. Nothing on this screen contacts
                anybody.
              </p>
            </div>
          </div>
        )}

        {full && (
          <p
            className="border-b border-[var(--border)] px-5 py-3 text-xs"
            style={{ color: "var(--status-warning)" }}
          >
            That is {view.maxContacts} people, which is as many as this list
            holds. It is meant to be the ones who would vouch for you rather
            than everyone you have met.
          </p>
        )}

        {view.contacts.length === 0 ? (
          <EmptyState
            icon={Users}
            title="Nobody on the list yet"
            detail="Add the person most likely to put your name forward. A name on its own is enough — the company, their role and how you know them are there for when you come back to this in six months."
          />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {view.contacts.map((contact) => {
              const open = editing === contact.id;
              return (
                <li key={contact.id} className="px-5 py-3.5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm text-[var(--ink-primary)]">
                        <span className="font-medium">{contact.name}</span>
                        {/* The count, always, including zero. A list where only the
                            well-used contacts carry a number reads as though the rest have
                            never been asked for anything, which may be the opposite of
                            true - they may be the ones still worth asking.

                            A button once there is something behind it, plain text when there
                            is not: a zero that looks clickable and then shows an empty list
                            has taught the reader nothing and cost them the tab they were
                            on. */}
                        {contact.referrals === 0 ? (
                          <Badge tone="neutral">no referrals yet</Badge>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onShowApplications(contact.id)}
                            title={`Show the applications ${contact.name} referred`}
                            // Spelled out for a screen reader, where "3 referrals" on its own
                            // gives no hint that it goes anywhere.
                            aria-label={`Show the ${contact.referrals} application${
                              contact.referrals === 1 ? "" : "s"
                            } ${contact.name} referred`}
                            className="rounded-[var(--r-full)] transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                          >
                            <Badge tone="good">
                              {contact.referrals} referral
                              {contact.referrals === 1 ? "" : "s"}
                              <ArrowRight
                                size={10}
                                className="ml-1"
                                aria-hidden
                              />
                            </Badge>
                          </button>
                        )}
                      </p>

                      {(contact.role || contact.company) && (
                        <p className="mt-0.5 text-xs text-[var(--ink-secondary)]">
                          {[contact.role, contact.company]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      )}

                      {contact.note && (
                        <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                          {contact.note}
                        </p>
                      )}

                      <p className="mt-1 flex flex-wrap gap-2">
                        {contact.linkedInUrl && (
                          <a
                            href={contact.linkedInUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="inline-flex items-center gap-1 text-xs text-[var(--link)] hover:underline"
                          >
                            LinkedIn
                            <ExternalLink size={10} aria-hidden />
                          </a>
                        )}
                        {contact.email && (
                          <a
                            href={`mailto:${contact.email}`}
                            className="inline-flex items-center gap-1 text-xs text-[var(--link)] hover:underline"
                          >
                            <Mail size={11} aria-hidden />
                            {contact.email}
                          </a>
                        )}
                      </p>
                    </div>

                    <div className="flex shrink-0 gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          if (open) {
                            setEditing(null);
                            setEditForm(null);
                          } else {
                            setEditing(contact.id);
                            setEditForm(formFrom(contact));
                          }
                        }}
                      >
                        {open ? "Close" : "Edit"}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        icon={Trash2}
                        busy={
                          remove.isPending &&
                          remove.variables?.id === contact.id
                        }
                        onClick={() =>
                          remove.mutate({ id: contact.id, name: contact.name })
                        }
                        aria-label={`Remove ${contact.name}`}
                      />
                    </div>
                  </div>

                  {open && editForm && (
                    <div className="mt-3 max-w-3xl space-y-4 rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--surface-hover)] p-4">
                      <ContactFields
                        form={editForm}
                        set={setEditForm}
                        idPrefix={`edit-contact-${contact.id}`}
                      />
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="primary"
                          size="sm"
                          busy={
                            edit.isPending && edit.variables?.id === contact.id
                          }
                          onClick={() => saveEdit(contact)}
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
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <p className="px-1 text-xs text-[var(--ink-muted)]">
        Somebody named as the referrer on an application cannot be removed until
        that referral is cleared. Deleting them would turn “referred by them”
        into “referred by nobody” with nothing left to show it happened.
      </p>
    </div>
  );
}
