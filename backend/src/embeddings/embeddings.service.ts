/**
 * Local sentence embeddings. No API, no key, no per-call cost.
 *
 * bge-small-en-v1.5 through @huggingface/transformers, running on onnxruntime in
 * this process. 384 dimensions, which is what `vector(384)` on
 * `profile_atoms.embedding` and `candidate_profiles.embedding` was declared as -
 * so the model choice and the schema are coupled, and swapping the model means a
 * migration plus a re-embed of every row. That is why the width is ASSERTED here
 * rather than trusted: a model that quietly returns 768 would otherwise fail at
 * the INSERT with a Postgres type error and no hint about the cause.
 *
 * Local rather than an embedding API because this runs over thousands of postings
 * a day. At OpenAI's small-embedding price that is a real recurring bill for a
 * personal job search, and the quality difference on short technical text does not
 * pay for it. It is also the one part of the matching pipeline that keeps working
 * with no credentials at all.
 *
 * The first call downloads roughly 130MB of weights and takes a while. Everything
 * after that is a few milliseconds per text on CPU.
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { resolve } from 'path';

/** The declared width of every vector column in the schema. */
export const EMBEDDING_DIM = 384;

/** The model whose output those columns hold. */
export const EMBEDDING_MODEL = 'Xenova/bge-small-en-v1.5';

/**
 * Texts per forward pass.
 *
 * Small on purpose. Each item in a batch is padded to the longest one in it, so a
 * batch containing one 512-token job description and fifteen short bullets does
 * sixteen 512-token passes' worth of work. 16 keeps that waste bounded while
 * still amortising the call overhead.
 */
const BATCH_SIZE = 16;

/**
 * The pipeline's type, without importing the module at load time.
 *
 * `import type` is erased at compile time, so this costs nothing at runtime -
 * which matters because loading the real module pulls in onnxruntime, half a
 * gigabyte of native binary that the api process has no reason to touch unless
 * something asks it to embed.
 *
 * Named concretely rather than as `Awaited<ReturnType<typeof pipeline>>`:
 * `pipeline` is overloaded across every task the library supports, and asking tsc
 * to represent that union produces "type is too complex to represent" (TS2590).
 */
type Extractor = import('@huggingface/transformers').FeatureExtractionPipeline;

@Injectable()
export class EmbeddingsService implements OnModuleDestroy {
  private readonly logger = new Logger(EmbeddingsService.name);

  /**
   * The load, kept as a PROMISE rather than the resolved pipeline.
   *
   * Two callers that both arrive before the model has finished loading must not
   * start two downloads of the same 130MB. Caching the in-flight promise makes
   * the second one wait on the first.
   */
  private loading: Promise<Extractor> | null = null;

  constructor(private readonly config: ConfigService) {}

  /**
   * Loads the model, once.
   *
   * The cache directory is set OUTSIDE node_modules. The library's default is
   * `node_modules/@huggingface/transformers/.cache`, which `npm ci` deletes - so
   * the default costs a fresh 130MB download after every clean install.
   */
  private async extractor(): Promise<Extractor> {
    if (this.loading) return this.loading;

    this.loading = (async () => {
      const { env, pipeline } = await import('@huggingface/transformers');

      env.cacheDir =
        this.config.get<string>('EMBEDDING_CACHE_DIR') ??
        resolve(process.cwd(), '.models');
      // No remote lookups beyond the model download itself, and no telemetry.
      env.allowLocalModels = true;

      const started = Date.now();
      this.logger.log(
        `loading ${EMBEDDING_MODEL} (first run downloads ~130MB to ${env.cacheDir})`,
      );

      // `pipeline` is overloaded across every task the library supports, and
      // letting tsc resolve that overload set is what produces TS2590, "union type
      // too complex". Narrowing the reference to the one signature this file uses
      // sidesteps the resolution entirely and documents which call is being made.
      const load = pipeline as unknown as (
        task: 'feature-extraction',
        model: string,
        options?: { dtype?: string },
      ) => Promise<Extractor>;

      const extractor = await load('feature-extraction', EMBEDDING_MODEL, {
        // fp32, not a quantised build. Quantisation saves ~100MB of download and
        // costs accuracy in the cosine distances this is used for - and the
        // distances are the whole product. Overridable for a memory-tight host.
        dtype: this.config.get<string>('EMBEDDING_DTYPE') ?? 'fp32',
      });

      this.logger.log(`model ready in ${Math.round((Date.now() - started) / 1000)}s`);
      return extractor;
    })();

    // A failed load must not be cached, or every later call replays the same
    // error - including the one that happens because the network was briefly out.
    this.loading.catch(() => {
      this.loading = null;
    });

    return this.loading;
  }

