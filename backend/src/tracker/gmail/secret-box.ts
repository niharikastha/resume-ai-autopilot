/**
 * Encryption for the one secret this app stores on a candidate's behalf, and signing for
 * the OAuth `state` that protects the round trip which obtains it.
 *
 * AES-256-GCM, a fresh 12-byte IV per value, the auth tag kept beside the ciphertext.
 * GCM rather than CBC because it is authenticated: a stored value that has been tampered
 * with fails to decrypt instead of decrypting to something else.
 *
 * ONE KEY FOR BOTH JOBS, domain-separated. The state HMAC uses a key derived from the
 * master with a fixed label, so a signature can never be confused for anything the
 * cipher produced, and there is still only one secret to provision.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'crypto';

const IV_BYTES = 12;

export class SecretBox {
  private readonly key: Buffer;
  private readonly signingKey: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32) {
      throw new Error('TOKEN_ENCRYPTION_KEY must decode to 32 bytes');
    }
    this.signingKey = createHmac('sha256', this.key)
      .update('gmail-oauth-state')
      .digest();
  }

  /** `iv.tag.ciphertext`, each base64url. */
  seal(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return [iv, cipher.getAuthTag(), body]
      .map((b) => b.toString('base64url'))
      .join('.');
  }

  /** Throws on anything that was not sealed by this key, unchanged. */
  open(sealed: string): string {
    const [iv, tag, body] = sealed
      .split('.')
      .map((part) => Buffer.from(part, 'base64url'));
    if (!iv || !tag || !body || iv.length !== IV_BYTES) {
      throw new Error('not a sealed value');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString(
      'utf8',
    );
  }

  /**
   * A signed, expiring `state` naming the user who started the connect.
   *
   * This is what makes the callback safe to leave @Public: it identifies the user by a
   * value only this server could have produced, rather than by whatever session cookie
   * happens to arrive with Google's redirect. It also defeats the classic OAuth CSRF - an
   * attacker cannot get a victim's browser to finish the attacker's connect, because the
   * attacker cannot mint a state for the victim.
   */
  signState(userId: string, ttlMs: number): string {
    const payload = Buffer.from(
      JSON.stringify({
        u: userId,
        e: Date.now() + ttlMs,
        n: randomBytes(8).toString('hex'),
      }),
    ).toString('base64url');
    return `${payload}.${this.mac(payload)}`;
  }

  /** The user id, or null for a forged, altered or expired state. */
  verifyState(state: string): string | null {
    const [payload, mac] = state.split('.');
    if (!payload || !mac) return null;
    const expected = Buffer.from(this.mac(payload));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given))
      return null;
    try {
      const parsed = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as { u?: unknown; e?: unknown };
      if (typeof parsed.u !== 'string' || typeof parsed.e !== 'number')
        return null;
      return parsed.e > Date.now() ? parsed.u : null;
    } catch {
      return null;
    }
  }

  private mac(payload: string): string {
    return createHmac('sha256', this.signingKey)
      .update(payload)
      .digest('base64url');
  }
}
