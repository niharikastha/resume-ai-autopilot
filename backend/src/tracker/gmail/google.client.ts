/**
 * Google OAuth and the three Gmail calls sync needs, over plain fetch.
 *
 * NO googleapis PACKAGE. It is a very large dependency for four endpoints, and every
 * call below is a documented REST request whose shape fits on a line.
 *
 * gmail.readonly IS THE ONLY SCOPE REQUESTED, and it is asked for alone - no profile,
 * no openid. The mailbox address comes from Gmail's own users/me/profile, which that
 * scope already covers, so there is nothing else to justify on the consent screen.
 */

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

const TIMEOUT_MS = 20_000;

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Google said the grant is gone - revoked, expired, or the password changed. */
export class GrantRevokedError extends Error {}

export interface GmailMessage {
  id: string;
  receivedAt: Date;
  from: string;
  subject: string;
  /** Plain text, capped. The part a reader would see, not the HTML. */
  body: string;
}

export class GoogleClient {
  constructor(private readonly config: GoogleOAuthConfig) {}

  /**
   * `access_type=offline` + `prompt=consent` is what yields a refresh token. Without
   * `prompt=consent` Google only issues one on the FIRST grant, so somebody who
   * disconnected and reconnected would come back with nothing to store.
   */
  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: GMAIL_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'false',
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  /** The refresh token and the scope actually granted, which may be less than asked. */
  async exchangeCode(
    code: string,
  ): Promise<{ refreshToken: string; accessToken: string; scope: string }> {
    const body = await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
    });
    const refreshToken = str(body.refresh_token);
    const accessToken = str(body.access_token);
    if (!refreshToken || !accessToken) {
      throw new Error('Google did not return a refresh token');
    }
    return { refreshToken, accessToken, scope: str(body.scope) };
  }

  async accessToken(refreshToken: string): Promise<string> {
    const body = await this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    const token = str(body.access_token);
    if (!token) throw new Error('Google returned no access token');
    return token;
  }

  /** Best effort: a token Google has already forgotten is as revoked as it gets. */
  async revoke(refreshToken: string): Promise<void> {
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => undefined);
  }

  async mailboxAddress(accessToken: string): Promise<string> {
    const body = await this.gmail(accessToken, '/profile');
    const email = str(body.emailAddress);
    if (!email) throw new Error('Gmail did not say which mailbox this is');
    return email;
  }

  /** Message ids matching a Gmail search, newest first, at most `max`. */
  async search(
    accessToken: string,
    query: string,
    max: number,
  ): Promise<string[]> {
    const ids: string[] = [];
    let pageToken = '';
    while (ids.length < max) {
      const params = new URLSearchParams({
        q: query,
        maxResults: String(Math.min(100, max - ids.length)),
        ...(pageToken ? { pageToken } : {}),
      });
      const body = await this.gmail(accessToken, `/messages?${params}`);
      for (const m of Array.isArray(body.messages) ? body.messages : []) {
        const id = str((m as Record<string, unknown>).id);
        if (id) ids.push(id);
      }
      pageToken = str(body.nextPageToken);
      if (!pageToken) break;
    }
    return ids.slice(0, max);
  }

  async message(
    accessToken: string,
    id: string,
    bodyCap: number,
  ): Promise<GmailMessage> {
    const body = await this.gmail(
      accessToken,
      `/messages/${encodeURIComponent(id)}?format=full`,
    );
    const payload = rec(body.payload);
    const headers = Array.isArray(payload.headers) ? payload.headers : [];
    const header = (name: string): string =>
      str(
        rec(
          headers.find(
            (h) => str(rec(h).name).toLowerCase() === name.toLowerCase(),
          ),
        ).value,
      );

    const text = plainText(payload) || str(body.snippet);
    return {
      id,
      receivedAt: new Date(Number(str(body.internalDate)) || Date.now()),
      from: header('From').slice(0, 300),
      subject: header('Subject').slice(0, 500),
      body: text.replace(/\s+\n/g, '\n').trim().slice(0, bodyCap),
    };
  }

  private async tokenRequest(
    fields: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        ...fields,
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = rec(await response.json().catch(() => ({})));
    if (!response.ok) {
      // invalid_grant is the one error that means "ask the user again" rather than
      // "try again later", so it gets its own type.
      if (body.error === 'invalid_grant') {
        throw new GrantRevokedError('Google access was revoked or expired');
      }
      throw new Error(
        `Google token endpoint said ${response.status}: ${str(body.error) || 'unknown error'}`,
      );
    }
    return body;
  }

  private async gmail(
    accessToken: string,
    path: string,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(`${GMAIL}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 401) {
      throw new GrantRevokedError('Gmail refused the access token');
    }
    if (!response.ok) {
      throw new Error(`Gmail API said ${response.status} for ${path}`);
    }
    return rec(await response.json());
  }
}

function rec(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The first text/plain part, depth first; failing that, the first text/html part with
 * the tags stripped. Recruiting mail is very often HTML-only.
 */
function plainText(part: Record<string, unknown>): string {
  const found = findPart(part, 'text/plain');
  if (found) return decode(found);
  const html = findPart(part, 'text/html');
  if (!html) return '';
  return decode(html)
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ');
}

function findPart(
  part: Record<string, unknown>,
  mime: string,
): Record<string, unknown> | null {
  if (str(part.mimeType).toLowerCase() === mime && rec(part.body).data) {
    return part;
  }
  for (const child of Array.isArray(part.parts) ? part.parts : []) {
    const hit = findPart(rec(child), mime);
    if (hit) return hit;
  }
  return null;
}

function decode(part: Record<string, unknown>): string {
  return Buffer.from(str(rec(part.body).data), 'base64url').toString('utf8');
}
