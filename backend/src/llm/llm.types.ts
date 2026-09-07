/**
 * The LLM boundary. One interface, two providers behind it, tasks defined once.
 *
 * PLAN-v2 phase 2. The point of the abstraction is NOT that providers are
 * interchangeable in quality - they are not - it is that the same prompt and the
 * same Zod schema are used by both, so a difference in output is a difference in
 * the MODEL rather than a difference in two prompts that drifted apart. Three of
 * the plan's four anti-drift defenses live in this file's shape:
 *
 *   1. Every result is Zod-parsed at the boundary. A provider returns `unknown`
 *      to this layer and a typed value to the caller, or it throws.
 *   2. Every result carries `provider` and `model`, so MatchScore.llmProvider and
 *      Application rows record what actually produced them rather than what the
 *      config said at some point.
 *   3. A task is one object. There is no second copy of the scoring prompt for
 *      the batch path or for Gemini.
 *
 * (The fourth, the cross-provider golden set, is a test rather than a type - and
 * it cannot be written until GeminiProvider exists.)
 *
 * THE SHARED/INPUT SPLIT IS THE OTHER REASON THIS IS SHAPED THIS WAY. Prompt
 * caching is a prefix match: a single byte early in the request invalidates
 * everything after it. Scoring a day's postings sends the same profile and the
 * same rubric two hundred times and one job description that differs. Splitting a
 * task into `prefix(shared)` and `question(input)` makes that structural - a task
 * cannot accidentally interleave the varying part into the cached part, because it
 * does not have both values in the same function.
 */
import { z } from 'zod';

/**
 * Which class of model runs a task.
 *
 * Named by the job rather than by the model, because the model behind each name
 * changes and every call site should not have to. `fast` is high-volume
 * classification - one per posting per day, so cost dominates. `deep` is the
 * tailoring path, where a bad rewrite wastes an application and the volume is
 * single digits, so quality dominates.
 */
export type LlmTier = 'fast' | 'deep';

/** What a call cost, as the provider reported it. */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** Served from the cache at ~0.1x. Zero across a whole run means the cached
   *  prefix is being invalidated - see the note on ClaudeProvider. */
  cacheReadTokens: number;
  /** Written to the cache at ~1.25x. Paid once per prefix per TTL window. */
  cacheWriteTokens: number;
}

/** A parsed, validated result plus the provenance the schema requires. */
export interface LlmResult<T> {
  value: T;
  /** Matches MatchScore.llmProvider. */
  provider: string;
  /** The concrete model id, not the tier. */
  model: string;
  usage: LlmUsage;
}

/**
 * One unit of work: a prompt, a schema, and a tier.
 *
 * `TShared` is everything constant across a run (the candidate's atoms, the
 * rubric). `TInput` is what varies (one job description). `TOutput` is what the
 * caller gets back, and the Zod schema is the only definition of it - the type is
 * inferred from the schema rather than declared beside it, so the two cannot
 * disagree.
 */
export interface LlmTask<TShared, TInput, TOutput> {
  /** Stable identifier. Appears in logs and in batch custom_ids. */
  readonly name: string;

  readonly tier: LlmTier;

  /**
   * Output ceiling. Not a cost control - a truncated structured response is an
   * unparseable one, so this is set generously and the schema does the limiting.
   */
  readonly maxTokens: number;

  readonly schema: z.ZodType<TOutput>;

  /**
   * The instruction. A constant string, first in the cached prefix.
   *
   * A property rather than a method because it must not be able to depend on
   * anything - `new Date()` in here would invalidate the cache on every call and
   * the only symptom would be a bill.
   */
  readonly instruction: string;

  /**
   * The rest of the cached prefix. MUST be a pure function of `shared`.
   *
   * Everything this returns is sent on every request in a run and paid for once.
   */
  prefix(shared: TShared): string;

  /** The varying part, sent as the user turn. */
  question(input: TInput): string;
}

