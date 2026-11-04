/**
 * The headers a shared cache reads in place of `Cache-Control`, where it reads them — ahead of it,
 * whatever it says — each of which would have it keep an answer that is one visitor's, or keep one
 * longer than `Cache-Control` lets it: lower case, as `Headers` compares names.
 *
 * - `CDN-Cache-Control` (RFC 9213), of every CDN that reads it, as Cloudflare, Vercel, Netlify and
 *   Akamai do.
 * - Each CDN's own targeted field, which it reads ahead of `CDN-Cache-Control`:
 *   `Cloudflare-CDN-Cache-Control`, `Vercel-CDN-Cache-Control`, `Netlify-CDN-Cache-Control`,
 *   `Akamai-Cache-Control`.
 * - `Edge-Control`, Akamai's own before its targeted field, which it still reads.
 * - `Surrogate-Control` (the W3C's Edge Architecture), which Fastly reads ahead of `Cache-Control`
 *   and beside which Cloudflare reads none of it.
 * - `X-Accel-Expires`, which nginx's proxy cache reads ahead of `Cache-Control` and `Expires`.
 *
 * The delivery route takes each off what it answers one visitor (`keptByNoSharedCache`), and the gate
 * off a guard's own response, whose `private, no-store` stands alone (`GUARD_CACHE_HEADERS`).
 */
export const SHARED_CACHE_HEADERS: ReadonlySet<string> = new Set([
  'akamai-cache-control',
  'cdn-cache-control',
  'cloudflare-cdn-cache-control',
  'edge-control',
  'netlify-cdn-cache-control',
  'surrogate-control',
  'vercel-cdn-cache-control',
  'x-accel-expires',
]);

/** A directive of `Cache-Control`: its name in lower case, as it is compared, and its text as written. */
export interface CacheDirective {
  readonly name: string;
  readonly text: string;
}

/**
 * The directives of a `Cache-Control` value, as RFC 9111 §5.2 lists them: split at each comma
 * outside a quoted string — a field-qualified `private="Set-Cookie, X-User"` one directive, a
 * quoted pair (`\"`) no end of its string — each as written but the blanks around it, an empty
 * member of the list none. A quoted string left open runs to the value's end.
 */
export function cacheDirectivesOf(value: string): readonly CacheDirective[] {
  const members: string[] = [];
  let member = '';
  let quoted = false;
  let escaped = false;
  for (const character of value) {
    if (!quoted && character === ',') {
      members.push(member);
      member = '';
      continue;
    }
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = quoted;
    } else if (character === '"') {
      quoted = !quoted;
    }
    member += character;
  }
  members.push(member);
  return members
    .map((each) => each.trim())
    .filter((text) => text !== '')
    .map((text) => ({ name: (text.split('=', 1)[0] ?? '').trim().toLowerCase(), text }));
}
