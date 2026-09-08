/**
 * Tier 3's one LLM call: which stored value does this strange label want?
 *
 * WHAT IS AND IS NOT AT RISK HERE. The model never sees the candidate's data and never
 * produces a value - it returns key NAMES from a fixed list, and the filling engine
 * looks the value up itself. It is also only ever shown fields the engine already
 * classified as ordinary, and whatever it returns is re-classified before use. So the
 * worst a wrong answer does is put a GitHub URL in the portfolio box, and a form full
 * of prompt injection cannot reach an EEO question or a salary field, because those
 * were never in the call and would be refused on the way back.
 *
 * A LOW-CONFIDENCE MATCH IS DISCARDED rather than used with a warning. The alternative
 * to a filled box is an empty box on a form the human is about to read, which is a
 * smaller cost than a wrong value they have to notice in order to fix.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { LLM_PROVIDER, type LlmProvider } from '../llm/llm.types';
import {
  mapFieldsTask,
  type MapFieldsInput,
  type MapFieldsShared,
} from '../llm/tasks/map-fields.task';
import type { AnswerKey } from './field-policy';
import type { FormField } from './form-page';

/**
 * Below this, the match is thrown away.
 *
 * 0.7 because the task's own instruction tells the model to go below it whenever the
 * label is ambiguous or abbreviated - the number and the prompt are one decision, and
 * changing this without changing that makes the threshold meaningless.
 */
const MIN_CONFIDENCE = 0.7;

/** Nothing varies per candidate, so the cached prefix is shared by every form. */
const SHARED: MapFieldsShared = { version: 1 };

@Injectable()
export class LlmFieldResolver {
  private readonly logger = new Logger(LlmFieldResolver.name);

  constructor(@Inject(LLM_PROVIDER) private readonly llm: LlmProvider) {}

  async resolve(fields: FormField[]): Promise<Map<string, AnswerKey | null>> {
    const out = new Map<string, AnswerKey | null>();
    if (fields.length === 0) return out;

    const input: MapFieldsInput = {
      fields: fields.map((field) => ({
        handle: field.handle,
        // Capped: a form whose label is a paragraph of terms and conditions is not a
        // label, and sending it whole is how one field costs a thousand tokens.
        label: field.label.slice(0, 200),
        type: field.type,
        required: field.required,
        ...(field.options.length > 0 ? { options: field.options } : {}),
      })),
    };

    const call = await this.llm.complete(mapFieldsTask, SHARED, input);

    // The handles this call was actually about. A model echoing back a handle it was
    // not given would otherwise write a decision for a field nobody asked about.
    const asked = new Set(fields.map((field) => field.handle));

    let low = 0;
    for (const match of call.value.matches) {
      if (!asked.has(match.handle)) continue;
      if (match.key === null) continue;
      if (match.confidence < MIN_CONFIDENCE) {
        low++;
        continue;
      }
      out.set(match.handle, match.key);
    }

    this.logger.log(
      `${call.model} matched ${out.size} of ${fields.length} unrecognised field(s)` +
        (low > 0 ? `, ${low} discarded as too uncertain` : ''),
    );

    return out;
  }
}
