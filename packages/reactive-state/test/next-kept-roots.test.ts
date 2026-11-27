import { isRedirectError } from 'next/dist/client/components/redirect-error';
import { redirect } from 'next/navigation';
import { isValidElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AssertedSession } from '../src/asserted.ts';
import type { AuthorityClient } from '../src/client/index.ts';
import type * as Authority from '../src/next/authority.ts';
import {
  authorityRefusal,
  type Elements,
  expireKeptRoots,
  expireKeptRootsOfUser,
  keptRootTag,
  keptSessionOf,
  keptUserTag,
  operate,
  renderRoot,
  requestSession,
  type SessionSource,
  type ViewAnswer,
} from '../src/next/index.ts';
import type {
  FieldReceipt,
  OperationReceipt,
  RenderResult,
  RenderStatus,
  Result,
} from '../src/program.ts';
import { LiveRoot } from '../src/react/live-root.tsx';
import { BUILD, frameAt, refusal } from './support/page.ts';

/**
 * The server's half of a root the deployment's cache keeps (`prefetchCache: 'remote'`): its render
 * for a session the entry read, which reads no cookie, as nothing inside `'use cache: remote'` may;
 * the session its entry asks its private cache for (`keptSessionOf`) — an application's own before
 * its `expires`, none otherwise — and what the entry keeps of it, the cache stood in for by one
 * that keeps what its function answered, whatever the root's status, and renders as it comes; the
 * tags its entries are kept under, buckets of a digest of the session and of its user; and what
 * expires them — an operation that ran (`revalidateTag` of a window of none, which keeps the
 * browser's prefetched pages), `expireKeptRoots` of the application's own Server Actions
 * (`updateTag`), and `expireKeptRootsOfUser` where the application takes a reader's access away, in
 * a Server Action or a route handler — with the request's cookies, the authority and Next.js's
 * `revalidateTag`, `updateTag` and `refresh` stood in for.
 */

const hoisted = vi.hoisted(() => {
  return {
    calls: [] as string[],
    client: {} as Record<string, ReturnType<typeof vi.fn>>,
    /**
     * Where a tag is expired from, as Next.js tells them apart: a Server Action (`action`) expires
     * by both, a route handler (`route`) by `revalidateTag` alone, a render (`render`) by none.
     */
    context: 'action',
    cookie: undefined as string | undefined,
    cookiesRead: 0,
  };
});

vi.mock(import('next/headers'), () => {
  return {
    cookies: () => {
      hoisted.cookiesRead += 1;
      return Promise.resolve({
        get: (name: string) =>
          hoisted.cookie === undefined ? undefined : { name, value: hoisted.cookie },
      }) as never;
    },
    headers: () => Promise.resolve(new Headers()),
  };
});
vi.mock(import('next/cache'), () => {
  return {
    refresh: () => {
      hoisted.calls.push('refresh');
    },
    revalidateTag: (tag: string, profile: unknown) => {
      if (hoisted.context === 'render') {
        throw new Error('Route used "revalidateTag" during render, which is unsupported.');
      }
      hoisted.calls.push(`revalidateTag ${tag} ${JSON.stringify(profile)}`);
    },
    updateTag: (tag: string) => {
      if (hoisted.context !== 'action') {
        throw new Error('updateTag can only be called from within a Server Action.');
      }
      hoisted.calls.push(`updateTag ${tag}`);
    },
  };
});
// Next.js's own `redirect()` and `unstable_rethrow`, which `operate` lets a redirect through by.
vi.mock(import('next/navigation'), async (importOriginal) => {
  return {
    ...(await importOriginal()),
    useRouter: () => ({ refresh: vi.fn() }) as never,
  };
});
vi.mock(import('../src/next/authority.ts'), async (importOriginal) => {
  return {
    ...(await importOriginal<typeof Authority>()),
    authority: () => hoisted.client as unknown as AuthorityClient,
  };
});

const ALICE: AssertedSession = { expires: 1_900_000_000_000, id: 'key-alice', user: 'alice' };

const ELEMENTS: Elements = { actions: {}, build: BUILD, clients: {}, modules: {} };

