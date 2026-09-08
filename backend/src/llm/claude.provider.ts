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
 * 2. The schema boundary. Every response is Zod-parsed against the task's schema
 *    before it is returned - one parse, in `complete`, whichever mode and whichever
 *    path produced it. How the model is made to emit JSON at all is a mode-specific
 *    detail (`output_config.format` on the Anthropic API, a forced tool call on
 *    Bedrock; see `askByFormat` and `askByTool`), and neither is taken on trust:
 *    constrained decoding guarantees the shape, not the semantics - it will happily
 *    produce `score: 200` if the schema says `number` - and the task schemas carry
 *    the ranges. A failure raises LlmSchemaError rather than a generic error
 *    precisely so the drift RATE can be counted.
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
 *
 * TWO DOORS TO THE SAME MODELS. `CLAUDE_AUTH_MODE` picks between the Anthropic API
 * (an api key) and AWS Bedrock (AWS credentials). It is one provider either way -
 * same prompts, same schemas, same guard - and only four things differ:
 *
 *   - Model ids. Bedrock prefixes them with `anthropic.`; see `modelFor`.
 *   - How the JSON is constrained. Bedrock's Messages endpoint does not accept
 *     `output_config.format`, and does not accept `strict` on a tool either - both
 *     come back as "Extra inputs are not permitted", on both models, with and
 *     without the structured-outputs beta header. That is measured against
 *     bedrock-mantle in us-east-1, not inferred from a table. So on Bedrock the
 *     schema is asked for as a FORCED TOOL CALL instead: `askByTool`, which yields
 *     the same JSON object one field earlier in the response.
 *   - No Batch API on Bedrock. `completeMany` runs inline there and says why rather
 *     than half-working. See `batchSdk`.
 *   - Credentials. Three ways in, see `bedrockSdk`.
 *
 * Everything ELSE this file depends on does work on Bedrock, including in
 * combination: adaptive thinking, `effort`, and prompt caching over a forced tool
 * call. So `params` is built once for both modes rather than branched - two sets
 * would drift, and a drifted prompt is a silently different score.
 *
 * The client is the MANTLE one (`AnthropicBedrockMantle`), which speaks the Messages
 * API at bedrock-mantle.{region}.api.aws. Not `AnthropicBedrock`, which is the legacy
 * bedrock-runtime InvokeModel path - that one takes geography-prefixed inference
 * profile ids (`apac.anthropic.…`) and, being a passthrough, lags the API surface
 * this file uses.
 */
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
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

/** Which door we go through to reach those models. See CLAUDE_AUTH_MODE. */
export type ClaudeAuthMode = 'api-key' | 'bedrock';

/**
 * What Bedrock prefixes the same model names with.
 *
 * One prefix, no region arithmetic: the Messages endpoint takes `anthropic.<model>`
 * and the region is a property of the client, not of the id. The geography-prefixed
 * form (`apac.anthropic.…`) belongs to the older InvokeModel inference profiles,
 * which is not the path this file uses.
 */
const BEDROCK_PREFIX = 'anthropic.';

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

/**
 * The request as `params` builds it: everything except how the schema is expressed.
 *
 * `output_config` is narrowed to drop `format`, because that field is the one thing
 * the two modes disagree about and is added by whichever path is taken - so a
 * `MessageParams` is by construction a request that has not yet said how it wants
 * its JSON.
 */
type MessageParams = Omit<
  Anthropic.Messages.MessageCreateParamsNonStreaming,
  'output_config'
> & { output_config?: Omit<Anthropic.Messages.OutputConfig, 'format'> };

/**
 * A response, reduced to the four things `complete` needs from it.
 *
 * Both paths return this, which is what lets the refusal check, the cache log and
 * the schema parse be written once. The candidate object is deliberately `unknown`:
 * it has not been through the schema yet, and typing it as `O` here would put the
 * assertion in the wrong place.
 */
interface Answer {
  /** The candidate object, unvalidated. `undefined` if the response held none. */
  json: unknown;
  /** What to show a human when `json` fails the schema. */
  raw: string;
  usage: LlmUsage;
  /** The refusal category when the model declined, null otherwise. */
  refusal: string | null;
}

