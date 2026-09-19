'use client';

import { useMutation } from '@tanstack/react-query';
import { Lightbulb, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useToast } from '@/components/toast';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  controlClass,
} from '@/components/ui';
import { api, type ResumeSuggestion, type SuggestionsResult } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * What the model thinks is weak about this resume, piece by piece.
 *
 * TWO KINDS, SHOWN DIFFERENTLY, and the difference is not cosmetic. A `rewrite` has
 * already been through the provenance guard on the server against the piece it cites, so
 * every number in it appears in that piece's own figures and every technology in it is
 * one the resume supports - which is what makes it safe to offer as a swap. `advice`
 * names something the resume does NOT contain ("if you know how many services, say so"),
 * which is exactly what the guard rejects and exactly what makes advice worth having. It
 * is therefore shown as a note with nothing to click: the only way that fact reaches the
 * page is the candidate typing it into their own bullet.
 *
 * NOTHING IS APPLIED WITHOUT A SECOND CLICK. Both texts are on screen together and
 * replacing one asks again, because a resume that changed itself while being read is the
 * one failure this whole pipeline is arranged to avoid.
 */
export function SuggestionsPanel({
  resumeId,
  busy,
  onUse,
}: {
  resumeId: string;
  /** True while the editor below is saving, so two writes cannot be started at once. */
  busy: boolean;
  onUse: (input: { atomId: string; text: string }) => void;
}) {
  const toast = useToast();
  const [focus, setFocus] = useState('');
  const [result, setResult] = useState<SuggestionsResult | null>(null);

  const ask = useMutation({
    mutationFn: () =>
      api.post<SuggestionsResult>('/api/me/tailor/suggestions', {
        resumeId,
        focus: focus.trim() || undefined,
      }),
    onSuccess: (data) => setResult(data),
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <Card>
      <CardHeader
        title="Ask for suggestions"
        subtitle="Reads your pieces and says which sentences undersell the work behind them. It cannot add a fact you have not written down — anything that needs one comes back as a note instead."
        action={
          <Button
            size="sm"
            variant="primary"
            icon={Sparkles}
            busy={ask.isPending}
            onClick={() => ask.mutate()}
          >
            {result ? 'Ask again' : 'Ask'}
          </Button>
        }
      />

      <div className="space-y-3 px-5 pb-5">
        <div>
          <label
            className="mb-1.5 block text-xs text-[var(--ink-muted)]"
            htmlFor="suggest-focus"
          >
            What are you aiming at? Optional — one line, in your own words.
          </label>
          <input
            id="suggest-focus"
            className={cn(controlClass, 'w-full')}
            placeholder="e.g. backend roles at product companies, more platform than feature work"
            value={focus}
            maxLength={400}
            onChange={(e) => setFocus(e.target.value)}
          />
        </div>

        {ask.isPending && (
          <p className="text-xs text-[var(--ink-muted)]">
            Thinking about the whole resume at once — this takes a few seconds.
          </p>
        )}

        {result && (
          <>
            {result.overall && (
              <p className="rounded-[var(--r-sm)] bg-[var(--surface-hover)] px-3.5 py-2.5 text-xs leading-relaxed text-[var(--ink-secondary)]">
                {result.overall}
              </p>
            )}

            {result.suggestions.length === 0 ? (
              <EmptyState
                icon={Lightbulb}
                title="Nothing it wanted to change"
                detail={
                  result.rejected > 0
                    ? `${result.rejected} suggestion(s) were thrown out for claiming something your pieces do not support, so none is shown.`
                    : 'It read the pieces and had no specific improvement to propose.'
                }
              />
            ) : (
              <ul className="space-y-2.5">
                {result.suggestions.map((suggestion, at) => (
                  <Suggestion
                    key={`${suggestion.atomId}-${at}`}
                    suggestion={suggestion}
                    busy={busy}
                    onUse={() =>
                      onUse({
                        atomId: suggestion.atomId,
                        text: suggestion.text,
                      })
                    }
                  />
                ))}
              </ul>
            )}

            <p className="text-xs text-[var(--ink-muted)]">
              {result.model}
              {result.rejected > 0 && result.suggestions.length > 0 && (
                <>
                  {' · '}
                  {result.rejected} more were checked against your own figures and
                  thrown out
                </>
              )}
            </p>
          </>
        )}
      </div>
    </Card>
  );
}

function Suggestion({
  suggestion,
  busy,
  onUse,
}: {
  suggestion: ResumeSuggestion;
  busy: boolean;
  onUse: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const isRewrite = suggestion.kind === 'rewrite';

  return (
    <li className="rounded-[var(--r-sm)] border border-[var(--border)] px-3.5 py-3">
      <div className="mb-2 flex items-start justify-between gap-3">
        <p className="text-xs leading-relaxed text-[var(--ink-secondary)]">
          {suggestion.why}
        </p>
        <Badge tone={isRewrite ? 'accent' : 'neutral'}>
          {isRewrite ? 'New wording' : 'Needs a fact from you'}
        </Badge>
      </div>

      <p className="text-xs leading-relaxed text-[var(--ink-muted)]">
        <span className="text-[10px] tracking-wide uppercase">Now</span>{' '}
        {suggestion.current}
      </p>
      <p className="mt-1.5 text-sm leading-relaxed text-[var(--ink-primary)]">
        <span className="text-[10px] tracking-wide text-[var(--ink-muted)] uppercase">
          {isRewrite ? 'Instead' : 'Suggestion'}
        </span>{' '}
        {suggestion.text}
      </p>

      {isRewrite && (
        <div className="mt-2.5">
          {confirming ? (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="primary"
                busy={busy}
                onClick={() => {
                  setConfirming(false);
                  onUse();
                }}
              >
                Replace it
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirming(false)}
              >
                Keep mine
              </Button>
            </div>
          ) : (
            <Button size="sm" onClick={() => setConfirming(true)}>
              Use this wording
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
