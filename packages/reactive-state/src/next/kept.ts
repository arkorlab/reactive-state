import { revalidateTag, updateTag } from 'next/cache';

import type { AssertedSession } from '../asserted.ts';
import type { SessionId } from '../client/index.ts';
import { requestSession, type SessionSource } from './authority.ts';

/**
 * What names a session on the application's server beyond the session itself: the digest a page is
 * told of it, and the tags of the roots the deployment's cache keeps for it (`prefetchCache:
 * 'remote'`) — each root's render, kept by the reader's session and its props inside
 * `'use cache: remote'`, tagged by a bucket of the session and one of its user — with the sessions
 * whose roots may be kept, an application's own before its `expires` (`keptSessionOf`), and what
 * expires them: an operation of the reader's that ran (`revalidateTag` of a window of none), a
 * page's refresh for a session that ended, changed or was refused and the application's own Server
 * Actions (`updateTag`), and the application's taking a reader's access away or granting it
 * (`expireKeptRootsOfUser`).
 */

/** The bytes of a digest a page is told of its session, and of which a tag's bucket is read. */
const DIGEST_BYTES = 12;
const HEX = 16;
/** The buckets a kind of tag is one of: the first ten bits of a digest. */
const BUCKETS = 1024;
/** The hexadecimal digits a bucket is written in, `000` to `3ff`. */
const BUCKET_DIGITS = 3;

/** What starts the tag of the roots the deployment's cache keeps for a session. */
const KEPT_TAG = 'reactive-state:kept:';
/** What starts the tag of the roots the deployment's cache keeps for any session of a user. */
const KEPT_USER_TAG = 'reactive-state:kept-user:';

/** The first `DIGEST_BYTES` of the SHA-256 of `text`, in hexadecimal. */
async function digestOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest, 0, DIGEST_BYTES), (byte) =>
    byte.toString(HEX).padStart(2, '0'),
  ).join('');
}

/**
 * What a page is told of the session it was rendered for: a digest of its id, never the id — the
 * `HttpOnly` cookie, which a script that read it could present from anywhere — and nothing for no
 * session. It tells the page that it shows another session than before, whose pending operations
 * are not this one's.
 */
export async function sessionName(session: SessionId): Promise<string> {
  if (session === null) {
    return '';
  }
  // An asserted session is named by its key and its user both, as the authority names it.
  const named = typeof session === 'string' ? session : `app.${session.id}.${session.user}`;
  return digestOf(`arkorlab.reactive-state.session:${named}`);
}

/** The bucket of `digest`, of `digestOf`: its first ten bits, as three hexadecimal digits. */
function bucketOf(digest: string): string {
  const leading = Number.parseInt(digest.slice(0, BUCKET_DIGITS), HEX);
  const bucket = Math.floor(leading / (HEX ** BUCKET_DIGITS / BUCKETS));
  return bucket.toString(HEX).padStart(BUCKET_DIGITS, '0');
}

/**
 * The tag the deployment's cache keeps the roots of `session` under, an application's own session:
 * its bucket of 1,024, the first ten bits of the digest a page is told of it (`sessionName`), of
 * its key and its user — never the key, which the cache holds as it is — and the same whenever the
 * session expires, so that one expiry reaches every root kept for it. 23 characters.
 *
 * A bucket, and no tag of each session's: a deployment's cache scope keeps a row for good of every
 * tag an invalidation names, under a quota of 100,000 a deployment, past which an invalidation that
 * names a new tag is refused whole — the application's own `updateTag` and `revalidatePath` too —
 * which a tag of each session's would reach once as many sessions had each run an operation or
 * signed out. The buckets of both kinds are 2,048 tags
 * at most, about 2% of it. The cache's key, which holds the session, keeps each session's render
 * its own; an expiry reaches the kept renders of the bucket's other sessions too, about one in
 * 1,024, whose next request asks the authority: a cost, never data stale.
 */
export async function keptRootTag(session: AssertedSession): Promise<string> {
  return `${KEPT_TAG}${bucketOf(await sessionName(session))}`;
}

/**
 * The tag the deployment's cache keeps every root of any session of `user` under, beside the
 * session's own (`keptRootTag`): `user` as the application's session source asserts it, by its
 * bucket of 1,024, of a digest — never the user's id, which the cache would hold as it is — as
 * `keptRootTag`'s, and for the same quota, so that the roots of a reader whose access the
 * application takes away, or grants, are expired whatever session they were kept for
 * (`expireKeptRootsOfUser`), with those of the bucket's other users. 28 characters.
 */
export async function keptUserTag(user: string): Promise<string> {
  const digest = await digestOf(`arkorlab.reactive-state.user:${user}`);
  return `${KEPT_USER_TAG}${bucketOf(digest)}`;
}

/** Whether `session` is one the deployment's cache may keep roots of: an application's own. */
function isAsserted(session: SessionId): session is AssertedSession {
  return session !== null && typeof session !== 'string';
}

/**
 * The session the deployment's cache may keep the roots of, of the `session` a request is of: an
 * application's own, while its `expires` is after the clock; none otherwise — no session, a demo
 * session, an assertion that has expired, which a session source may go on answering past its end
 * and which the entry's key would match all the same. What a kept root's entry asks inside a
 * function of its own that opens with `'use cache: private'` (`--prefetch-cache remote`): there the
 * application's session source does its I/O and the clock is read, as inside any cache, where a
 * read of the clock outside one — Next.js's `Date` extension
 * (`node-environment-extensions/date.js`, `io-utils.js`) — aborts a runtime prefetch, and the
 * session source's uncached I/O leaves the root out of it; and a runtime prefetch includes a
 * private cache (`use-cache-wrapper.js`). The entry keeps the root of what this answers in
 * `'use cache: remote'`, called outside that private cache — Next.js refuses a private cache inside
 * a remote one, and its docs the other way round — and renders the root as it comes where this
 * answers none, as a request of no session. By the application's server's clock: an entry is never
 * served past its session's `expires`.
 */
