/**
 * Suggestions on the resume the candidate is editing, with no posting in sight.
 *
 * WHY THIS IS NOT tailorResumeTask WITH AN EMPTY POSTING. Tailoring answers "which of
 * these atoms does THIS job care about" and returns a whole document; this answers
 * "which of these sentences is weaker than the work behind it" and returns a list of
 * opinions about individual atoms. Feeding a blank posting to the tailoring task would
 * get a resume back - a selection, a headline, a cover letter - none of which the edit
 * screen has anywhere to put, and all of which would cost a deep-tier call to throw
 * away.
 *
 * TWO KINDS OF SUGGESTION, and the distinction is the whole safety argument:
 *
 *   rewrite  Replacement wording for one atom. It becomes resume text, so it goes
 *            through the provenance guard exactly as a tailored rewrite does - same
 *            function, same rules - and a suggestion that fails is not shown.
 *   advice   A sentence addressed to the CANDIDATE, never to an employer. "This bullet
 *            has no number in it; if you know the figure, add it." It is deliberately
 *            NOT guarded, because advice that names something absent from the resume
 *            is the point of advice, and because nothing here can put it on a page -
 *            only a person typing it into their own bullet can.
 *
 * The guard is applied by the caller, not here. See SuggestionsService.
 *
 * `deep` tier. This is the model reading someone's career and proposing the words an
 * employer will judge them on; a cheap model's version of that is generic advice about
 * "leveraging synergies", which is worse than no advice because it takes a slot.
 */
import { z } from 'zod';
import { LlmTask } from '../llm.types';

/**
 * The same hard rules the tailoring task states, narrowed to a rewrite.
 *
 * Restated rather than imported, because this prompt has no posting in it and the
 * tailoring version's reasons refer to one ("you may not add a technology because the
 * posting asks for it"). A rule whose stated reason does not apply to the situation is
 * a rule the model argues itself out of.
 */
const RULES = `Hard rules. A checker verifies every rewrite you propose against the
atom it cites, and silently discards any that breaks one of these - so an
embellished number does not reach the candidate at all:

  1. A rewrite says the same thing the atom says, better. You may change wording,
     emphasis, verbs, order and length. You may not change what happened.
  2. Every number, percentage, duration and quantity in a rewrite must already
     appear in that atom's listed metrics. You may drop a figure. You may not
     change one, round one, or add one.
  3. Every technology you name in a rewrite must appear in the candidate's
     technology list below. If a bullet would be stronger for naming a tool the
     candidate has not listed, say so as advice instead - never write it into the
     text.
  4. Employer names and date ranges are copied byte for byte or left out.
  5. Do not suggest a rewrite that is merely a synonym swap. If the sentence is
     already good, leave it alone and spend the slot on one that is not.`;

/** The candidate, once. Same shape as the tailoring task's prefix for the same reason. */
export interface SuggestShared {
  fullName: string;
  headline: string | null;
  atoms: {
    id: string;
    kind: string;
    text: string;
    tech: string[];
    metrics: string[];
    employer?: string | null;
    dateRange?: string | null;
  }[];
  allowedTech: string[];
}

/**
 * What to look at.
 *
 * `focus` is free text the candidate typed - "I am aiming at backend roles" - and is
 * optional. There is no posting here on purpose: a suggestion good only against one
 * job belongs to tailoring, where the JD is in the prompt and the result is a
 * document.
 */
export interface SuggestInput {
  focus: string | null;
  /** Restrict the answer to these atoms. Empty means the whole resume. */
  atomIds: string[];
}

export const SuggestOutputSchema = z.object({
  suggestions: z
    .array(
      z.object({
        /** The atom this is about. Required for both kinds - advice about nothing in
         *  particular is a horoscope. */
        atomId: z.string().min(1),
        kind: z.enum(['rewrite', 'advice']),
        /** The replacement sentence for a rewrite; the advice itself otherwise. */
        text: z.string().min(1).max(400),
        /** One line on what it buys. Shown beside the suggestion. */
        why: z.string().min(1).max(240),
      }),
    )
    .max(12),
  /** What the model thought of the resume as a whole, or ''. */
  overall: z.string().max(600),
});

export type SuggestOutput = z.infer<typeof SuggestOutputSchema>;

export const suggestResumeTask: LlmTask<
  SuggestShared,
  SuggestInput,
  SuggestOutput
> = {
  name: 'suggest-resume',
  tier: 'deep',
  maxTokens: 4096,
  schema: SuggestOutputSchema,

  instruction:
    "You review one candidate's resume, broken into atoms, each with an id, and " +
    'propose specific improvements to individual atoms.\n\n' +
    'You are not rewriting the resume and you are not selecting what belongs on ' +
    'it. You are pointing at particular sentences and saying what is weak about ' +
    'them, with a better version where you can write one truthfully.\n\n' +
    'A suggestion is worth making when the sentence undersells work that is ' +
    'already described in the atom - a vague verb, a buried result, a metric that ' +
    'is present in the metrics list but missing from the text, an implementation ' +
    'detail where an outcome belongs. A suggestion is not worth making when the ' +
    'only change is a synonym.\n\n' +
    'Use kind "rewrite" when you can write the better sentence from what the atom ' +
    'already says. Use kind "advice" when the improvement needs a fact the atom ' +
    'does not contain - then say what to add and let the candidate supply it. ' +
    'Never put a fact the atom does not contain into a rewrite.\n\n' +
    'Lengths, which are hard limits:\n' +
    '- At most 12 suggestions. Fewer, better ones are the right answer; a list of ' +
    'twelve mediocre ones does not get read.\n' +
    '- Each text: under 400 characters. Each why: under 240.\n' +
    '- overall: under 600 characters, or "" if you have nothing to add beyond the ' +
    'individual suggestions.',

  prefix(shared) {
    const atoms = shared.atoms
      .map((a) => {
        const parts = [`id: ${a.id}  kind: ${a.kind}`];
        if (a.employer) parts.push(`employer: ${a.employer}`);
        if (a.dateRange) parts.push(`dates: ${a.dateRange}`);
        return (
          `${parts.join('  ')}\n` +
          `  text: ${a.text}\n` +
          `  metrics: ${a.metrics.length > 0 ? a.metrics.join(' | ') : '(none)'}\n` +
          `  tech: ${a.tech.length > 0 ? a.tech.join(', ') : '(none)'}`
        );
      })
      .join('\n\n');

    return [
      RULES,
      '',
      '--- CANDIDATE ---',
      `Name: ${shared.fullName}`,
      shared.headline ? `Current headline: ${shared.headline}` : '',
      '',
      'The ONLY technologies you may name in a rewrite:',
      shared.allowedTech.join(', '),
      '',
      'Atoms:',
      atoms,
    ]
      .filter((line) => line !== '')
      .join('\n');
  },

  question(input) {
    return [
      '--- WHAT TO REVIEW ---',
      input.atomIds.length > 0
        ? `Only these atoms: ${input.atomIds.join(', ')}`
        : 'The whole resume.',
      input.focus ? `What the candidate is aiming at: ${input.focus}` : '',
      '',
      'Propose the improvements that would change how a hiring manager reads this.',
    ]
      .filter((line) => line !== '')
      .join('\n');
  },
};