@Injectable()
export class ClaudeProvider implements LlmProvider {
  /**
   * Written to MatchScore.llmProvider and ResumeVariant.llmProvider.
   *
   * `claude` in both modes, on purpose. Bedrock is not a second provider whose
   * answers need distinguishing from the first one's - it is the same model behind a
   * different door - and the row already records `model`, which carries the
   * `anthropic.` prefix for anyone who needs to know which door it came through.
   */
  readonly id = 'claude' as const;

  private readonly logger = new Logger(ClaudeProvider.name);
  private client: Anthropic | AnthropicBedrockMantle | null = null;
  private resolvedMode: ClaudeAuthMode | null = null;

  constructor(private readonly config: ConfigService) {}

  /** Resolved once, for the same reason the provider itself is. */
  authMode(): ClaudeAuthMode {
    this.resolvedMode ??=
      this.config.get<ClaudeAuthMode>('CLAUDE_AUTH_MODE') ?? 'api-key';
    return this.resolvedMode;
  }

  /**
   * The model id for a tier, in whichever dialect the selected mode speaks.
   *
   * The plain alias on the Anthropic API, the same alias behind `anthropic.` on
   * Bedrock. The overrides exist for the two things a prefix cannot express: a
   * provisioned-throughput ARN, and pinning a dated snapshot in an account where the
   * alias is not the snapshot you have access to. When an id is wrong the call fails
   * with a validation error naming the model - it cannot quietly run a different one.
   */
  modelFor(tier: LlmTier): string {
    if (this.authMode() !== 'bedrock') return MODELS[tier];

    const override = this.config.get<string>(
      tier === 'fast' ? 'BEDROCK_MODEL_FAST' : 'BEDROCK_MODEL_DEEP',
    );
    return override || `${BEDROCK_PREFIX}${MODELS[tier]}`;
  }

  /**
   * What the boot log should say about the credentials, if anything.
   *
   * Here rather than in LlmModule so that the rules about which variable matters in
   * which mode live next to the code that consumes them. Returns sentences, possibly
   * none: an unset key is a WARNING because every call will fail, but leaning on the
   * AWS provider chain is a normal way to run on EC2 and is only worth stating.
   */
  bootNotes(): string[] {
    if (this.authMode() === 'api-key') {
      return this.config.get<string>('ANTHROPIC_API_KEY')
        ? []
        : ['WARNING: ANTHROPIC_API_KEY is unset, calls will fail'];
    }

    const notes: string[] = [];
    if (!this.config.get<string>('AWS_REGION')) {
      notes.push('WARNING: AWS_REGION is unset, calls will fail');
    }
    if (
      !this.config.get<string>('AWS_BEARER_TOKEN_BEDROCK') &&
      !(
        this.config.get<string>('AWS_ACCESS_KEY_ID') &&
        this.config.get<string>('AWS_SECRET_ACCESS_KEY')
      )
    ) {
      notes.push(
        'no static Bedrock credentials in the environment - the AWS provider ' +
          'chain (profile, SSO, instance role) will be asked instead',
      );
    }
    return notes;
  }

  /**
   * The SDK client, built on first use.
   *
   * The SDKs would read ANTHROPIC_API_KEY and the AWS variables from the environment
   * themselves, but they are read through ConfigService here so that the one
   * Zod-validated env contract remains the only place environment variables are
   * consumed - and so the errors below can name the variable rather than letting a
   * 401 explain it later.
   */
  private sdk(): Anthropic | AnthropicBedrockMantle {
    this.client ??=
      this.authMode() === 'bedrock' ? this.bedrockSdk() : this.directSdk();
    return this.client;
  }

