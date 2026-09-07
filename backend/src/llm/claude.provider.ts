/**
 * The Claude provider. PLAN-v2 phase 2, built first; Gemini is not needed until
 * deployment.
 *
 * THREE THINGS IN HERE ARE LOAD-BEARING AND EASY TO BREAK SILENTLY.
 *
 * 1. The cached prefix. Caching is a prefix match over `tools` -> `system` ->
 *    `messages`, so the profile and rubric go in `system` with the breakpoint at
 *    the end of them, and the job description goes in `messages`. Any byte that
 *    changes in `system` between two requests invalidates the cache for the second
 *    one, and the only symptom is the bill - the responses look identical. That is
 *    why `LlmTask` splits `prefix(shared)` from `question(input)`, why nothing here
 *    interpolates a timestamp or a counter, and why `logCacheHealth` exists: a run
 *    whose `cache_read_input_tokens` stays at zero is a run that is paying full
 *    price for the same 4KB of resume two hundred times.
 *
 *    A caveat worth knowing rather than discovering: the minimum cacheable prefix
 *    is model-dependent (roughly 1-4k tokens). A short profile may sit below it, in
 *    which case nothing caches and nothing errors. That is not a bug to fix, but it
 *    is why the health log reports the prefix size next to the hit count.
 *
 * 2. Structured output. `output_config.format` from the task's Zod schema, and then
 *    the result is Zod-parsed AGAIN at this boundary. The second parse is not
 *    redundant: constrained decoding guarantees the shape, not the semantics - it
 *    will happily produce `score: 200` if the schema says `number` - and the task
 *    schemas carry the ranges. A parse failure raises LlmSchemaError rather than a
 *    generic error precisely so the drift RATE can be counted.
 *
 * 3. The batch/inline choice. The Batch API is half price and can take an hour.
 *    PLAN-v2 change 1 revised real daily volume down to single digits at the top of
 *    the funnel, so waiting an hour to save half of six requests is a bad trade -
 *    hence BATCH_THRESHOLD and `mode: 'auto'`. The batch path exists because the
 *    company list is meant to grow 10x, and at 200 postings a day the arithmetic
 *    reverses.
 *
 * No key is required to construct this. The api process boots, `discover` runs, and
 * the failure happens at the first call with a message that says which variable is
 * missing - because refusing to start the whole application over an unset LLM key
 * would take the job-board crawler down with it.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import {
  CompleteManyOptions,
  LlmBatchItem,
  LlmBatchPendingError,
  LlmError,
  LlmProvider,
  LlmResult,
  LlmSchemaError,
  LlmTask,
  LlmTier,
  LlmUsage,
} from './llm.types';

/**
 * Which model runs which tier.
 *
 * PLAN-v2 phase 2: haiku to score, opus to tailor. Haiku 4.5 because scoring is
 * high-volume classification against a rubric, which is what it is good at and
 * where the price difference (1/5th of Opus in, 1/5th out) is the difference
 * between a sustainable daily run and one that gets switched off. Opus 5 to tailor
 * because a rewrite that overstates costs an application, and there are fifteen of
 * those a day.
 */
const MODELS: Record<LlmTier, string> = {
  fast: 'claude-haiku-4-5',
  deep: 'claude-opus-5',
};

/**
 * Above this many items, `mode: 'auto'` uses the Batch API.
 *
 * 20 is a judgement, not a measurement, and the reasoning is asymmetric: below it
 * the saving is cents and the cost is up to an hour of latency in the morning
 * digest; above it the saving compounds while the latency is already amortised over
 * a run nobody watches. Revisit once phase 1 has a month of real volume - if the
 * daily survivor count settles above 20, this line stops mattering.
 */
const BATCH_THRESHOLD = 20;

/** Default patience for a batch. Most finish inside an hour; this is not a cap on
 *  the batch, only on how long we sit here waiting for it. */
const BATCH_TIMEOUT_MS = 30 * 60 * 1000;

const BATCH_POLL_MS = 20 * 1000;

@Injectable()
export class ClaudeProvider implements LlmProvider {
  readonly id = 'claude' as const;

  private readonly logger = new Logger(ClaudeProvider.name);
  private client: Anthropic | null = null;

  constructor(private readonly config: ConfigService) {}

  modelFor(tier: LlmTier): string {
    return MODELS[tier];
  }