const FRAME = frameAt(3, {});

const update = (): Promise<Result<FieldReceipt>> => Promise.reject(new Error('Not called here.'));
const view = (): Promise<Result<ViewAnswer>> => Promise.reject(new Error('Not called here.'));
const expire = (): Promise<void> => Promise.resolve();

function rendered(): Result<RenderResult> {
  return { ok: true, value: { frame: FRAME, status: 'rendered', tree: null } };
}

/** The authority's answer to a render of a root the session may not see: no tree. */
function answeredAs(status: Exclude<RenderStatus, 'rendered'>): Result<RenderResult> {
  return { ok: true, value: { frame: FRAME, status, tree: null } };
}

/** What the kept root `components/roster` renders, of a request Alice's session source names. */
const ROSTER = {
  component: 'components/roster',
  elements: { ...ELEMENTS, session: sourceOf(ALICE) },
  props: {},
  update,
  view,
};

/** A cache around a kept root's function, by a key: `standInCache`'s. */
type Cached = <T>(key: string, fill: () => Promise<T>) => Promise<T>;

/**
 * A stand-in for the deployment's cache around a kept root's function: what it answered, it keeps
 * by its key and answers again, whatever the root's status; nothing it threw — Next.js's handlers
 * store no entry of a stream that errored (`collectResult`, `use-cache-wrapper.js`;
 * `streamToBuffer` in the built-in handler, `readWithin` in a deployment's, `setUseCache`).
 */
function standInCache(): Cached {
  const kept = new Map<string, unknown>();
  return async <T>(key: string, fill: () => Promise<T>): Promise<T> => {
    if (kept.has(key)) {
      return kept.get(key) as T;
    }
    const value = await fill();
    kept.set(key, value);
    return value;
  };
}

/** The private function of the kept root's entry, as the compile writes it, of no cache here. */
async function sessionKept(): Promise<AssertedSession | null> {
  return keptSessionOf(await requestSession(ROSTER.elements.session));
}

/**
 * The entry of the kept root `components/roster`, as the compile writes it: the session its private
 * function answered kept inside `cached`, by the session; the root rendered as it comes where it
 * answered none, which reads the request's session itself.
 */
async function rosterEntry(
  cached: Cached,
  keep = vi.fn<(session: AssertedSession) => void>(),
): Promise<ReactNode> {
  const session = await sessionKept();
  if (session === null) {
    return renderRoot({ ...ROSTER, expire });
  }
  const fill = (): Promise<ReactNode> => {
    keep(session);
    return renderRoot({ ...ROSTER, expire, prefetchable: true, session });
  };
  return cached(JSON.stringify(session), fill);
}

function operated(): Result<OperationReceipt> {
  return {
    ok: true,
    value: { committedRevision: 4, deduplicated: false, operationId: 'op', result: 'done' },
  };
}

/** An operation that committed and asked for a change of the session (`changeSession`). */
function operatedWithChange(): Result<OperationReceipt> {
  return {
    ok: true,
    value: {
      committedRevision: 4,
      deduplicated: false,
      operationId: 'op',
      result: 'done',
      sessionChange: { activeTeam: 't2' },
    },
  };
}

function noop(): void {
  // Nothing is logged to the test's output.
}

/** The bucket of a digest in hexadecimal: its first ten bits, as three hexadecimal digits. */
function bucketOf(digest: string): string {
  return Math.floor(Number.parseInt(digest.slice(0, 3), 16) / 4)
    .toString(16)
    .padStart(3, '0');
}

/** Sessions, or users, enough that their tags reach each of the 1,024 buckets. */
const SPREAD = 16_384;

/** What `promise` was rejected with; a test fails where it was not. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('The call was not rejected.');
}

/** The props `LiveRoot` was rendered with. */
function liveProps(node: ReactNode): Readonly<Record<string, unknown>> {
  if (!isValidElement(node) || node.type !== LiveRoot) {
    throw new Error('Not a LiveRoot.');
  }
  return node.props as Readonly<Record<string, unknown>>;
}

