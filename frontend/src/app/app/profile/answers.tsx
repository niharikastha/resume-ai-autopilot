'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
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
import {
  api,
  type AnswersView,
  type AskedQuestion,
  type CustomAnswer,
  type StatedAnswers,
} from '@/lib/api';
import { cn, relativeTime } from '@/lib/utils';

/**
 * The answers only the candidate can give.
 *
 * These are typed into real employer forms verbatim. Nothing here is generated,
 * inferred or defaulted, and an empty box means the form filler LEAVES THAT BOX EMPTY -
 * it never picks the common answer. Guessing someone's visa position or notice period
 * in writing, on an application in their name, is worse than a blank field a human
 * fills in at the last step.
 *
 * Every box is optional. Four of them hold an application up, and those are marked
 * rather than enforced: the same four the 09:00 digest asks about, from the same list.
 */
export function AnswersCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);

  const view = useQuery({
    queryKey: ['me', 'answers'],
    queryFn: () => api.get<AnswersView>('/api/me/answers'),
  });

  const save = useMutation({
    mutationFn: (body: Draft) =>
      api.put<AnswersView>('/api/me/answers', toBody(body)),
    onSuccess: (result) => {
      // The draft is dropped and the server's answer becomes the state, same as the
      // card above: a local copy kept alongside it is how a screen starts showing an
      // edit that was never written.
      setDraft(null);
      qc.setQueryData(['me', 'answers'], result);
      // The dashboard raises its blocker from the same four fields, so it is stale.
      void qc.invalidateQueries({ queryKey: ['me', 'overview'] });
      toast.success(
        result.missing.length === 0
          ? 'Saved. Nothing is waiting on an answer.'
          : `Saved. ${result.missing.length} answer(s) still needed before an application can be prepared.`,
      );
    },
    onError: (err) => toast.error((err as Error).message),
  });

  if (view.isLoading) return <SkeletonCard rows={5} />;
  if (view.error) return <ErrorNote message={(view.error as Error).message} />;
  if (!view.data) return null;

  const saved = view.data;
  // The draft appears on the first change only, so an untouched screen shows exactly
  // what the server said.
  const current = draft ?? toDraft(saved.answers);
  const edit = (change: Partial<Draft>) => setDraft({ ...current, ...change });
  const dirty = draft !== null && !same(current, toDraft(saved.answers));
  const missing = new Set(saved.missing);

  const setRow = (index: number, change: Partial<CustomAnswer>) =>
    edit({
      customAnswers: current.customAnswers.map((row, at) =>
        at === index ? { ...row, ...change } : row,
      ),
    });

  const addQuestion = (question: string) =>
    edit({
      customAnswers: [...current.customAnswers, { question, answer: '' }],
    });

  // Offered questions already sitting in a row are dropped. The server filters against
  // what was SAVED; this filters against what is on screen, which is what stops a chip
  // clicked a second time from adding the same question twice before a save.
  const onScreen = new Set(
    current.customAnswers.map((row) => normalizeQuestion(row.question)),
  );
  const asked = saved.asked.filter(
    (entry) => !onScreen.has(normalizeQuestion(entry.question)),
  );
  const starters = saved.suggested.filter(
    (question) => !onScreen.has(normalizeQuestion(question)),
  );
  const full = current.customAnswers.length >= MAX_CUSTOM;

  return (
    <Card>
      <CardHeader
        title="Application answers"
        subtitle="Work authorization, notice period, current and expected CTC, relocation. Typed once here, then reused on every form."
        action={
          saved.missing.length > 0 ? (
            <Badge tone="warning">{saved.missing.length} still needed</Badge>
          ) : saved.stated ? (
            <Badge tone="good">Complete</Badge>
          ) : undefined
        }
      />

      <div className="space-y-5 px-5 py-4 text-sm">
        <p className="text-xs text-[var(--ink-muted)]">
          Anything left empty here is left empty on the form too — never filled in with
          a likely answer. An administrator cannot read or write any of it.
          {saved.updatedAt && ` Last saved ${relativeTime(saved.updatedAt)}.`}
        </p>

        <Field
          label="Work authorization"
          hint="In your own words, as you would write it on a form."
          needed={missing.has('workAuthorization')}
        >
          <input
            className={cn(controlClass, 'w-full')}
            value={current.workAuthorization}
            onChange={(event) =>
              edit({ workAuthorization: event.target.value })
            }
            placeholder="Indian citizen, no sponsorship required"
            maxLength={2000}
          />
        </Field>

        <Field
          group
          label="Do you need visa sponsorship?"
          hint="Left blank on the form until you answer it here."
          needed={missing.has('needsSponsorship')}
        >
          <YesNo
            value={current.needsSponsorship}
            onChange={(needsSponsorship) => edit({ needsSponsorship })}
          />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Notice period, in days"
            hint="0 if you can start immediately."
            needed={missing.has('noticePeriodDays')}
          >
            <input
              className={cn(controlClass, 'w-full')}
              value={current.noticePeriodDays}
              onChange={(event) =>
                edit({ noticePeriodDays: event.target.value })
              }
              inputMode="numeric"
              placeholder="60"
            />
          </Field>

          <Field label="Earliest start date" hint="Optional.">
            <input
              type="date"
              className={cn(controlClass, 'w-full')}
              value={current.earliestStartDate}
              onChange={(event) =>
                edit({ earliestStartDate: event.target.value })
              }
            />
          </Field>

          <Field
            label="Current CTC, in LPA"
            hint="Leave it empty if you would rather not state it, or have none yet."
          >
            <input
              className={cn(controlClass, 'w-full')}
              value={current.currentCtcLpa}
              onChange={(event) => edit({ currentCtcLpa: event.target.value })}
              inputMode="decimal"
              placeholder="12.5"
            />
          </Field>

          <Field
            label="Expected CTC, in LPA"
            hint="Asked on almost every Indian form."
            needed={missing.has('expectedCtcLpa')}
          >
            <input
              className={cn(controlClass, 'w-full')}
              value={current.expectedCtcLpa}
              onChange={(event) => edit({ expectedCtcLpa: event.target.value })}
              inputMode="decimal"
              placeholder="20"
            />
          </Field>
        </div>

        <Field
          group
          label="Would you relocate?"
          hint="A different question from where you will work — that is the card above."
        >
          <YesNo
            value={current.willingToRelocate}
            onChange={(willingToRelocate) => edit({ willingToRelocate })}
          />
        </Field>

        {/* The questions that come back on every third form, answered once. */}
        <div className="border-t border-[var(--border)] pt-4">
          <p className="text-[var(--ink-primary)]">
            Questions you keep being asked
          </p>
          <p className="mt-1 mb-3 text-xs text-[var(--ink-muted)]">
            Write the question the way a form asks it. When one asks it again, this
            answer is used — matched loosely, so punctuation and a trailing asterisk do
            not matter.
          </p>

          {/* The questions the forms themselves asked, offered back.
              WHY THIS IS HERE: without it the only way to fill this library was to
              remember a question, guess the wording, and hope it came round again — so
              it stayed empty and every form reported "no stored answer matches". Each
              chip is one click and then a sentence. */}
          {!full && (asked.length > 0 || starters.length > 0) && (
            <div className="mb-4 space-y-3">
              {asked.length > 0 && (
                <div>
                  <p className="text-xs text-[var(--ink-secondary)]">
                    Asked by forms you have already prepared, and left blank because
                    nothing here answered them:
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {asked.map((entry) => (
                      <Offer
                        key={entry.question}
                        question={entry.question}
                        note={offerNote(entry)}
                        title={askedTitle(entry)}
                        onClick={() => addQuestion(entry.question)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {starters.length > 0 && (
                <div>
                  {/* Says "the question" and not "an answer" on purpose: these carry no
                      suggested answer, here or on the server. */}
                  <p className="text-xs text-[var(--ink-secondary)]">
                    Common on Indian forms. Adding one fills in the question — the answer
                    is yours to write:
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {starters.map((question) => (
                      <Offer
                        key={question}
                        question={question}
                        onClick={() => addQuestion(question)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="space-y-2">
            {current.customAnswers.map((row, index) => (
              // Keyed by position, deliberately. There is no id to key by, and the
              // question text is the field being typed into - keying on it would
              // remount the input on every keystroke and lose the cursor.
              <div key={index} className="flex flex-col gap-2 sm:flex-row">
                <input
                  className={cn(controlClass, 'sm:w-2/5')}
                  value={row.question}
                  onChange={(event) =>
                    setRow(index, { question: event.target.value })
                  }
                  placeholder="Why do you want to work here?"
                  maxLength={500}
                />
                <input
                  className={cn(controlClass, 'flex-1')}
                  value={row.answer}
                  onChange={(event) =>
                    setRow(index, { answer: event.target.value })
                  }
                  placeholder="Your answer, in your own words"
                  maxLength={2000}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  icon={Trash2}
                  aria-label={`Remove question ${index + 1}`}
                  onClick={() =>
                    edit({
                      customAnswers: current.customAnswers.filter(
                        (_, at) => at !== index,
                      ),
                    })
                  }
                />
              </div>
            ))}
          </div>

          <Button
            size="sm"
            icon={Plus}
            className="mt-2"
            disabled={full}
            onClick={() => addQuestion('')}
          >
            Add a question
          </Button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-4">
          <p className="text-xs text-[var(--ink-muted)]">
            {saved.missing.length > 0
              ? 'An application waits until the marked boxes are filled in. The morning digest asks about the same ones.'
              : 'Nothing is waiting on an answer.'}
          </p>
          <Button
            variant="primary"
            onClick={() => save.mutate(current)}
            busy={save.isPending}
            disabled={!dirty}
          >
            Save answers
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** The same cap as CUSTOM_ANSWERS_MAX on the server, so it is reached here first. */
const MAX_CUSTOM = 50;

/**
 * One offered question: a click that adds a row with the question already typed.
 *
 * A button and not a link or a chip-with-a-close: the only thing it does is add a row,
 * and it disappears once the row exists because the row is then the thing to edit.
 */
function Offer({
  question,
  note,
  title,
  onClick,
}: {
  question: string;
  note?: string;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="inline-flex max-w-full items-center gap-1.5 rounded-[var(--r-sm)] border border-dashed border-[var(--border-strong)] px-2 py-1 text-left text-xs text-[var(--ink-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
    >
      <Plus size={11} aria-hidden className="shrink-0" />
      {/* Truncated rather than wrapped. A form's own label runs to a sentence and a
          three-line chip stops reading as one thing to click; the full text lands in the
          input the moment it is added, and in the tooltip before that. */}
      <span className="truncate">{question}</span>
      {note && <span className="shrink-0 text-[var(--ink-muted)]">{note}</span>}
    </button>
  );
}

/** The short reason to answer this one first. Nothing for a question asked once by a
 *  form that did not require it - a count of 1 is not information. */
function offerNote(entry: AskedQuestion): string | undefined {
  const parts = [
    entry.timesAsked > 1 ? `${entry.timesAsked} forms` : '',
    entry.required ? 'required' : '',
  ].filter((part) => part !== '');
  return parts.length === 0 ? undefined : `· ${parts.join(' · ')}`;
}

function askedTitle(entry: AskedQuestion): string {
  const when = entry.lastAskedAt
    ? `, last ${relativeTime(entry.lastAskedAt)}`
    : '';
  return `${entry.question}\nAsked on ${entry.timesAsked} prepared application${
    entry.timesAsked === 1 ? '' : 's'
  }${when}.`;
}

/**
 * The same comparison the server and the form filler make.
 *
 * DUPLICATED HERE KNOWINGLY, and it is the one place that is safe: this decides only
 * whether to keep showing a chip. The server re-filters on save and the form filler
 * matches at fill time, so a drift between the two costs a chip that lingers - never a
 * duplicate stored answer or a question answered from the wrong row.
 */
function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The form's own state: strings, because that is what an input holds.
 *
 * A separate shape from the API's, on purpose. A half-typed "1" in the notice-period
 * box is not a number yet, and a draft that stored numbers would have to decide what
 * to do with it on every keystroke.
 */
interface Draft {
  workAuthorization: string;
  needsSponsorship: boolean | null;
  noticePeriodDays: string;
  currentCtcLpa: string;
  expectedCtcLpa: string;
  willingToRelocate: boolean | null;
  earliestStartDate: string;
  customAnswers: CustomAnswer[];
}

function toDraft(answers: StatedAnswers): Draft {
  return {
    workAuthorization: answers.workAuthorization ?? '',
    needsSponsorship: answers.needsSponsorship,
    noticePeriodDays:
      answers.noticePeriodDays === null ? '' : String(answers.noticePeriodDays),
    currentCtcLpa: answers.currentCtcLpa ?? '',
    expectedCtcLpa: answers.expectedCtcLpa ?? '',
    willingToRelocate: answers.willingToRelocate,
    earliestStartDate: answers.earliestStartDate ?? '',
    customAnswers: answers.customAnswers.map((row) => ({ ...row })),
  };
}

/**
 * The draft as the API takes it.
 *
 * Empty becomes null and NOT an empty string, because the two mean different things
 * further down: null leaves the box on the employer's form alone, '' would be an
 * answer that says nothing. The money boxes stay strings the whole way - see
 * StatedAnswers - so an exact figure cannot pick up a float's rounding on the trip.
 */
function toBody(draft: Draft) {
  const number = (value: string) => {
    const trimmed = value.trim();
    // Not validated here beyond this. A notice period of "sixty" is refused by the
    // server, whose message names the field and the range - more use than "invalid".
    return trimmed === '' ? null : Number(trimmed);
  };

  return {
    workAuthorization: draft.workAuthorization.trim() || null,
    needsSponsorship: draft.needsSponsorship,
    noticePeriodDays: number(draft.noticePeriodDays),
    currentCtcLpa: draft.currentCtcLpa.trim() || null,
    expectedCtcLpa: draft.expectedCtcLpa.trim() || null,
    willingToRelocate: draft.willingToRelocate,
    earliestStartDate: draft.earliestStartDate.trim() || null,
    // A row where both boxes are empty is a row that was added and never typed into.
    customAnswers: draft.customAnswers.filter(
      (row) => row.question.trim() !== '' || row.answer.trim() !== '',
    ),
  };
}

/** Order matters here, unlike the city list: these are rows the candidate arranged. */
function same(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A labelled box, marked when it is one of the four an application waits on.
 *
 * `group` for the yes/no rows, because those are three buttons and a <label> wrapping
 * buttons hands its click to the first one - which would answer the question by
 * clicking near it. A fieldset and legend say the same thing to a screen reader
 * without the misdirected click.
 */
function Field({
  group,
  label,
  hint,
  needed,
  children,
}: {
  group?: boolean;
  label: string;
  hint: string;
  needed?: boolean;
  children: React.ReactNode;
}) {
  const heading = (
    <>
      <span className="flex items-center gap-2 text-[var(--ink-primary)]">
        {label}
        {needed && (
          <span
            className="text-[11px] font-medium"
            style={{ color: 'var(--status-warning)' }}
          >
            needed
          </span>
        )}
      </span>
      <span className="mt-0.5 mb-1.5 block text-xs text-[var(--ink-muted)]">
        {hint}
      </span>
    </>
  );

  if (group) {
    return (
      <fieldset>
        <legend className="block">{heading}</legend>
        {children}
      </fieldset>
    );
  }

  return (
    <label className="block">
      {heading}
      {children}
    </label>
  );
}

/**
 * Yes, No, or nothing yet.
 *
 * Three states and not a checkbox, because a checkbox has two and one of them would
 * have to stand in for "not answered". "No, I do not need sponsorship" and "I have
 * not said" are different things to type onto a form, and only one of them is safe to
 * fill in on somebody's behalf.
 */
function YesNo({
  value,
  onChange,
}: {
  value: boolean | null;
  onChange: (value: boolean | null) => void;
}) {
  const options: { label: string; value: boolean | null }[] = [
    { label: 'Not answered', value: null },
    { label: 'Yes', value: true },
    { label: 'No', value: false },
  ];

  return (
    <div className="inline-flex overflow-hidden rounded-[var(--r-sm)] border border-[var(--border-strong)]">
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'px-3 py-1.5 text-xs transition-colors',
            value === option.value
              ? 'bg-[var(--accent)] font-medium text-[var(--accent-ink)]'
              : 'text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)]',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