  /**
   * The SDK client, built on first use.
   *
   * The SDK would read ANTHROPIC_API_KEY from the environment itself, but it is
   * read through ConfigService here so that the one Zod-validated env contract
   * remains the only place environment variables are consumed - and so the error
   * below can name the variable rather than letting a 401 explain it later.
   */
  private sdk(): Anthropic {
    if (this.client) return this.client;

    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey) {
      throw new LlmError(
        'ANTHROPIC_API_KEY is not set. The Claude provider is selected (see ' +
          'LLM_PROVIDER / resolveLlmProvider), so scoring and tailoring cannot ' +
          'run. Discovery and profile ingestion do not need it and are unaffected.',
        { task: '(none)', model: '(none)' },
      );
    }

    this.client = new Anthropic({ apiKey });
    return this.client;
  }

  async complete<S, I, O>(
    task: LlmTask<S, I, O>,
    shared: S,
    input: I,
  ): Promise<LlmResult<O>> {
    const model = MODELS[task.tier];
    const params = this.params(task, shared, input);

    // `.catch` rather than try/catch so the SDK's own return type survives - the
    // parsed message type is not exported under a public subpath, and annotating
    // it by hand would mean re-declaring an SDK type, which the house rule forbids
    // for exactly the reason it would go stale here.
    const message = await this.sdk()
      .messages.parse({
        ...params,
        output_config: {
          ...params.output_config,
          format: zodOutputFormat(task.schema),
        },
      })
      .catch((err: unknown) => {
        throw this.wrap(err, task, model);
      });

    // A refusal is an HTTP 200 with no usable content, so it has to be checked
    // before the content is read. It should be vanishingly rare on this workload -
    // scoring job descriptions is not a sensitive request - but "should be rare" is
    // how a null-dereference at 06:00 gets written.
    if (message.stop_reason === 'refusal') {
      throw new LlmError(
        `${task.name}: ${model} declined the request ` +
          `(${message.stop_details?.category ?? 'no category'})`,
        { task: task.name, model },
      );
    }

    const usage = readUsage(message.usage);
    this.logCacheHealth(task, model, usage);

    // `parsed_output` is null when the response did not parse. Rather than report
    // that as a bare null, the raw text is re-parsed here to get the actual Zod
    // issues - which is the whole diagnostic value of the drift signal.
    if (message.parsed_output === null || message.parsed_output === undefined) {
      throw this.schemaError(task, model, textOf(message.content));
    }

    return { value: message.parsed_output, provider: this.id, model, usage };
  }

  async completeMany<S, I, O>(
    task: LlmTask<S, I, O>,
    shared: S,
    items: LlmBatchItem<I>[],
    options: CompleteManyOptions = {},
  ): Promise<Map<string, LlmResult<O>>> {
    if (items.length === 0) return new Map();

    const duplicate = firstDuplicate(items.map((i) => i.key));
    if (duplicate) {
      // Results are keyed by this, so a duplicate would silently drop one of the
      // two postings rather than scoring both.
      throw new LlmError(
        `${task.name}: duplicate key "${duplicate}" in completeMany - keys ` +
          'identify results and must be unique',
        { task: task.name, model: MODELS[task.tier] },
      );
    }

    const mode =
      options.mode ??
      (items.length >= BATCH_THRESHOLD || options.batchId ? 'batch' : 'inline');

    return mode === 'batch'
      ? this.completeManyBatched(task, shared, items, options)
      : this.completeManyInline(task, shared, items, options);
  }

  /**
   * One request at a time, full price, immediate.
   *
   * SEQUENTIAL, not concurrent, and that is the point: the first request writes the
   * cached prefix and every one after it reads that cache. Firing them in parallel
   * means several requests race to write the same prefix, each paying the ~1.25x
   * write cost, and the saving is lost on precisely the workload it was for. The
   * latency cost is acceptable because this path only runs below BATCH_THRESHOLD.
   */
  private async completeManyInline<S, I, O>(
    task: LlmTask<S, I, O>,
    shared: S,
    items: LlmBatchItem<I>[],
    options: CompleteManyOptions,
  ): Promise<Map<string, LlmResult<O>>> {
    const results = new Map<string, LlmResult<O>>();

    for (const [index, item] of items.entries()) {
      try {
        results.set(item.key, await this.complete(task, shared, item.input));
      } catch (err) {
        // One bad posting must not lose the other nineteen. The key is simply
        // absent from the map - see the note on LlmProvider.completeMany about why
        // it is not padded with a null.
        this.logger.warn(
          `${task.name} failed for ${item.key}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      options.onProgress?.(index + 1, items.length);
    }

    return results;
  }

  /** Half price, up to an hour. See BATCH_THRESHOLD. */
  private async completeManyBatched<S, I, O>(
    task: LlmTask<S, I, O>,
    shared: S,
    items: LlmBatchItem<I>[],
    options: CompleteManyOptions,
  ): Promise<Map<string, LlmResult<O>>> {
    const model = MODELS[task.tier];
    const client = this.sdk();

    /**
     * custom_id is constrained (alphanumerics, dashes, underscores, bounded
     * length) and a caller's key is not - it is whatever the funnel used, today a
     * uuid and tomorrow possibly a slug with a dot in it. Positional ids plus a
     * side map means the constraint can never be violated by data, and the
     * "results arrive in any order" rule is still respected because the id is what
     * indexes the map rather than the position in the results stream.
     */
    const keyOf = new Map(items.map((item, i) => [`i${i}`, item.key]));

    let batchId = options.batchId;
    if (!batchId) {
      const batch = await client.messages.batches
        .create({
          requests: items.map((item, i) => ({
            custom_id: `i${i}`,
            params: {
              ...this.params(task, shared, item.input),
              output_config: { format: zodOutputFormat(task.schema) },
            },
          })),
        })
        .catch((err) => {
          throw this.wrap(err, task, model);
        });
      batchId = batch.id;
      this.logger.log(
        `${task.name}: submitted batch ${batchId} with ${items.length} request(s) ` +
          `to ${model} at half price`,
      );
    } else {
      this.logger.log(`${task.name}: resuming batch ${batchId}`);
    }

    const waitMs = options.batchTimeoutMs ?? BATCH_TIMEOUT_MS;
    const startedAt = Date.now();

    for (;;) {
      const batch = await client.messages.batches.retrieve(batchId);
      if (batch.processing_status === 'ended') break;

      const done =
        batch.request_counts.succeeded +
        batch.request_counts.errored +
        batch.request_counts.canceled +
        batch.request_counts.expired;
      options.onProgress?.(done, items.length);

      if (Date.now() - startedAt > waitMs) {
        throw new LlmBatchPendingError(batchId, {
          task: task.name,
          model,
          waitedMs: Date.now() - startedAt,
          done,
          total: items.length,
        });
      }

      await new Promise((r) => setTimeout(r, BATCH_POLL_MS));
    }

    const results = new Map<string, LlmResult<O>>();
    let cacheReads = 0;

    for await (const row of await client.messages.batches.results(batchId)) {
      const key = keyOf.get(row.custom_id);
      if (!key) {
        // Only reachable when resuming a batch whose item list has since changed -
        // worth a warning rather than a crash, since the other results are fine.
        this.logger.warn(
          `${task.name}: batch ${batchId} returned unknown custom_id ` +
            `${row.custom_id}; ignoring`,
        );
        continue;
      }

      if (row.result.type !== 'succeeded') {
        this.logger.warn(
          `${task.name}: ${key} came back ${row.result.type}` +
            (row.result.type === 'errored'
              ? ` (${row.result.error.type})`
              : ''),
        );
        continue;
      }

      const message = row.result.message;
      if (message.stop_reason === 'refusal') {
        this.logger.warn(`${task.name}: ${key} was declined by ${model}`);
        continue;
      }

      const usage = readUsage(message.usage);
      cacheReads += usage.cacheReadTokens;

      // No `parsed_output` on the batch path - the Batch API returns plain
      // messages - so the schema is applied here. Same schema, same task, one
      // parsing helper: this is where "the abstraction exists so the two paths
      // cannot drift" is either true or not.
      const parsed = task.schema.safeParse(jsonOf(textOf(message.content)));
      if (!parsed.success) {
        this.logger.warn(
          `${task.name}: ${key} did not match the task schema - ` +
            parsed.error.issues.map((i) => i.message).join('; '),
        );
        continue;
      }

      results.set(key, {
        value: parsed.data,
        provider: this.id,
        model,
        usage,
      });
    }

    this.logger.log(
      `${task.name}: batch ${batchId} returned ${results.size}/${items.length} ` +
        `usable result(s), ${cacheReads} cached input token(s) reused`,
    );

    return results;
  }

  /**
   * The request, minus the output format.
   *
   * Everything cache-relevant is decided here, in one place, so the single and
   * batch paths cannot diverge on it.
   */
  private params<S, I, O>(
    task: LlmTask<S, I, O>,
    shared: S,
    input: I,
  ): Omit<Anthropic.Messages.MessageCreateParamsNonStreaming, 'output_config'> & {
    output_config?: { effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' };
  } {
    return {
      model: MODELS[task.tier],
      max_tokens: task.maxTokens,

      // Two blocks with ONE breakpoint at the end of the second. The instruction is
      // a constant and the prefix is constant across a run, so a single breakpoint
      // covering both is all that is needed; a second breakpoint between them would
      // spend one of the four available on a boundary nothing varies across.
      system: [
        { type: 'text', text: task.instruction },
        {
          type: 'text',
          text: task.prefix(shared),
          cache_control: { type: 'ephemeral' },
        },
      ],

      messages: [{ role: 'user', content: task.question(input) }],

      // Thinking and effort are tier-shaped, and NOT settable uniformly:
      // `output_config.effort` is rejected by Haiku 4.5, and Haiku's thinking still
      // takes an explicit token budget rather than being adaptive. So the fast tier
      // gets neither - scoring against a fixed rubric is not a reasoning task - and
      // the deep tier gets adaptive thinking, which is on by default on Opus 5 and
      // set explicitly here so it survives a model change.
      ...(task.tier === 'deep'
        ? {
            thinking: { type: 'adaptive' as const },
            output_config: { effort: 'high' as const },
          }
        : {}),
    };
  }

  /**
   * Warn when the cache is not working.
   *
   * A cache miss is invisible: same answer, higher bill. This is the only place the
   * project gets told. Logged at debug on a hit so a run can be inspected without
   * being noisy, and at warn on a miss that should have been a hit.
   */
  private logCacheHealth(
    task: { name: string },
    model: string,
    usage: LlmUsage,
  ): void {
    if (usage.cacheReadTokens > 0) {
      this.logger.debug(
        `${task.name}/${model}: ${usage.cacheReadTokens} cached + ` +
          `${usage.inputTokens} fresh input token(s)`,
      );
      return;
    }

    if (usage.cacheWriteTokens > 0) {
      // Expected exactly once per prefix per TTL window - the first call of a run.
      this.logger.debug(
        `${task.name}/${model}: wrote ${usage.cacheWriteTokens} token(s) to cache`,
      );
      return;
    }

    this.logger.debug(
      `${task.name}/${model}: nothing cached (${usage.inputTokens} input ` +
        'tokens). Expected on the first call; if it persists across a run the ' +
        'prefix is either changing between calls or is below the model minimum.',
    );
  }

  private schemaError<S, I, O>(
    task: LlmTask<S, I, O>,
    model: string,
    raw: string,
  ): LlmSchemaError {
    const parsed = task.schema.safeParse(jsonOf(raw));
    return new LlmSchemaError({
      task: task.name,
      model,
      raw,
      issues: parsed.success
        ? '(the schema accepts this text - the SDK failed to parse it, which ' +
          'points at the response format rather than the content)'
        : parsed.error.issues
            .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('\n'),
    });
  }

  /** Turns an SDK error into one that names the task and the model. */
  private wrap<S, I, O>(
    err: unknown,
    task: LlmTask<S, I, O>,
    model: string,
  ): LlmError {
    if (err instanceof LlmError) return err;

    // Typed classes rather than message matching, so a rate limit stays
    // distinguishable from a bad request when something upstream decides whether to
    // retry. The SDK already retried 429s and 5xxs twice before this point.
    const kind =
      err instanceof Anthropic.RateLimitError
        ? 'rate limited'
        : err instanceof Anthropic.AuthenticationError
          ? 'authentication failed - check ANTHROPIC_API_KEY'
          : err instanceof Anthropic.BadRequestError
            ? 'rejected the request'
            : err instanceof Anthropic.APIError
              ? `API error ${err.status}`
              : 'failed';

    return new LlmError(
      `${task.name}: ${model} ${kind}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      { task: task.name, model, cause: err },
    );
  }
}

/** Concatenates the text blocks of a response. */
function textOf(content: { type: string }[]): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/**
 * JSON.parse that returns undefined instead of throwing.
 *
 * Feeding undefined to a Zod schema produces a proper "expected object, received
 * undefined" issue, which is a better error than a SyntaxError with no context
 * about which task or model produced it.
 */
function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Cache counters are absent rather than zero when nothing was cached. */
function readUsage(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): LlmUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function firstDuplicate(keys: string[]): string | undefined {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return undefined;
}
