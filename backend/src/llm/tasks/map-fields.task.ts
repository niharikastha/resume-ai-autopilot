/**
 * Phase 6 tier 3: read an unfamiliar form and say which stored answer each box wants.
 *
 * FOR IN-HOUSE CAREER FORMS, where a per-company adapter is never worth writing. The
 * tier-1 and tier-2 adapters know their boards' field names; a company's own form
 * knows nothing, and its labels are the only handle there is.
 *
 * WHAT THIS TASK CANNOT DO, and why the design is shaped this way. It never sees the
 * candidate's data and it never produces a value - it returns KEY NAMES from a fixed
 * list, and the filling engine looks the value up itself. So the worst a bad answer
 * can do is put the candidate's GitHub URL in the portfolio box. It also never sees
 * the demographic or legal fields: the engine classifies every field first and only
 * the leftovers are sent, then re-checks whatever comes back. A model cannot be
 * prompt-injected into answering an EEO question it was never shown.
 *
 * WHY `fast` TIER. This is label matching, not judgement, and a form has thirty
 * fields. The deep tier's price is for the tailoring call.
 */
import { z } from 'zod';
import { LlmTask } from '../llm.types';

/** The keys a field may be matched to. Mirrors AnswerKey minus the ones no in-house
 *  form asks for by a strange name, and minus every legal and demographic key -
 *  those never reach this task. */
export const MAPPABLE_KEYS = [
  'fullName',
  'firstName',
  'lastName',
  'email',
  'phone',
  'location',
  'linkedIn',
  'github',
  'portfolio',
  'coverLetter',
] as const;

export interface MapFieldsShared {
  /** Nothing varies per candidate, so the prefix is the instruction alone and the
   *  cache hit is total across every form in a run. Present as a type so the task
   *  matches LlmTask's shape. */
  readonly version: 1;
}

/** One box on the form, as the engine describes it. */
export interface MapFieldsInput {
  fields: {
    /** Opaque id, echoed back so answers can be matched to controls. */
    handle: string;
    label: string;
    type: string;
    required: boolean;
    options?: readonly string[];
  }[];
}

export const MapFieldsOutputSchema = z.object({
  matches: z
    .array(
      z.object({
        handle: z.string().min(1),
        /**
         * Null is the expected answer, not a failure. Most unrecognised boxes on a
         * real form are company-specific questions with no stored answer, and a model
         * that feels obliged to pick something turns "how did you hear about us" into
         * a location.
         */
        key: z.enum(MAPPABLE_KEYS).nullable(),
        /** 0-1. Below the engine's threshold the match is discarded. */
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(80),
});

export type MapFieldsOutput = z.infer<typeof MapFieldsOutputSchema>;

export const mapFieldsTask: LlmTask<
  MapFieldsShared,
  MapFieldsInput,
  MapFieldsOutput
> = {
  name: 'map-fields',
  tier: 'fast',
  maxTokens: 4096,
  schema: MapFieldsOutputSchema,

  instruction:
    'You are given the labels of the boxes on a job application form. For each ' +
    'one, say which of a fixed list of stored candidate values belongs in it.\n\n' +
    'The keys you may return:\n' +
    MAPPABLE_KEYS.map((key) => `  ${key}`).join('\n') +
    '\n\nRules:\n' +
    '- Return null for any box that does not clearly want one of those values. ' +
    'Null is the correct answer for most boxes on most forms: company-specific ' +
    'questions, "how did you hear about us", referral codes, consent checkboxes.\n' +
    "- Never guess. A wrong match types the wrong thing into a real employer's " +
    'form, and a null leaves a box for the candidate to fill in themselves, which ' +
    'they are about to do anyway.\n' +
    '- Confidence must reflect the label alone. Use below 0.7 whenever the label ' +
    'is ambiguous, abbreviated, or in a language you are inferring.\n' +
    '- "Name" with no other name box means the full name. "Name" alongside a ' +
    'second name box means the first name.\n' +
    '- A URL box is portfolio only if no more specific label (LinkedIn, GitHub) ' +
    'fits it.\n' +
    '- Return exactly one entry per handle you were given, and echo the handle ' +
    'unchanged.',

  // Constant. Every form in a run shares this prefix byte for byte, so the whole
  // instruction is paid for once however many forms are filled.
  prefix: () => '',

  question: (input) =>
    'Boxes on this form:\n' +
    input.fields
      .map((field) => {
        const options =
          field.options && field.options.length > 0
            ? `, options: ${field.options.slice(0, 12).join(' | ')}`
            : '';
        return (
          `- handle=${field.handle} type=${field.type}` +
          `${field.required ? ' required' : ''}${options}\n` +
          `  label: ${field.label}`
        );
      })
      .join('\n'),
};
