import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';

import { ASSERTED_SESSION_HEADER, assertedOfHeader } from '../asserted.ts';
import type { SessionId } from '../client/contract.ts';
import { INTERNAL_HEADER, SESSION_COOKIE } from '../program.ts';
import { HTTP_BAD_REQUEST, HTTP_PAYLOAD_TOO_LARGE } from '../status.ts';
import { AuthorityError } from './errors.ts';

/**
 * The largest request body the authority reads. A write of the longest text a field may hold
 * (`MAX_TEXT_LENGTH`, 2000 UTF-16 units) fits in it with its binding (4 KiB at most) and the values
 * its update captured (4 KiB), though JSON escapes each unit of a control character as six bytes
 * (`\u0001`): no unit takes more; and so does every server operation `operationCallOf` lets
 * through, whose arguments take 256 Ki units of JSON at most, three bytes of UTF-8 each at most.
 */
const MAX_BODY_BYTES = 1_048_576;

/** What a session id is made of: base64url, as the authority mints them. */
const SESSION_ID = /^[\w-]+$/u;

export function json(
  res: ServerResponse,
  status: number,
  value: unknown,
  headers: OutgoingHttpHeaders = {},
): void {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(value));
}

/** The request's body, which every route takes as a JSON object: anything else is refused. */
export async function readJson(req: IncomingMessage): Promise<Readonly<Record<string, unknown>>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    if (size > MAX_BODY_BYTES) {
      throw new AuthorityError('The request is too large.', {
        code: 'TOO_LARGE',
        status: HTTP_PAYLOAD_TOO_LARGE,
      });
    }
    chunks.push(bytes);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let body: unknown;
  try {
    body = JSON.parse(text === '' ? '{}' : text);
  } catch (error) {
    throw new AuthorityError('The body is not JSON.', {
      cause: error,
      code: 'INVALID_JSON',
      status: HTTP_BAD_REQUEST,
    });
  }
  // `null`, an array or a scalar is JSON too, and no route could read its fields from one.
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AuthorityError('The body is not a JSON object.', {
      code: 'INVALID_JSON',
      status: HTTP_BAD_REQUEST,
    });
  }
  return body as Readonly<Record<string, unknown>>;
}

/** The session the request's cookie names, or `null`. */
export function sessionOf(req: IncomingMessage): string | null {
  const pairs = (req.headers.cookie ?? '').split(';');
  for (const pair of pairs) {
    const separator = pair.indexOf('=');
    if (separator !== -1 && pair.slice(0, separator).trim() === SESSION_COOKIE) {
      const value = pair.slice(separator + 1).trim();
      return SESSION_ID.test(value) ? value : null;
    }
  }
  return null;
}

/**
 * The session the application's server presents on an `/api/` route: the one it asserts in its
 * header (`ASSERTED_SESSION_HEADER`), where it does, else the demo's the cookie names. Never read
 * on a route the visitor's own request reaches, as the edge's gate's does: the header is the
 * server's, beside its internal token.
 */
export function presentedSession(req: IncomingMessage): SessionId {
  const header = req.headers[ASSERTED_SESSION_HEADER];
  const asserted = assertedOfHeader(typeof header === 'string' ? header : undefined);
  return asserted ?? sessionOf(req);
}

export function sessionCookie(sessionId: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${String(maxAge)}`;
}

/** Whether the request carries the internal token: the application's own server speaking. */
export function isInternal(req: IncomingMessage, token: string): boolean {
  const presented = req.headers[INTERNAL_HEADER];
  if (token === '' || typeof presented !== 'string') {
    return false;
  }
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