/** One item in a `completeMany` call, keyed so results can be matched back. */
export interface LlmBatchItem<TInput> {
  /**
   * The caller's identifier - a jobId, typically.
   *
   * Results come back in ANY order, so this is how they are re-associated.
   * Position is not a key.
   */
  key: string;
  input: TInput;
}

export interface CompleteManyOptions {
  /**
   * `batch` halves the token price and can take an hour. `inline` is immediate.
   * `auto` (the default) picks by count - see BATCH_THRESHOLD in the provider.
   */
  mode?: 'auto' | 'batch' | 'inline';

  /** How long to wait for a batch before giving up on WAITING (not on the batch
   *  itself - see LlmBatchPendingError). */
  batchTimeoutMs?: number;

  /** Resume polling a batch submitted by an earlier process. */
  batchId?: string;

  /** Called as results arrive, for progress output on a long run. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * The provider contract.
 *
 * Deliberately small. Everything specific to a provider - batching, caching,
 * retry, how structured output is requested - is behind these two methods, and
 * nothing above this layer branches on which provider is in use.
 */
export interface LlmProvider {
  /** Matches the LLM_PROVIDER env value and MatchScore.llmProvider. */
  readonly id: 'claude' | 'gemini';

  /** The concrete model per tier, so a caller can log it before spending. */
  modelFor(tier: LlmTier): string;

  complete<S, I, O>(
    task: LlmTask<S, I, O>,
    shared: S,
    input: I,
  ): Promise<LlmResult<O>>;

  /**
   * Many inputs against one shared prefix.
   *
   * Returns a Map keyed by `LlmBatchItem.key`. A key MISSING from the map is a
   * request that failed - the map is not padded with nulls, because a null score
   * that reads as "scored 0" is worse than an absent one.
   */
  completeMany<S, I, O>(
    task: LlmTask<S, I, O>,
    shared: S,
    items: LlmBatchItem<I>[],
    options?: CompleteManyOptions,
  ): Promise<Map<string, LlmResult<O>>>;
}

/** Injection token. The interface is a type, so Nest needs a runtime symbol. */
export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

/**
 * A provider failed in a way the caller can reasonably act on.
 *
 * `task` and `model` are on the error because the most common question after a
 * failure is "which of the two models was that", and a stack trace through the
 * SDK does not say.
 */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly detail: { task: string; model: string; cause?: unknown },
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/**
 * A result came back but did not match the task's schema.
 *
 * Separate from LlmError because this is the drift signal. A rising rate of these
 * means the model's output has moved away from the schema, which is exactly the
 * thing the Zod-at-the-boundary defense exists to make visible rather than to
 * paper over with a partial parse.
 */
export class LlmSchemaError extends LlmError {
  constructor(
    detail: { task: string; model: string; raw: string; issues: string },
  ) {
    super(
      `${detail.task}: ${detail.model} returned output that does not match the ` +
        `task schema:\n${detail.issues}`,
      detail,
    );
    this.name = 'LlmSchemaError';
    this.raw = detail.raw;
  }

  /** The unparsed text, for a log line that can be read against the schema. */
  readonly raw: string;
}

/**
 * A batch is still running and we stopped waiting.
 *
 * NOT a cancellation. The batch keeps processing server-side and its results stay
 * available for 29 days, so the recovery is to call `completeMany` again with
 * `{ batchId }` rather than to pay for the same work twice. Throwing rather than
 * returning partial results because a half-scored day silently looks like a day
 * with fewer matches.
 */
export class LlmBatchPendingError extends LlmError {
  constructor(
    readonly batchId: string,
    detail: { task: string; model: string; waitedMs: number; done: number; total: number },
  ) {
    super(
      `${detail.task}: batch ${batchId} still running after ` +
        `${Math.round(detail.waitedMs / 1000)}s (${detail.done}/${detail.total} ` +
        'done). It is NOT cancelled - re-run with --batch-id ' +
        `${batchId} to collect the results without paying again.`,
      detail,
    );
    this.name = 'LlmBatchPendingError';
  }
}
