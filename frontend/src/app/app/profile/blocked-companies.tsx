'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useToast } from '@/components/toast';
import {
  Button,
  Card,
  CardHeader,
  controlClass,
  ErrorNote,
  SkeletonCard,
} from '@/components/ui';
import { api, type BlockedCompaniesView } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Employers you will not apply to.
 *
 * WHY A TEXT BOX AND NOT A PICKER, when the locations card three sections up refuses to
 * take typed input. The reasoning is genuinely opposite in the two cases. A typed city is
 * a word handed to the matcher with no way to tell "spelled wrong" from "no jobs there",
 * so the cities are a catalogue. An employer you want to avoid is very often one this
 * system has never heard of - the company you just left has no row here until some board
 * of theirs is crawled, which may be never. A picker would make the rule unstatable until
 * exactly too late, which is when the job appears in your shortlist.
 *
 * SO THE SAFEGUARD IS FEEDBACK, NOT A CONSTRAINT. Every entry says which employers on
 * record it covers and how many open postings it is keeping out, because the rule matches
 * on words: "Tech" reads as one company and covers eleven. A rule that is quietly too
 * broad is the failure worth designing against - a screened-out posting leaves no row
 * behind anywhere, so over-blocking is invisible and looks like a quiet job market.
 *
 * "Nothing on record yet" is not an error and does not warn. It is the normal state for
 * the employer this feature is usually added for.
 */
export function BlockedCompaniesCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const [label, setLabel] = useState('');
  const [reason, setReason] = useState('');

  const blocked = useQuery({
    queryKey: ['me', 'blocked-companies'],
    queryFn: () =>
      api.get<BlockedCompaniesView>('/api/me/blocked-companies'),
  });

  /**
   * Both writes return the whole list, so `setQueryData` is enough and there is no
   * refetch of this card. A second round trip would be a second chance for the screen
   * to show a count that does not match the list beside it.
   *
   * The shortlist IS refetched, because the rule applies to postings scored before it
   * existed: a suggestion for the employer just ruled out should not still be sitting
   * on the matches screen in another tab. Same on removal, in the other direction.
   */
  const settle = (view: BlockedCompaniesView) => {
    qc.setQueryData(['me', 'blocked-companies'], view);
    void qc.invalidateQueries({ queryKey: ['me', 'matches'] });
    void qc.invalidateQueries({ queryKey: ['me', 'overview'] });
  };

  const add = useMutation({
    mutationFn: (body: { label: string; reason?: string }) =>
      api.post<BlockedCompaniesView>('/api/me/blocked-companies', body),
    onSuccess: (view, vars) => {
      settle(view);
      setLabel('');
      setReason('');
      const saved = view.entries.find((entry) => entry.label === vars.label);
      // The count is the useful half of the confirmation: it is how somebody finds out
      // immediately that they blocked eleven employers instead of one.
      toast.success(
        saved && saved.matches.length > 0
          ? `${vars.label} is out. That covers ${saved.matches.length} employer${
              saved.matches.length === 1 ? '' : 's'
            } on record and ${saved.postings} open posting${saved.postings === 1 ? '' : 's'}.`
          : `${vars.label} is out. Nothing on record matches it yet — the rule will apply as soon as something does.`,
      );
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const remove = useMutation({
    mutationFn: (entry: { id: string; label: string }) =>
      api.del<BlockedCompaniesView>(`/api/me/blocked-companies/${entry.id}`),
    onSuccess: (view, vars) => {
      settle(view);
      toast.success(
        `${vars.label} is back in. Any suggestions that were hidden will reappear.`,
      );
    },
    onError: (err) => toast.error((err as Error).message),
  });

  if (blocked.isLoading) return <SkeletonCard rows={3} />;
  if (blocked.error) {
    return <ErrorNote message={(blocked.error as Error).message} />;
  }
  if (!blocked.data) return null;

  const view = blocked.data;
  const trimmed = label.trim();
  const full = view.entries.length >= view.maxEntries;

  const submit = () => {
    if (trimmed.length === 0 || full) return;
    add.mutate({
      label: trimmed,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    });
  };

  return (
    <Card>
      <CardHeader
        title="Employers to skip"
        subtitle="Somewhere you have already worked, somewhere that has already said no, an agency that will not stop calling. Their jobs are dropped before anything is read closely, and no application is ever prepared for them."
      />

      <div className="space-y-4 px-5 py-4 text-sm">
        {/* The form first, because on an empty list it is the only thing to do, and on a
            long one it is still what the reader came for. */}
        <div className="flex flex-wrap items-start gap-2">
          <div className="min-w-[12rem] flex-1">
            <label
              htmlFor="blocked-company"
              className="mb-1 block text-xs text-[var(--ink-muted)]"
            >
              Company name
            </label>
            <input
              id="blocked-company"
              // A suggestion list, not a constraint: the point of the free text is that
              // it accepts an employer nothing here has heard of.
              list="known-companies"
              className={cn(controlClass, 'w-full')}
              placeholder="Hyscaler"
              value={label}
              maxLength={120}
              onChange={(event) => setLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <datalist id="known-companies">
              {view.known.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>

          <div className="min-w-[12rem] flex-1">
            <label
              htmlFor="blocked-reason"
              className="mb-1 block text-xs text-[var(--ink-muted)]"
            >
              Why <span className="text-[var(--ink-muted)]">(optional)</span>
            </label>
            <input
              id="blocked-reason"
              className={cn(controlClass, 'w-full')}
              placeholder="Worked there 2023–2025"
              value={reason}
              maxLength={200}
              onChange={(event) => setReason(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </div>

          <Button
            className="mt-[1.375rem]"
            variant="primary"
            icon={Plus}
            busy={add.isPending}
            disabled={trimmed.length === 0 || full}
            onClick={submit}
          >
            Skip them
          </Button>
        </div>

        {full && (
          <p className="text-xs" style={{ color: 'var(--status-warning)' }}>
            That is {view.maxEntries} employers, which is as many as this list holds.
            A list this long usually means the title or location rules are the ones
            worth narrowing.
          </p>
        )}

        {view.entries.length === 0 ? (
          <p className="text-xs text-[var(--ink-muted)]">
            Nothing is skipped. Every employer found is considered on the merits of
            the posting.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {view.entries.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-start justify-between gap-3 py-2.5 first:pt-0"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-[var(--ink-primary)]">
                    <Ban size={13} className="shrink-0" aria-hidden />
                    {entry.label}
                  </p>
                  {entry.reason && (
                    <p className="mt-0.5 text-xs text-[var(--ink-secondary)]">
                      {entry.reason}
                    </p>
                  )}
                  {/* What the rule reaches. The whole safeguard against a word that
                      covers more than the reader meant. */}
                  <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                    {entry.matches.length === 0
                      ? 'Nothing on record matches this yet.'
                      : `Covers ${entry.matches.join(', ')} — ${entry.postings} open posting${
                          entry.postings === 1 ? '' : 's'
                        } held back.`}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={X}
                  busy={remove.isPending && remove.variables?.id === entry.id}
                  onClick={() =>
                    remove.mutate({ id: entry.id, label: entry.label })
                  }
                >
                  Undo
                </Button>
              </li>
            ))}
          </ul>
        )}

        <p className="border-t border-[var(--border)] pt-3 text-xs text-[var(--ink-muted)]">
          Matched on whole words, so “Hyscaler” also covers “HyScaler Solutions Pvt.
          Ltd.” but “Ola” does not touch Motorola. Removing an entry brings its jobs
          straight back — nothing is deleted, and no verdict is recorded against those
          postings on your behalf.
        </p>
      </div>
    </Card>
  );
}
