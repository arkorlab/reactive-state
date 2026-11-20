import { authority } from './authority.ts';

/**
 * What an application that signs its users in itself calls of the authority from its own server:
 * the key it asserts a session under (`sessionKey`), and the end of every session it asserted under
 * one, as its sign-out (`endSession`).
 */

/** `bytes` as base64url, unpadded: letters, digits, `-` and `_` alone, as a record's id may hold. */
function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  // Base64's padding is its last characters alone: none of it is left, unpadded.
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * The key an application asserts a session under, of its own sign-in's session id: an HMAC-SHA256
 * of it under `secret`, as base64url (43 characters). The sign-in's own id — or its bearer — never
 * reaches the authority, its change log, or a page: what does is a key nobody can make of the id
 * without the secret, and which names the same sign-in every time.
 */
export async function sessionKey(secret: string, appSessionId: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(appSessionId));
  return base64url(new Uint8Array(mac));
}

/**
 * Ends every session the application asserted under `key`, and each stream of one, for good: its
 * sign-out, once its own sign-in's session has ended. Throws where the authority refused the key or
 * did not answer, for the caller to decide whether a sign-out waits for it.
 */
export async function endSession(key: string): Promise<void> {
  const ended = await authority().endSession(key);
  if (!ended.ok) {
    throw new Error(
      `The authority did not end the session (${String(ended.status)} ${ended.code}): ${ended.message}`,
    );
  }
}