  /**
   * Embeds texts, in order, one vector each.
   *
   * CLS pooling and L2 normalisation, which is what bge-v1.5 was trained with -
   * mean pooling on this model measurably degrades retrieval. Normalised output
   * means cosine similarity is a dot product, and pgvector's `<=>` operator
   * becomes `1 - dot`.
   *
   * NO instruction prefix. bge documents prefixing the QUERY side of an
   * asymmetric search ("Represent this sentence for searching relevant
   * passages:"), and both sides here are documents of comparable length - a job
   * description against a resume bullet. Prefixing one side only, or prefixing at
   * ingestion and forgetting to at query time, produces vectors that sit in
   * slightly different regions and quietly worsens every match. Neither side is
   * prefixed, which is at least consistent.
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const extractor = await this.extractor();
    const vectors: number[][] = [];

    for (let at = 0; at < texts.length; at += BATCH_SIZE) {
      const batch = texts
        .slice(at, at + BATCH_SIZE)
        // A model given '' returns a vector for a single special token, which is
        // a valid-looking embedding of nothing. A space is no better. Callers are
        // expected not to pass empty text; this is the backstop that makes the
        // failure loud instead of silently storing a meaningless vector.
        .map((text) => {
          if (text.trim().length === 0) {
            throw new Error(
              'refusing to embed empty text - an embedding of nothing is ' +
                'indistinguishable from a real one once it is in the table',
            );
          }
          return text;
        });

      const output = await extractor(batch, { pooling: 'cls', normalize: true });
      const rows = output.tolist() as number[][];

      for (const row of rows) {
        if (row.length !== EMBEDDING_DIM) {
          throw new Error(
            `${EMBEDDING_MODEL} returned ${row.length} dimensions, but every ` +
              `vector column in the schema is vector(${EMBEDDING_DIM}). Changing ` +
              'the model needs a migration and a re-embed of every stored row.',
          );
        }
        vectors.push(row);
      }
    }

    return vectors;
  }

  /** Embeds one text. */
  async embedOne(text: string): Promise<number[]> {
    const [vector] = await this.embed([text]);
    return vector;
  }

  /**
   * Frees the native session.
   *
   * Without this, a CLI process that has loaded the model hangs on exit: the
   * onnxruntime thread pool is a live handle and Node will not leave the event
   * loop while it exists.
   */
  async onModuleDestroy(): Promise<void> {
    if (!this.loading) return;
    const extractor = await this.loading.catch(() => null);
    await extractor?.dispose();
    this.loading = null;
  }
}

/**
 * pgvector's text input format.
 *
 * `Unsupported("vector(384)")` means Prisma has no type for these columns, so
 * every read and write is raw SQL and the vector crosses as a string. Parameterised
 * as `$1::vector`, never interpolated - it is generated data, but a formatter that
 * builds SQL by concatenation is one refactor away from taking a value from
 * somewhere else.
 */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

/**
 * The hash stored in `embeddedTextHash`.
 *
 * Its only job is to answer "is this vector still about this text". Whatever was
 * embedded is what gets hashed, so the check cannot be fooled by a change in how
 * the text is assembled before embedding.
 */
export function embeddedTextHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
