/**
 * Phase 5's task: tailor the resume to one posting.
 *
 * Defined now, in phase 2, because the plan defines the tasks with the abstraction
 * and because the SHAPE of this output is the whole provenance argument. It is not
 * wired to a renderer yet - phase 5 builds provenance.guard.ts, the docx layout and
 * the fallback path.
 *
 * THE MODEL CANNOT EMIT A BULLET WITHOUT CITING A SOURCE ATOM. That is enforced
 * three times over, deliberately:
 *
 *   1. Structurally, here: a rewrite is `{ atomId, text }`. There is no field in
 *      which free-standing prose could arrive, so "invent a bullet" is not an
 *      output this schema can express.
 *   2. By the prompt, below.
 *   3. By provenance.guard.ts (phase 5), which re-checks every number against the
 *      cited atom's `metrics` and every tech token against the profile's tech tags
 *      plus SkillsReserve, and FAILS CLOSED - discards the variant and falls back
 *      to the base resume.
 *
 * Three layers because the third is the only one that actually holds. The schema
 * stops the model from having a place to put a fabrication; it does not stop the
 * model from fabricating inside a `text` field that cites a real atom - claiming
 * 85% where the atom says 65%, or adding Kafka to a bullet about a queue. Only the
 * guard catches that, and the guard's failure RATE is what the digest reports,
 * because a rising rate means prompt drift.
 *
 * This is the `deep` tier. A bad rewrite does not cost a retry, it costs an
 * application - the candidate sends it, and there are fifteen a day.
 */
import { z } from 'zod';
import { LlmTask } from '../llm.types';

/**
 * The rules the rewrite has to satisfy, in the cached prefix.
 *
 * Stated as prohibitions with reasons rather than as style advice. A model told
 * "be accurate" will be; a model told "the number must appear in the source atom,
 * because a checker compares them and discards your whole answer if it does not"
 * has a reason to check its own work.
 */
const RULES = `Hard rules. A checker verifies every one of these after you answer,
and discards your ENTIRE response if any is violated - so a single embellished
number wastes the whole rewrite:

  1. Every bullet you return must cite the id of the atom it came from. You may
     not write a bullet that is not a rewrite of a specific atom.
  2. Every number, percentage, duration and quantity in your text must appear in
     that atom's listed metrics. You may drop a number. You may not change one,
     round one, or add one. "improved by 65%" cannot become "improved by 85%",
     and an atom with no metrics cannot gain one.
  3. Every technology you name must appear in the candidate's technology list.
     You may not add a technology because the posting asks for it. If the posting
     wants Kafka and the candidate has not used Kafka, the honest answer is a
     resume that does not mention Kafka.
  4. Employer names and date ranges are copied byte for byte or omitted.
  5. You may not change what the candidate did. You may change emphasis, order,
     wording and length.

What tailoring legitimately means here: choose which of the candidate's atoms this
posting cares about, lead with those, and phrase them in the posting's vocabulary
where the candidate's work genuinely matches it. That is all it means.`;

/** The candidate, plus the reserve of skills the guard will accept. */
export interface TailorShared {
  fullName: string;
  headline: string | null;
  /**
   * Atoms WITH ids, unlike the scoring task - the ids are what the output cites,
   * so they have to be the real database ids and not positional indices that
   * would shift the moment an atom is added.
   */
  atoms: {
    id: string;
    kind: string;
    text: string;
    tech: string[];
    metrics: string[];
    employer?: string | null;
    dateRange?: string | null;
  }[];
  /** Profile tech tags plus SkillsReserve - the union the guard checks against. */
  allowedTech: string[];
}

export interface TailorInput {
  title: string;
  company: string;
  description: string;
}

/**
 * The output. Nothing here is prose the model authored freely except the headline
 * and the cover letter, both of which the guard checks for numbers and tech too.
 */
export const TailorOutputSchema = z.object({
  /**
   * Which atoms belong on this resume at all, most relevant first.
   *
   * Separate from `rewrites` because selection and rewriting are different
   * decisions: an atom can be selected and used verbatim, which is the safest
   * possible outcome and must not require the model to restate it.
   */
  selectedAtomIds: z.array(z.string().min(1)).min(1).max(30),

  /**
   * Rewritten text for a subset of the selected atoms.
   *
   * An atom in `selectedAtomIds` but absent here is used verbatim. An atom here
   * but not in `selectedAtomIds` is an inconsistency the guard rejects.
   */
  rewrites: z
    .array(
      z.object({
        atomId: z.string().min(1),
        text: z.string().min(1).max(400),
      }),
    )
    .max(30),

  /** One line under the name. */
  headline: z.string().min(1).max(160),

  /**
   * Optional in reality, required in the schema with an empty string permitted -
   * so "no cover letter" is a decision the model states rather than a field it
   * quietly omitted.
   */
  coverLetter: z.string().max(2500),
});

export type TailorOutput = z.infer<typeof TailorOutputSchema>;

export const tailorResumeTask: LlmTask<
  TailorShared,
  TailorInput,
  TailorOutput
> = {
  name: 'tailor-resume',
  tier: 'deep',
  // A full resume's worth of rewrites plus a cover letter. Room to spare: the
  // failure mode of a low ceiling here is a truncated JSON object, which fails the
  // schema and throws away a deep-tier call.
  maxTokens: 8192,
  schema: TailorOutputSchema,

  instruction:
    "You tailor one candidate's resume to one job posting. You are given the " +
    "candidate's resume broken into atoms, each with an id, and then the posting.\n\n" +
    'You select which atoms belong on the resume for this posting, and you may ' +
    'rewrite the text of any of them. You cite the atom id for every piece of ' +
    'text you produce.\n\n' +
    'You are not writing a persuasive document. You are choosing and rephrasing ' +
    'true statements. A resume that overstates gets the candidate into an ' +
    'interview they then fail, which is worse than not getting the interview.\n\n' +
    // The schema's own limits, restated. Nothing enforces a maxLength during
    // generation on either provider (both drop the keyword - see jsonSchemaOf), so
    // an unstated limit is one that gets broken, and here breaking it throws away a
    // whole Opus tailoring call. The numbers are resume-shaped anyway: a bullet
    // nobody reads is not worth the line it takes.
    'Lengths, which are hard limits:\n' +
    '- Each rewritten bullet: under 400 characters. One or two lines on the page.\n' +
    '- headline: one line, under 160 characters, and NO DIGITS. Not a year, not ' +
    'a grade like "Engineer - 1", not a metric. Name the discipline and the ' +
    'technologies. Two measured runs died here: the model copied the ' +
    "candidate's real job level into the headline, the checker had no metric to " +
    'match the "1" against, and a whole tailoring call was discarded over a ' +
    'figure that says nothing to a reader anyway - a grade does not transfer ' +
    'between companies.\n' +
    '- coverLetter: under 2500 characters, or "" if the posting gives you nothing ' +
    'specific to say. An empty one is a decision, not an omission.\n' +
    '- At most 30 selected atoms and 30 rewrites.',

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
      // Spelled out because rule 3 is the one a model breaks helpfully.
      'The ONLY technologies you may name anywhere in your answer:',
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
      '--- POSTING ---',
      `Title: ${input.title}`,
      `Company: ${input.company}`,
      '',
      'Description:',
      input.description,
    ].join('\n');
  },
};
