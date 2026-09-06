/**
 * The only way this module reaches the internet.
 *
 * Everything about being a good citizen is enforced HERE rather than left to each
 * connector to remember: the honest User-Agent, the per-host delay, the timeout,
 * the retry policy, and the refusal to send anything at all without a contact
 * address. A connector cannot opt out of these, because a connector never gets a
 * `fetch` - it gets this client.
 *
 * NO anti-detection, fingerprint spoofing, or header forgery, now or later. The
 * User-Agent below says exactly what this is and how to reach a human, and if a
 * site decides to block it, the correct response is to stop fetching that site -
 * not to disguise the request. That is a standing constraint on this file.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DISCOVERY_VERSION,
  MAX_RESPONSE_BYTES,
  MAX_ATTEMPTS,
  MAX_RETRY_AFTER_MS,
  PER_HOST_MIN_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  RETRY_BASE_DELAY_MS,
} from './discovery.constants';

/** Raised when a fetch fails in a way the caller should record, not retry. */
export class FetchError extends Error {
  /**
   * How long the server asked us to wait, if it said so.
   *
   * Mutable rather than a constructor argument because it is discovered from a
   * response header at the throw site, whereas the rest of the error is known by
   * whoever is constructing it.
   */
  retryAfterMs?: number;

  constructor(
    message: string,
    readonly status: number | null,
    /** True when the body said "no such tenant" despite a 200 - see the note in
     *  the connectors about Keka/Zoho/Darwinbox returning 200 for anything. */
    readonly tenantMissing = false,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class DiscoveryHttpClient {
  private readonly logger = new Logger(DiscoveryHttpClient.name);

  /**
   * Last request time per host, so the delay is per-operator.
   *
   * A plain Map that only ever grows. Bounded in practice by the number of distinct
   * ATS hosts, which is five - not by the number of companies, since every
   * Greenhouse board shares one hostname.
   */
  private readonly lastRequestAt = new Map<string, number>();

  /**
   * The in-flight gate per host.
   *
   * Without this, two concurrent workers both read `lastRequestAt`, both see the
   * gap as satisfied, and both fire - so FETCH_CONCURRENCY of 4 becomes a burst of
   * 4 on one host and the per-host interval means nothing. Chaining onto a
   * per-host promise makes the check-and-update atomic with respect to the other
   * workers.
   */
  private readonly hostGate = new Map<string, Promise<void>>();

  constructor(private readonly config: ConfigService) {}

  /**
   * The contact address, or null if unconfigured.
   *
   * Read on each call rather than cached at construction so that setting it does
   * not require knowing which process to restart.
   */
  private contactEmail(): string | null {
    return this.config.get<string>('DISCOVERY_CONTACT_EMAIL') ?? null;
  }

  /**
   * Whether outbound discovery is permitted to run at all.
   *
   * Exposed so the scheduler and CLI can say "not configured" up front instead of
   * starting a pass that fails on its first request.
   */
  isConfigured(): boolean {
    return this.contactEmail() !== null;
  }

  /**
   * An honest User-Agent naming the project, its purpose, and a human.
   *
   * The contact address is the part that matters. It is what lets an operator who
   * dislikes this traffic send an email instead of a silent firewall rule, and
   * being reachable is the whole reason we are entitled to make these requests
   * unannounced.
   */
  userAgent(): string {
    const email = this.contactEmail();
    if (!email) {
      // Never reached in practice - fetchJson refuses earlier - but throwing here
      // means no code path can ever construct an anonymous UA by accident.
      throw new Error('DISCOVERY_CONTACT_EMAIL is not set');
    }
    return `autopilot-job-discovery/${DISCOVERY_VERSION} (personal job search; +mailto:${email})`;
  }

  /**
   * Waits out the per-host interval, then records this request's time.
   *
   * Returns after the gap has elapsed. Each caller for a host queues behind the
   * previous one, which is what makes the interval a real floor rather than an
   * average.
   */
  private async takeHostSlot(host: string): Promise<void> {
    const previous = this.hostGate.get(host) ?? Promise.resolve();

    const mine = previous.then(async () => {
      const last = this.lastRequestAt.get(host);
      if (last !== undefined) {
        const wait = PER_HOST_MIN_INTERVAL_MS - (Date.now() - last);
        if (wait > 0) await sleep(wait);
      }
      this.lastRequestAt.set(host, Date.now());
    });

    // Swallow rejections on the stored chain so one failure does not poison every
    // later request to the host. The awaited `mine` still surfaces them.
    this.hostGate.set(
      host,
      mine.catch(() => undefined),
    );
    await mine;
  }

  /**
   * GETs a JSON document, with retries.
   *
   * Returns the parsed body. Throws FetchError on a status the caller should record
   * - the caller's job is to note the board as failed and carry on to the next one,
   * never to abandon the pass.
   */
  async fetchJson<T>(url: string, label: string): Promise<T> {
    if (!this.isConfigured()) {
      // Fails CLOSED, and this is the guarantee the plan actually asks for: no
      // request leaves this process without a contact address on it.
      //
      // Deliberately not a boot-time requirement. The api and the worker share one
      // AppModule, so making it mandatory in env.schema.ts would stop the web app
      // from starting over a setting only the daily fetch uses - the same reasoning
      // that leaves the SMTP and LLM keys optional and fails them at the point of
      // use. The difference between the two designs is which thing breaks when the
      // value is missing, and it should be discovery, not login.
      throw new FetchError(
        'DISCOVERY_CONTACT_EMAIL is not set. Outbound job-board requests carry a ' +
          'contact address so a site operator can reach a human; discovery will ' +
          'not run without one. Add it to .env and restart the worker.',
        null,
      );
    }

    const host = new URL(url).host;
    let lastError: FetchError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this.takeHostSlot(host);

      try {
        return await this.attempt<T>(url);
      } catch (err) {
        const error =
          err instanceof FetchError
            ? err
            : new FetchError(
                err instanceof Error ? err.message : String(err),
                null,
              );
        lastError = error;

        // 4xx other than 429 will not change on a retry: a 404 board does not
        // appear, and a 403 means we are not welcome. Retrying either wastes a
        // request on a host that has already answered clearly.
        const retryable =
          error.status === null || error.status === 429 || error.status >= 500;
        if (!retryable || attempt === MAX_ATTEMPTS) break;

        const delay =
          error.retryAfterMs ?? RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        this.logger.warn(
          `${label}: ${error.message} - retrying in ${Math.round(delay / 1000)}s ` +
            `(attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
        );
        await sleep(delay);
      }
    }

    throw lastError ?? new FetchError(`${label}: failed`, null);
  }

  /** One attempt, with the timeout and the size cap. */
  private async attempt<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      headers: {
        'User-Agent': this.userAgent(),
        Accept: 'application/json',
        // No cookie jar, no referer, no invented Sec-* headers. We are a script and
        // the request should look like one.
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const error = new FetchError(
        `HTTP ${response.status} ${response.statusText}`.trim(),
        response.status,
      );
      error.retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      throw error;
    }

    const body = await readCapped(response);

    try {
      return JSON.parse(body) as T;
    } catch {
      // A board that answers 200 with HTML is usually a marketing page where an
      // API used to be. Recorded as a failure with a snippet, because the snippet
      // is what tells you whether the endpoint moved or the tenant is gone.
      throw new FetchError(
        `expected JSON, got ${body.slice(0, 80).replace(/\s+/g, ' ')}`,
        response.status,
      );
    }
  }
}

/**
 * `Retry-After`, in milliseconds, capped.
 *
 * The header comes in two forms - delta-seconds and an HTTP date - and both appear
 * in the wild, so both are handled. An unparseable value yields null and the
 * caller's exponential backoff applies instead.
 */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;

  const trimmed = header.trim();

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  // A header that is a number but not a usable one - `-5`, `NaN` - is malformed, and
  // it stops here rather than falling through to Date.parse. That matters because
  // Date.parse is lenient enough to read "-5" as a date, which came out as 0ms: a
  // malformed header would have become an INSTANT retry against a host that had just
  // asked us to wait. Exponential backoff is the right answer to a header we cannot
  // read.
  if (/^[-+]?\d*\.?\d+$/.test(trimmed)) return undefined;

  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) {
    // Clamped at 0: a server whose clock is behind ours sends a date in our past,
    // and a negative delay would otherwise become an instant retry.
    return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
  }

  return undefined;
}

/**
 * Reads a response body, refusing to grow past MAX_RESPONSE_BYTES.
 *
 * `response.text()` would buffer whatever arrives, and `content-length` is absent
 * on a chunked response - so the limit has to be applied while reading, not
 * checked beforehand.
 */
async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return response.text();

  const decoder = new TextDecoder();
  const parts: string[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      // Cancel rather than just stopping: an abandoned reader leaves the socket
      // open, and doing that once per pathological board is a connection leak.
      await reader.cancel();
      throw new FetchError(
        `response exceeded ${Math.round(MAX_RESPONSE_BYTES / 1024 / 1024)}MB`,
        response.status,
      );
    }
    // `stream: true` so a multi-byte character split across two chunks is not
    // decoded as two replacement characters. Job descriptions carry accented
    // names and CJK titles, so this is a real case and not a hypothetical one.
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());

  return parts.join('');
}