  private directSdk(): Anthropic {
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey) {
      throw new LlmError(
        'ANTHROPIC_API_KEY is not set. The Claude provider is selected (see ' +
          'LLM_PROVIDER / resolveLlmProvider) in api-key mode, so scoring and ' +
          'tailoring cannot run. Set it, or set CLAUDE_AUTH_MODE=bedrock to go ' +
          'through AWS instead. Discovery and profile ingestion do not need it ' +
          'and are unaffected.',
        { task: '(none)', model: '(none)' },
      );
    }
    return new Anthropic({ apiKey });
  }

  /**
   * The Bedrock client.
   *
   * The region is not optional and is checked here rather than left to the SDK. It
   * picks the endpoint host (bedrock-mantle.{region}.api.aws) and therefore which
   * region's model access applies, so a wrong or absent one fails at the first call;
   * the SDK does throw for a missing one, but it throws about its own constructor
   * option, and the thing the reader has to go and set is a variable in .env.
   *
   * Credentials, in precedence order - a bearer token is the one-value path, static
   * keys are the IAM-user path, and neither means the AWS provider chain resolves
   * them, which is how this should run on a host with an instance role. The static
   * pair is passed only when BOTH halves are present: the SDK deprecates a lone half
   * and would sign with a credential that cannot work.
   */
  private bedrockSdk(): AnthropicBedrockMantle {
    const awsRegion = this.config.get<string>('AWS_REGION');
    if (!awsRegion) {
      throw new LlmError(
        'AWS_REGION is not set and CLAUDE_AUTH_MODE=bedrock. It selects the Bedrock ' +
          'endpoint, and with it which region your model access applies in, so ' +
          'there is nothing sensible to default it to. Set it to the region you ' +
          'enabled Claude in, or set CLAUDE_AUTH_MODE=api-key to go direct instead.',
        { task: '(none)', model: '(none)' },
      );
    }

    const bearer = this.config.get<string>('AWS_BEARER_TOKEN_BEDROCK');
    if (bearer) {
      this.logger.log(`Bedrock in ${awsRegion} with a bearer token`);
      return new AnthropicBedrockMantle({ apiKey: bearer, awsRegion });
    }

    const awsAccessKey = this.config.get<string>('AWS_ACCESS_KEY_ID');
    const awsSecretAccessKey = this.config.get<string>('AWS_SECRET_ACCESS_KEY');
    if (awsAccessKey && awsSecretAccessKey) {
      this.logger.log(`Bedrock in ${awsRegion} with static AWS keys`);
      return new AnthropicBedrockMantle({
        awsRegion,
        awsAccessKey,
        awsSecretAccessKey,
        awsSessionToken: this.config.get<string>('AWS_SESSION_TOKEN') ?? null,
      });
    }

    this.logger.log(
      `Bedrock in ${awsRegion} with credentials from the AWS provider chain`,
    );
    return new AnthropicBedrockMantle({ awsRegion });
  }

  /**
   * The client, narrowed to the one that has a Batch API.
   *
   * Message Batches is one of the few things the Anthropic API has that Bedrock does
   * not, and the Mantle client will let you TYPE the call - its `messages` is the full
   * resource, `batches` included - so nothing but this check stands between a batch
   * request and a 404 from a path that does not exist there. Hence a runtime narrowing
   * rather than a compile-time one.
   *
   * The caller has already chosen the batch path by the time it gets here, which is
   * why this throws instead of quietly running inline - a caller that asked for half
   * price and an hour of latency should be told it cannot have it.
   *
   * The mode is checked BEFORE the client is built, so that a bedrock run with no
   * credentials configured yet reports the batch problem rather than a missing
   * region: the region is not the thing standing between it and a result.
   */
  private batchSdk(taskName: string, model: string): Anthropic {
    const client = this.authMode() === 'bedrock' ? null : this.sdk();
    if (client instanceof Anthropic) return client;

    throw new LlmError(
      `${taskName}: the Batch API does not exist on Bedrock, so mode 'batch' ` +
        'cannot be honoured under CLAUDE_AUTH_MODE=bedrock. Use mode ' +
        "'inline' (the default below BATCH_THRESHOLD items), or switch to " +
        'CLAUDE_AUTH_MODE=api-key for the half-price path.',
      { task: taskName, model },
    );
  }

  async complete<S, I, O>(
    task: LlmTask<S, I, O>,
    shared: S,
    input: I,
  ): Promise<LlmResult<O>> {
    const model = this.modelFor(task.tier);
    const params = this.params(task, shared, input);

    // The one branch between the two doors, and it is only about how the schema is
    // expressed on the wire. Everything after this line is common - which is the
    // reason the branch is here and not duplicated downstream.
    //
    // `.catch` rather than try/catch so that a `wrap`ped error is what escapes,
    // naming the task and the model rather than leaving an SDK message to explain
    // itself.
    const answer = await (
      this.authMode() === 'bedrock'
        ? this.askByTool(task, params)
        : this.askByFormat(task, params)
    ).catch((err: unknown) => {
      throw this.wrap(err, task, model);
    });

    // A refusal is an HTTP 200 with no usable content, so it has to be checked
    // before the content is read. It should be vanishingly rare on this workload -
    // scoring job descriptions is not a sensitive request - but "should be rare" is
    // how a null-dereference at 06:00 gets written.
    if (answer.refusal) {
      throw new LlmError(
        `${task.name}: ${model} declined the request (${answer.refusal})`,
        { task: task.name, model },
      );
    }

    this.logCacheHealth(task, model, answer.usage);

    // THE schema boundary - the only one, for every mode and both paths. Note that
    // the SDK's own zod helper is deliberately not doing this: it throws an
    // AnthropicError on a validation failure, which would arrive here as a generic
    // error and make the drift rate uncountable. See LlmSchemaError.
    const parsed = task.schema.safeParse(answer.json);
    if (!parsed.success) {
      throw this.schemaError(task, model, answer.raw, parsed.error);
    }

    return {
      value: parsed.data,
      provider: this.id,
      model,
      usage: answer.usage,
    };
  }

  /**
   * The Anthropic API path: constrained decoding via `output_config.format`.
   *
   * `create`, not `parse`. The zod helper is still what builds the format - one
   * schema, one derivation - but its parsing half is not used, so that validation
   * happens in exactly one place for all three paths through this file. See
   * `complete`.
   */
  private async askByFormat<S, I, O>(
    task: LlmTask<S, I, O>,
    params: MessageParams,
  ): Promise<Answer> {
    const message = await this.sdk().messages.create({
      ...params,
      output_config: {
        ...params.output_config,
        format: zodOutputFormat(task.schema),
      },
    });

    const raw = textOf(message.content);
    return {
      json: jsonOf(raw),
      raw,
      usage: readUsage(message.usage),
      refusal: refusalOf(message),
    };
  }

  /**
   * The Bedrock path: the schema as a tool the model is required to call.
   *
   * Bedrock has no `output_config.format` and no `strict` (see the note at the top),
   * and this is what is left: one tool, the task's own JSON schema as its input, and
   * `tool_choice` naming it so the model cannot answer in prose instead. The
   * arguments arrive already parsed as an object, so there is one less place for a
   * stray "here is the JSON you asked for:" preamble to break things than on the
   * api-key path.
   *
   * What this does NOT give is constrained decoding: without `strict`, the schema
   * steers the sampler rather than binding it, so a malformed answer is possible here
   * in a way it is not on the api-key path. It is caught in the same place either way
   * - the Zod parse in `complete` was always the real gate, since the ranges and
   * enums that make a score meaningful are not decoder-enforceable on either path.
   * The cost is a retry, and the failure is loud. See LlmSchemaError.
   *
   * `tools` sits in FRONT of `system` in the cache prefix, so this block has to be
   * byte-identical across a run or it invalidates the profile cache behind it. It is:
   * every part of it is a pure function of the task. See `jsonSchemaOf`.
   */
  private async askByTool<S, I, O>(
    task: LlmTask<S, I, O>,
    params: MessageParams,
  ): Promise<Answer> {
    const message = await this.sdk().messages.create({
      ...params,
      tools: [
        {
          name: task.name,
          description:
            `Report the ${task.name} result. Calling this tool is the only way ` +
            'to answer; do not reply with text.',
          input_schema: jsonSchemaOf(task.schema),
        },
      ],
      tool_choice: { type: 'tool', name: task.name },
    });

    const call = message.content.find(
      (block): block is Anthropic.Messages.ToolUseBlock =>
        block.type === 'tool_use',
    );
    const refusal = refusalOf(message);

    if (!call) {
      if (refusal)
        return {
          json: undefined,
          raw: '',
          usage: readUsage(message.usage),
          refusal,
        };

      // With the call forced, one realistic way to land here: max_tokens cut the
      // arguments off mid-object, so the block never completed. Reported as an
      // LlmError and not an LlmSchemaError on purpose - a truncated response is not
      // the model drifting away from the schema, and counting it as drift would
      // hide a maxTokens that needs raising.
      throw new LlmError(
        `${task.name}: ${params.model} did not call the ${task.name} tool it was ` +
          `required to (stop_reason ${message.stop_reason ?? 'none'}). If that is ` +
          `max_tokens, raise ${task.name}'s maxTokens - the arguments were cut off ` +
          'part-written.',
        { task: task.name, model: params.model },
      );
    }

    return {
      json: call.input,
      // For a human reading a schema failure. Already an object, so it is formatted
      // rather than echoed - there is no original text to be faithful to.
      raw: JSON.stringify(call.input, null, 2),
      usage: readUsage(message.usage),
      refusal,
    };
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
        { task: task.name, model: this.modelFor(task.tier) },
      );
    }

    // In bedrock mode the THRESHOLD never chooses batch, because there is nothing to
    // choose: see batchSdk. An explicit `mode: 'batch'` and a batchId to resume both
    // still reach that error rather than being downgraded here - a caller who asked
    // for half price should find out, not wonder why the bill did not move, and a
    // batchId cannot be resumed on a service that never issued it.
    const mode =
      options.mode ??
      (options.batchId
        ? 'batch'
        : items.length >= BATCH_THRESHOLD && this.authMode() !== 'bedrock'
          ? 'batch'
          : 'inline');

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
    const total: LlmUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };

    for (const [index, item] of items.entries()) {
      try {
        const result = await this.complete(task, shared, item.input);
        results.set(item.key, result);
        total.inputTokens += result.usage.inputTokens;
        total.outputTokens += result.usage.outputTokens;
        total.cacheReadTokens += result.usage.cacheReadTokens;
        total.cacheWriteTokens += result.usage.cacheWriteTokens;
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

    // Said out loud, at log level, once per run - the same line the batch path
    // prints. `logCacheHealth` reports each call at DEBUG, which no CLI in this
    // project enables, so without this the one signal that the cache has stopped
    // working is invisible in exactly the runs that pay for it.
    const line =
      `${task.name}: ${results.size}/${items.length} inline, ` +
      `${total.inputTokens} fresh + ${total.cacheReadTokens} cached input ` +
      `token(s) (${total.cacheWriteTokens} written), ` +
      `${total.outputTokens} output`;

    if (items.length > 1 && total.cacheReadTokens === 0) {
      // Every request after the first should have read the prefix the first one
      // wrote, so this run cost roughly what it would have with no caching at all.
      // The WRITE count says which of the two causes it is, and the two need
      // opposite responses - so it is named here rather than left to be re-derived
      // by whoever reads the line.
      this.logger.warn(
        `${line} - nothing was reused. ` +
          (total.cacheWriteTokens > 0
            ? 'Every call wrote a fresh entry, so the prefix is CHANGING between ' +
              'calls: something in task.prefix() or task.instruction is not a pure ' +
              'function of `shared`. That is a bug, and it costs ~10x.'
            : 'Nothing was written either, so the prefix is below the minimum ' +
              'cacheable length (2048 tokens on Haiku, 1024 on Opus) and ' +
              'the API declined to cache it at all. Not a bug - but it is why a ' +
              'fuller profile gets cheaper per posting rather than dearer.'),
      );
    } else {
      this.logger.log(line);
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
    const model = this.modelFor(task.tier);
    const client = this.batchSdk(task.name, model);

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
          requests: items.map((item, i) => {
            const params = this.params(task, shared, item.input);
            return {
              custom_id: `i${i}`,
              // Spread, not replaced: `params` may already have set `effort` for the
              // deep tier, and assigning a fresh output_config here would drop it -
              // making a batched tailoring run quietly think less than an inline one.
              params: {
                ...params,
                output_config: {
                  ...params.output_config,
                  format: zodOutputFormat(task.schema),
                },
              },
            };
          }),
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
  ): MessageParams {
    return {
      // The one place the mode's dialect enters the request. The Bedrock SDK lifts
      // this field out of the body and into the URL path; everything else below goes
      // to both services byte for byte, which is what keeps the two modes from
      // producing different answers.
      model: this.modelFor(task.tier),
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

  /**
   * The drift signal, with the issues spelled out.
   *
   * Takes the ZodError from the caller rather than re-parsing `raw`: the two would
   * be the same today, and would silently stop being the same the moment a path
   * hands over an object it did not derive from that text.
   */
  private schemaError<S, I, O>(
    task: LlmTask<S, I, O>,
    model: string,
    raw: string,
    error: z.ZodError,
  ): LlmSchemaError {
    return new LlmSchemaError({
      task: task.name,
      model,
      raw,
      issues: error.issues
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

    const bedrock = this.authMode() === 'bedrock';

    // Typed classes rather than message matching, so a rate limit stays
    // distinguishable from a bad request when something upstream decides whether to
    // retry. The SDK already retried 429s and 5xxs twice before this point.
    //
    // The two hints name the mode's own failure. On Bedrock a 400 has two likely
    // causes and the message body distinguishes them, so the hint says which to read
    // for: a model this account has not been granted in this region is rejected as a
    // bad request rather than as a permissions error, and a field this endpoint does
    // not implement comes back as "Extra inputs are not permitted" naming the field.
    // Neither is guessable from "rejected the request" alone.
    const kind =
      err instanceof Anthropic.RateLimitError
        ? 'rate limited'
        : err instanceof Anthropic.AuthenticationError
          ? bedrock
            ? 'authentication failed - check the AWS credentials for AWS_REGION ' +
              '(bearer token, static keys, or the provider chain)'
            : 'authentication failed - check ANTHROPIC_API_KEY'
          : err instanceof Anthropic.BadRequestError
            ? bedrock
              ? 'rejected the request. If the message below names a field, this ' +
                'endpoint does not implement it and the code has to stop sending ' +
                'it; otherwise it is the model id - check that this account has ' +
                'been granted access to it in AWS_REGION (Bedrock console -> Model ' +
                'access), and override with BEDROCK_MODEL_FAST / BEDROCK_MODEL_DEEP ' +
                'if it is offered there under a different id'
              : 'rejected the request'
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

/**
 * The task's schema as JSON Schema, for a tool's `input_schema`.
 *
 * Zod's own `toJSONSchema` and NOT the SDK's `zodOutputFormat`, even though the two
 * start from the same schema. `zodOutputFormat` runs the result through a transform
 * built for the constrained decoder, which does not implement `enum`, `minimum`,
 * `maxItems` and friends - it relocates every one of them into a `description`
 * string. That is the right trade for a decoder that would otherwise reject the
 * schema, and the wrong one here: a tool schema DOES support those keywords, and
 * `verdict` arrives better constrained as an actual five-value enum than as prose
 * about one. Same Zod schema, one source, so the two modes still cannot drift apart
 * in what they ask for.
 *
 * `$schema` is dropped: it says nothing to the model and every token of it is in the
 * cached prefix. Pure, and therefore byte-identical on every call of a run - which
 * `askByTool` depends on, since `tools` sits in front of `system` in that prefix.
 */
export function jsonSchemaOf(
  schema: z.ZodType,
): Anthropic.Messages.Tool.InputSchema {
  const { $schema, ...jsonSchema } = z.toJSONSchema(schema);
  void $schema;
  return jsonSchema as Anthropic.Messages.Tool.InputSchema;
}

/** The refusal category, or null when the model did not refuse. */
function refusalOf(message: Anthropic.Messages.Message): string | null {
  return message.stop_reason === 'refusal'
    ? (message.stop_details?.category ?? 'no category')
    : null;
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
