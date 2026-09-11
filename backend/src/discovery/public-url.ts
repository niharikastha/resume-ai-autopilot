/**
 * The check that stands between an operator-typed URL and this server's own network.
 *
 * WHY THIS FILE EXISTS. Every other URL this process fetches is built by a connector
 * from a token - `boards-api.greenhouse.io/v1/boards/${token}/jobs` - so the host is
 * always one of five and always the intended one. Adding a company by URL breaks that
 * property for the first time: the host comes from whoever filled in the form. A server
 * that fetches an arbitrary URL on request is a request forgery primitive, and the
 * interesting targets are the ones only this machine can reach - `http://localhost:3100`,
 * `http://169.254.169.254/latest/meta-data/` on a cloud host, a Postgres admin page on
 * the private network.
 *
 * WHAT IT DOES AND DOES NOT PROMISE.
 *
 *   - It rejects a host that is not a public name: an IP literal, `localhost`, anything
 *     under `.local`/`.internal`/`.localhost`/`.home.arpa`, a single-label host.
 *   - It resolves the name and rejects it if ANY address is private, loopback,
 *     link-local, multicast or otherwise not public unicast. Every address, not the
 *     first: a name that resolves to one public and one loopback address is an attack,
 *     not a misconfiguration, and `fetch` may pick either.
 *   - It does NOT close the two holes below, and pretending otherwise would be worse
 *     than naming them:
 *
 *       REDIRECTS. `DiscoveryHttpClient` follows them, and a public host may redirect to
 *       `http://127.0.0.1:6379`. Closing this needs a per-hop check, which means
 *       `redirect: 'manual'` and a hand-written redirect loop in the http client - a
 *       change to the code path every nightly fetch uses, for a risk that is currently
 *       bounded (see below).
 *
 *       DNS REBINDING. The name is resolved here and resolved again by `fetch`, and a
 *       hostile resolver can answer differently the second time. Closing it means
 *       pinning the address into the request, which Node's fetch has no clean hook for.
 *
 * WHY THAT RESIDUAL RISK IS ACCEPTED HERE. The route is admin-only, so an attacker needs
 * an admin session first. What comes back is not returned raw: on the ATS path the body
 * must parse as a specific board's JSON shape, and on the careers-page path it is passed
 * through an LLM whose output schema holds job titles and nothing else. So the worst
 * available outcome is a mostly-blind request to an internal port, and the cost of
 * closing it fully is a rewrite of the retry loop that every board fetch depends on.
 * If this ever stops being a single-operator app, the redirect check is the thing to
 * add first.
 */
import { lookup } from 'dns/promises';

/** Raised when a URL is refused. The message is shown to the operator verbatim. */
export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

/**
 * Host suffixes that never name something on the public internet.
 *
 * `.local` is mDNS, `.internal` is what cloud providers hand out for private DNS,
 * `.home.arpa` is the reserved home-network name. A careers page is never at any of
 * them, so refusing the whole suffix costs nothing.
 */
const PRIVATE_SUFFIXES = [
  '.local',
  '.localhost',
  '.internal',
  '.intranet',
  '.lan',
  '.home.arpa',
];

/**
 * True for an address that is not public unicast.
 *
 * The v4 list is IANA's special-purpose registry, not a guess: 100.64/10 is carrier
 * NAT (and what a container runtime may hand out), 169.254/16 is where the cloud
 * metadata service lives, 198.18/15 is benchmarking, 240/4 is reserved.
 */
export function isPrivateAddress(address: string): boolean {
  // An IPv4-mapped IPv6 address (`::ffff:10.0.0.1`) is an IPv4 address wearing a
  // different notation, and testing it as v6 would let every private v4 range through.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const value = mapped ? mapped[1] : address;

  if (value.includes(':')) return isPrivateV6(value);

  const parts = value.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    // Unparseable is refused rather than allowed. This function's answer is used as
    // permission to make a request, so "I do not know" must mean no.
    return true;
  }
  const [a, b] = parts;

  if (a === 0) return true; // this network
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier NAT
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 0) return true; // protocol assignments / 192.0.0.0/24
  if (a === 192 && b === 168) return true; // private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isPrivateV6(address: string): boolean {
  const value = address.toLowerCase().replace(/%.*$/, '');
  if (value === '::' || value === '::1') return true;
  if (value.startsWith('fe8') || value.startsWith('fe9')) return true; // link-local
  if (value.startsWith('fea') || value.startsWith('feb')) return true; // link-local
  if (value.startsWith('fc') || value.startsWith('fd')) return true; // unique local
  if (value.startsWith('ff')) return true; // multicast
  return false;
}

/** True when the host is written as an address rather than as a name. */
function isIpLiteral(host: string): boolean {
  // A bracketed host is v6 by definition; URL keeps the brackets in `hostname`.
  if (host.startsWith('[')) return true;
  return /^[\d.]+$/.test(host) || host.includes(':');
}

/**
 * Parses a URL and refuses it unless it names a public host.
 *
 * Returns the parsed URL so the caller uses the normalised form rather than the string
 * it was given - the fragment and any credentials are gone, and the host is lower case.
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeUrlError(
      'That is not a URL. Paste the full address of the careers page, including https://.',
    );
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UnsafeUrlError(
      `Only http and https addresses can be fetched, not ${url.protocol.replace(':', '')}.`,
    );
  }

  if (url.username || url.password) {
    throw new UnsafeUrlError(
      'Remove the username and password from the URL. A public careers page does not need them.',
    );
  }

  const host = url.hostname.toLowerCase();

  if (isIpLiteral(host)) {
    throw new UnsafeUrlError(
      'Use the site name, not an IP address. A company careers page always has a hostname.',
    );
  }

  if (host === 'localhost' || !host.includes('.')) {
    throw new UnsafeUrlError(`${host} is not a public site.`);
  }

  if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new UnsafeUrlError(
      `${host} is a private network name, not a public site.`,
    );
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new UnsafeUrlError(
      `${host} does not resolve. Check the spelling of the address.`,
    );
  }

  if (addresses.length === 0) {
    throw new UnsafeUrlError(`${host} does not resolve to any address.`);
  }

  const blocked = addresses.find((entry) => isPrivateAddress(entry.address));
  if (blocked) {
    // The address is named in the message on purpose. The operator who typed this is
    // the same person who runs the machine, and "resolves to 127.0.0.1" is the fact
    // that explains the refusal - withholding it would just look like a bug.
    throw new UnsafeUrlError(
      `${host} resolves to ${blocked.address}, which is on a private network. ` +
        'Only public sites can be fetched.',
    );
  }

  // Fragments never reach a server; dropped here so the stored URL is the one fetched.
  url.hash = '';
  return url;
}
