/**
 * Password hashing on node:crypto scrypt.
 *
 * scrypt rather than bcrypt or argon2 because it is built into Node - no native
 * build step, no extra dependency - and it is memory-hard, which is the property
 * that matters. At this scale (a handful of accounts on a machine that is never
 * publicly exposed) the marginal benefit of argon2id does not pay for a native
 * module in the install path. See PLAN-v2 2A.6.
 */
import {
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from 'crypto';
import { promisify } from 'util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * N=2^16 with r=8, p=1 costs roughly 64 MB and ~100ms. `maxmem` has to be
 * raised explicitly: Node's default 32 MB limit is below what this N needs, and
 * the failure mode is an error at hash time rather than a weak hash.
 */
const PARAMS = { N: 1 << 16, r: 8, p: 1 } as const;
const KEYLEN = 64;
const maxmem = 256 * 1024 * 1024;

/**
 * "scrypt$N$r$p$salt$hash", all base64url.
 *
 * The cost parameters travel inside the string so they can be raised later
 * without invalidating existing passwords - verify reads the parameters the hash
 * was made with, rather than assuming today's.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, KEYLEN, {
    ...PARAMS,
    maxmem,
  });
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }

  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');

  let actual: Buffer;
  try {
    actual = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem,
    });
  } catch {
    return false;
  }

  // Length is checked first because timingSafeEqual throws on a mismatch rather
  // than returning false.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