export function keptSessionOf(session: SessionId): AssertedSession | null {
  return isAsserted(session) && session.expires > Date.now() ? session : null;
}

/**
 * Expires the roots the deployment's cache keeps for the request's session — the application's
 * own, read by `source` — with those of its bucket's other sessions (`keptRootTag`), for a Server
 * Action of the application's that changes what they read, so that the page it renders next is the
 * authority's again, and for its sign-out, before the session ends. Nothing for a request of no
 * session, nor of the demo's sessions, of which nothing is kept.
 * By `updateTag`, as the compile's `expire` does: the browser lets go of every page it prefetched
 * as well, which a change of the reader's access or data asks for. A Server Action's alone, as
 * `updateTag` is, which throws anywhere else.
 */
export async function expireKeptRoots(source?: SessionSource): Promise<void> {
  const session = await requestSession(source);
  if (isAsserted(session)) {
    updateTag(await keptRootTag(session));
  }
}

/** The window an operation's expiry leaves a kept root: none, so that it is gone at once. */
const AT_ONCE = { expire: 0 } as const;

/**
 * Expires the roots the deployment's cache keeps for `session`, with those of its bucket's other
 * sessions (`keptRootTag`), as an operation of it that ran does (`operate`): before the application
 * applies the session change it asked for — which may throw, or redirect — and before its
 * `refresh()`. Next.js applies what a Server Action expired whether it answers or throws
 * (`executeActionAndPrepareForRender`, `action-handler.js`), and renders a redirect's target told
 * of it (`createRedirectRenderResult`) — but of an action it renders no page for
 * (`shouldSkipPageRendering`: one forwarded, or a fetch action on a fallback route), whose redirect
 * puts no expiry in force: a known limit (the package README). Never of a refusal, nor of an
 * unknown outcome: an expiry would have the error's answer render the route, of the authority that
 * just failed (`OperatedBy.kept`). At once — `revalidateTag` of a window of none, which Next.js
 * puts in force for the route the Server Action renders again (`revalidate.js`), and hands the
 * cache's handlers as `{ expire: 0 }` (`revalidation-utils.js`) — and not by `updateTag`. A tag of
 * no profile, `updateTag`'s, is what an action's answer says it revalidated the static and the
 * dynamic by (`x-action-revalidated: 1`, `action-handler.js`), for which the browser lets go of
 * every page it prefetched (`server-action-reducer.js`); of this one, the answer is `refresh()`'s,
 * of the dynamic alone, and the browser keeps them, as a private build's operation leaves them.
 *
 * That rests on the `refresh()` after it, which sets what the answer says to the dynamic alone:
 * without it, or were Next.js to stop letting it say less, the answer would let go of every
 * prefetched page as `updateTag`'s does — navigations slower after an operation, never data stale.
 * So it is where the applier throws or redirects, no `refresh()` coming after: a session change,
 * which writes a cookie, has the answer say so already (`addRevalidationHeader`), and the applier's
 * error has the route rendered again in that answer, which the browser shows.
 * The action's own render never serves the expired entry, whatever its tag's profile: an entry of a
 * tag the request revalidated after the entry was made is let go of (`isRevalidatedAfter`,
 * `use-cache-wrapper.js`). Next.js's built-in handlers — `next dev`, `next start` of no
 * `cacheHandlers` — have bugs of this path, of a clock's skew and of a later revalidation of the tag
 * by a profile, as `updateTag` has most of them; a deployment installs handlers of its own, which
 * keep no tag manifest of Next.js's and put an `expire` of 0 in force at once, as the cache's
 * authority records it, as it records `updateTag`'s; and this tag is only ever expired at once,
 * never with a window. As read of Next.js 16.4.5; 16.4.6 changes none of those files but the
 * version `use-cache-wrapper.js` writes into a cache's key.
 *
 * Called where nothing may be expired — a render, another server function's code — it expires
 * nothing, and the operation ran all the same.
 */
export async function expireKeptRootsOf(session: SessionId): Promise<void> {
  if (!isAsserted(session)) {
    return;
  }
  const tag = await keptRootTag(session);
  try {
    revalidateTag(tag, AT_ONCE);
  } catch {
    // Outside a Server Action's own work nothing is kept for a page's route to expire.
  }
}

/**
 * Expires, at once, every root the deployment's cache keeps for any session of `user` — the id the
 * application's session source asserts as `user` — by its tag (`keptUserTag`), with those of its
 * bucket's other users: what the application calls where it changes a reader's access and the
 * session stays — takes it away, as it removes a member, lowers a role, or has the reader leave a
 * team, or grants it where a kept root refused it, as it adds a member or raises a role. A render
 * kept from before is else served to that reader for as long as the cache keeps it — to a request
 * that runs no page script, the route's payload asked for as it is, which the authority's refusal
 * never reaches; or, of a refusal kept as any render is, shown on a reload until the root's stream
 * sets it right. It reads no session: the reader is the user given, whoever asks. By
 * `revalidateTag` of a window of none, in a Server Action and a route handler alike. In a Server
 * Action of no `refresh()` after it, the answer renders the route again and says the static and the
 * dynamic were revalidated (`x-action-revalidated: 1`, of the `pathWasRevalidated` the expiry
 * sets), for which the acting browser lets go of the pages it prefetched, as an access that changed
 * asks for. It throws where `revalidateTag` does, during a render.
 */
export async function expireKeptRootsOfUser(user: string): Promise<void> {
  revalidateTag(await keptUserTag(user), AT_ONCE);
}