/** A session source of the application's that answers `session`. */
function sourceOf(session: AssertedSession | null): SessionSource {
  return () => session;
}

describe('a root the deployment’s cache keeps', () => {
  beforeEach(() => {
    hoisted.calls.length = 0;
    hoisted.cookie = undefined;
    hoisted.cookiesRead = 0;
    hoisted.context = 'action';
    hoisted.client = {
      operate: vi.fn(() => Promise.resolve(operated())),
      render: vi.fn(() => Promise.resolve(rendered())),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('keptRootTag', () => {
    it('is one of 1,024 buckets of a digest of the session’s key and user, never the key', async () => {
      const tag = await keptRootTag(ALICE);

      expect(tag).toMatch(/^reactive-state:kept:[0-3][\da-f]{2}$/u);
      expect(tag).not.toContain('key-alice');
      expect(tag).not.toContain('alice');
      expect(tag).toHaveLength('reactive-state:kept:'.length + 3);
    });

    it('is the same for the session whenever it expires', async () => {
      const tag = await keptRootTag(ALICE);

      await expect(keptRootTag({ ...ALICE })).resolves.toBe(tag);
      await expect(keptRootTag({ ...ALICE, expires: ALICE.expires + 1 })).resolves.toBe(tag);
    });

    it('spreads sessions over every bucket from 000 to 3ff, and no further', async () => {
      const tags = await Promise.all(
        Array.from({ length: SPREAD }, async (_, index) =>
          keptRootTag({ ...ALICE, id: `key-${String(index)}` }),
        ),
      );

      expect(
        tags.filter((tag) => !/^reactive-state:kept:[0-3][\da-f]{2}$/u.test(tag)),
      ).toStrictEqual([]);
      expect(new Set(tags).size).toBe(1024);
    });

    it('is the bucket of the digest the page is told of the session, which it is told whole', async () => {
      const root = await renderRoot({
        component: 'components/roster',
        elements: ELEMENTS,
        props: {},
        session: ALICE,
        update,
        view,
      });
      const name = String(liveProps(root)['session']);

      expect(name).toMatch(/^[\da-f]{24}$/u);
      await expect(keptRootTag(ALICE)).resolves.toBe(`reactive-state:kept:${bucketOf(name)}`);
    });
  });

  describe('keptUserTag', () => {
    it('is one of 1,024 buckets of a digest of the user, never the user’s id', async () => {
      const tag = await keptUserTag('user-alice-7f3a');

      expect(tag).toMatch(/^reactive-state:kept-user:[0-3][\da-f]{2}$/u);
      expect(tag).not.toContain('user-alice-7f3a');
      expect(tag).not.toContain('alice');
      expect(tag).toHaveLength('reactive-state:kept-user:'.length + 3);
    });

    it('is the same for the user each time, whatever session, and no session’s tag', async () => {
      const tag = await keptUserTag(ALICE.user);

      await expect(keptUserTag(ALICE.user)).resolves.toBe(tag);
      // Of no session's key: every session of the user shares it, and no session's tag is it.
      await expect(keptRootTag(ALICE)).resolves.not.toBe(tag);
      await expect(keptRootTag({ ...ALICE, id: 'key-other' })).resolves.not.toBe(tag);
    });

    it('spreads users over every bucket from 000 to 3ff, and no further', async () => {
      const tags = await Promise.all(
        Array.from({ length: SPREAD }, async (_, index) => keptUserTag(`user-${String(index)}`)),
      );

      expect(
        tags.filter((tag) => !/^reactive-state:kept-user:[0-3][\da-f]{2}$/u.test(tag)),
      ).toStrictEqual([]);
      expect(new Set(tags).size).toBe(1024);
    });
  });

  describe('renderRoot of a session the entry read', () => {
    it('reads no cookie, and asks the authority for that session', async () => {
      const root = await renderRoot({
        component: 'components/roster',
        elements: { ...ELEMENTS, session: sourceOf(null) },
        props: { teamId: 't1' },
        session: ALICE,
        update,
        view,
      });

      expect(hoisted.cookiesRead).toBe(0);
      expect(hoisted.client['render']).toHaveBeenCalledExactlyOnceWith(ALICE, {
        build: BUILD,
        component: 'components/roster',
        props: { teamId: 't1' },
      });
      expect(liveProps(root)).toMatchObject({ frame: FRAME, status: 'rendered' });
    });

    it('renders for no session where the entry read none, reading no cookie', async () => {
      const root = await renderRoot({
        component: 'components/roster',
        elements: ELEMENTS,
        props: {},
        session: null,
        update,
        view,
      });

      expect(hoisted.cookiesRead).toBe(0);
      expect(hoisted.client['render']).toHaveBeenCalledExactlyOnceWith(null, expect.anything());
      expect(liveProps(root)['session']).toBe('');
    });

    it('hands LiveRoot the expiry where it is given one, and none where not', async () => {
      const options = {
        component: 'components/roster',
        elements: ELEMENTS,
        props: {},
        session: ALICE,
        update,
        view,
      };

      expect(liveProps(await renderRoot({ ...options, expire }))['expire']).toBe(expire);
      expect(liveProps(await renderRoot(options))).not.toHaveProperty('expire');
    });

    it('reads the cookie first where it is given no session, as before', async () => {
      await renderRoot({
        component: 'components/roster',
        elements: ELEMENTS,
        props: {},
        update,
        view,
      });

      expect(hoisted.cookiesRead).toBe(1);
    });
  });

  describe('keptSessionOf, which a kept root’s entry asks inside its private cache', () => {
    it('answers an application’s own session before its expires', () => {
      expect(keptSessionOf(ALICE)).toBe(ALICE);
    });

    it.each([
      ['a demo session', 'demo-session'],
      ['no session', null],
    ])('answers none for %s', (_what, session) => {
      expect(keptSessionOf(session)).toBeNull();
    });

    it('answers an assertion before its expires, and none from its expires on', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(ALICE.expires - 1);

      expect(keptSessionOf(ALICE)).toBe(ALICE);

      vi.setSystemTime(ALICE.expires);

      expect(keptSessionOf(ALICE)).toBeNull();
    });
  });

  describe('the entry of a kept root, by the session its private cache answered', () => {
    it('keeps the root of the session it answered, the next request answered of the cache', async () => {
      const cached = standInCache();

      const first = await rosterEntry(cached);
      const second = await rosterEntry(cached);

      expect(second).toBe(first);
      expect(hoisted.client['render']).toHaveBeenCalledExactlyOnceWith(ALICE, {
        build: BUILD,
        component: 'components/roster',
        props: {},
      });
      expect(liveProps(first)).toMatchObject({
        expire,
        frame: FRAME,
        prefetchable: true,
        status: 'rendered',
      });
    });

    it('renders as it comes where it answered none, never through its kept function', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(ALICE.expires);
      const cached = standInCache();
      const keep = vi.fn<(session: AssertedSession) => void>();

      // The session source answers the same assertion past its end: the key would be the same.
      const first = await rosterEntry(cached, keep);
      const second = await rosterEntry(cached, keep);

      expect(keep).not.toHaveBeenCalled();
      expect(hoisted.client['render']).toHaveBeenCalledTimes(2);
      expect(second).not.toBe(first);
      expect(liveProps(first)).not.toHaveProperty('prefetchable');
    });

    it('keeps an assertion’s root before its expires, and serves none of it once it has', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const cached = standInCache();
      vi.setSystemTime(ALICE.expires - 1);

      const before = await rosterEntry(cached);
      const again = await rosterEntry(cached);

      expect(again).toBe(before);
      expect(hoisted.client['render']).toHaveBeenCalledTimes(1);

      vi.setSystemTime(ALICE.expires);
      const after = await rosterEntry(cached);

      expect(after).not.toBe(before);
      expect(hoisted.client['render']).toHaveBeenCalledTimes(2);
    });

    it.each([['forbidden'], ['unauthenticated']] as const)(
      'keeps a root the authority answered %s as any other render, one call to the authority',
      async (status) => {
        hoisted.client['render']?.mockResolvedValue(answeredAs(status));
        const cached = standInCache();

        const first = await rosterEntry(cached);
        const second = await rosterEntry(cached);

        // Kept as any render is: the application expires it where it grants the access
        // (`expireKeptRootsOfUser`), as where it takes it away.
        expect(second).toBe(first);
        expect(hoisted.client['render']).toHaveBeenCalledTimes(1);
        expect(liveProps(first)).toMatchObject({ expire, frame: FRAME, status });
        expect(liveProps(first)['children']).toBeNull();
      },
    );

    it('throws the authority’s refusal on, keeping none of it, as before', async () => {
      hoisted.client['render']?.mockResolvedValue(refusal(503, 'AUTHORITY_UNAVAILABLE', 'Down.'));
      const cached = standInCache();

      const thrown = await rejection(rosterEntry(cached));
      const again = await rejection(rosterEntry(cached));

      expect(authorityRefusal(thrown)).toStrictEqual({
        code: 'AUTHORITY_UNAVAILABLE',
        status: 503,
      });
      expect(authorityRefusal(again)).toStrictEqual(authorityRefusal(thrown));
      expect(hoisted.client['render']).toHaveBeenCalledTimes(2);
    });
  });

  describe('operate, of a build that keeps its roots', () => {
    it('expires the session’s kept roots at once before the route renders again', async () => {
      const answer = await operate('actions/team', 'leave', [], {
        build: BUILD,
        kept: true,
        session: sourceOf(ALICE),
      });

      expect(answer).toBe('done');
      // A window of none, and never `updateTag`, whose tag would let go of every prefetched page;
      // and in this order: the `refresh()` after it is what has the answer say the dynamic alone.
      expect(hoisted.calls).toStrictEqual([
        `revalidateTag ${await keptRootTag(ALICE)} {"expire":0}`,
        'refresh',
      ]);
    });

    it('expires nothing of a build that keeps none: neither revalidateTag nor updateTag', async () => {
      await operate('actions/team', 'leave', [], { build: BUILD, session: sourceOf(ALICE) });

      expect(hoisted.calls).toStrictEqual(['refresh']);
    });

    it('expires nothing of an operation the authority refused', async () => {
      hoisted.client['operate']?.mockResolvedValue(refusal(403, 'FORBIDDEN', 'Not yours.'));

      await expect(
        operate('actions/team', 'leave', [], {
          build: BUILD,
          kept: true,
          session: sourceOf(ALICE),
        }),
      ).rejects.toThrow('was refused');

      expect(hoisted.calls).toStrictEqual([]);
    });

    it('expires nothing for a request of no session', async () => {
      await operate('actions/team', 'leave', [], {
        build: BUILD,
        kept: true,
        session: sourceOf(null),
      });

      expect(hoisted.calls).toStrictEqual(['refresh']);
    });

    it('answers all the same where nothing can be expired outside a Server Action', async () => {
      hoisted.context = 'render';

      const answer = await operate('actions/team', 'leave', [], {
        build: BUILD,
        kept: true,
        session: sourceOf(ALICE),
      });

      expect(answer).toBe('done');
      expect(hoisted.calls).toStrictEqual(['refresh']);
    });

    it('expires them before the application applies the session change the operation asked for', async () => {
      hoisted.client['operate']?.mockResolvedValue(operatedWithChange());

      await operate('actions/team', 'join', [], {
        build: BUILD,
        kept: true,
        session: sourceOf(ALICE),
        sessionChange: () => {
          hoisted.calls.push('apply');
        },
      });

      expect(hoisted.calls).toStrictEqual([
        `revalidateTag ${await keptRootTag(ALICE)} {"expire":0}`,
        'apply',
        'refresh',
      ]);
    });

    it('expires them of an operation that ran, though the applier threw', async () => {
      hoisted.client['operate']?.mockResolvedValue(operatedWithChange());
      const logged = vi.spyOn(console, 'error').mockImplementation(noop);

      await expect(
        operate('actions/team', 'join', [], {
          build: BUILD,
          kept: true,
          session: sourceOf(ALICE),
          sessionChange: () => {
            throw new Error('The team could not be set.');
          },
        }),
      ).rejects.toThrow('The team could not be set.');

      // The operation committed: what was kept of the session before it is stale, and no
      // `refresh()` follows, as the applier's error is the Server Action's.
      expect(hoisted.calls).toStrictEqual([
        `revalidateTag ${await keptRootTag(ALICE)} {"expire":0}`,
      ]);
      expect(logged).toHaveBeenCalledTimes(1);

      logged.mockRestore();
    });

    it('expires them of an operation that ran, though the applier redirected', async () => {
      hoisted.client['operate']?.mockResolvedValue(operatedWithChange());

      const thrown = await rejection(
        operate('actions/team', 'join', [], {
          build: BUILD,
          kept: true,
          session: sourceOf(ALICE),
          sessionChange: () => {
            redirect('/teams/t2');
          },
        }),
      );

      expect(isRedirectError(thrown)).toBe(true);

      // The redirect's target is rendered in the same answer, told of the tags expired so far.
      expect(hoisted.calls).toStrictEqual([
        `revalidateTag ${await keptRootTag(ALICE)} {"expire":0}`,
      ]);
    });

    it.each([
      ['an authority that could not be reached', refusal(503, 'AUTHORITY_UNAVAILABLE', 'Down.')],
      ['a fault after the commit', refusal(500, 'OPERATION_FAILED', 'Committed, then threw.')],
    ])(
      'expires nothing of an unknown outcome, though it may have run: %s',
      async (_what, failure) => {
        vi.useFakeTimers();
        hoisted.client['operate']?.mockResolvedValue(failure);

        const running = operate('actions/team', 'join', [], {
          build: BUILD,
          kept: true,
          session: sourceOf(ALICE),
        });
        await Promise.all([expect(running).rejects.toThrow('is unknown'), vi.runAllTimersAsync()]);

        // An expiry would have the error's answer render the route of the authority that just failed.
        expect(hoisted.calls).toStrictEqual([]);
      },
    );
  });

  describe('expireKeptRoots', () => {
    it('expires the kept roots of the request’s session, the prefetched pages with them', async () => {
      await expireKeptRoots(sourceOf(ALICE));

      expect(hoisted.calls).toStrictEqual([`updateTag ${await keptRootTag(ALICE)}`]);
    });

    it('does nothing for a request of no session', async () => {
      await expireKeptRoots(sourceOf(null));

      expect(hoisted.calls).toStrictEqual([]);
    });

    it('does nothing of the demo’s sessions, of which nothing is kept', async () => {
      hoisted.cookie = 'demo-session';

      await expireKeptRoots();

      expect(hoisted.calls).toStrictEqual([]);
    });

    it('throws where updateTag does: outside a Server Action', async () => {
      hoisted.context = 'route';

      await expect(expireKeptRoots(sourceOf(ALICE))).rejects.toThrow('within a Server Action');
    });
  });

  describe('expireKeptRootsOfUser', () => {
    it('expires at once what every session of the user keeps, by the user’s tag', async () => {
      await expireKeptRootsOfUser(ALICE.user);

      expect(hoisted.calls).toStrictEqual([
        `revalidateTag ${await keptUserTag(ALICE.user)} {"expire":0}`,
      ]);
    });

    it('expires them from a route handler too, where updateTag throws', async () => {
      hoisted.context = 'route';

      await expireKeptRootsOfUser(ALICE.user);

      expect(hoisted.calls).toStrictEqual([
        `revalidateTag ${await keptUserTag(ALICE.user)} {"expire":0}`,
      ]);
    });

    it('reads no session: the reader is the user it is given, not the request’s', async () => {
      hoisted.cookie = 'demo-session';

      await expireKeptRootsOfUser('bob');

      expect(hoisted.cookiesRead).toBe(0);
      expect(hoisted.calls).toStrictEqual([
        `revalidateTag ${await keptUserTag('bob')} {"expire":0}`,
      ]);
    });

    it('throws where revalidateTag does: during a render', async () => {
      hoisted.context = 'render';

      await expect(expireKeptRootsOfUser(ALICE.user)).rejects.toThrow('during render');
    });
  });
});
