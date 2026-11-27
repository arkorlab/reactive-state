import 'next/dist/server/node-environment-extensions/date';
import { workAsyncStorage } from 'next/dist/server/app-render/work-async-storage.external';
import { workUnitAsyncStorage } from 'next/dist/server/app-render/work-unit-async-storage.external';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { AssertedSession } from '../src/asserted.ts';
import { keptSessionOf } from '../src/next/kept.ts';

/**
 * Where a kept root's entry reads the clock and its session, in Next.js's own stores: Next.js
 * 16.4.6's server installs a `Date` extension (`server/node-environment.js` →
 * `node-environment-extensions/date.js`) that reports a read of the current time outside any cache
 * as synchronous IO (`io-utils.js`), which aborts a runtime prerender — a link's runtime prefetch
 * (`prerender-runtime`) — and lets the prefetch carry no root. Inside a `'use cache: private'`
 * function, which runs in a work unit of its own (`private-cache`, `createUseCacheStore` in
 * `use-cache-wrapper.js`) and which a runtime prefetch includes, it reads freely; so does the
 * application's session source, whose I/O and clock the entry's private function reads.
 */

vi.hoisted(() => {
  // As Next.js's server sets it up before any of its modules loads (`node-environment-baseline`).
  const { AsyncLocalStorage } = process.getBuiltinModule('node:async_hooks');
  vi.stubGlobal('AsyncLocalStorage', AsyncLocalStorage);
});

const ALICE: AssertedSession = { expires: 4_000_000_000_000, id: 'key-alice', user: 'alice' };

interface Tracking {
  syncDynamicErrorWithStack: Error | null;
  syncDynamicErrorWithStackPostMicrotask: boolean;
  dynamicAccesses: unknown[];
  isDebugDynamicAccesses: boolean;
}

/** A runtime prerender's work unit, as `app-render.js` makes one for a link's runtime prefetch. */
interface Prerender {
  readonly controller: AbortController;
  readonly tracking: Tracking;
}

/** Runs `render` as a runtime prerender does, in Next.js's own stores. */
async function prerendered<T>(render: () => Promise<T>): Promise<Prerender & { answer: T }> {
  const controller = new AbortController();
  const tracking: Tracking = {
    dynamicAccesses: [],
    isDebugDynamicAccesses: false,
    syncDynamicErrorWithStack: null,
    syncDynamicErrorWithStackPostMicrotask: false,
  };
  const unit = {
    controller,
    dynamicTracking: tracking,
    phase: 'render',
    type: 'prerender-runtime',
  };
  const work = { route: '/teams/[team]/settings/members' };
  const answer = await workAsyncStorage.run(work as never, () =>
    workUnitAsyncStorage.run(unit as never, render),
  );
  return { answer, controller, tracking };
}

/** Runs `fill` in a cache's own work unit, as `'use cache: private'` or `remote` runs its function. */
async function inCache<T>(type: 'cache' | 'private-cache', fill: () => Promise<T>): Promise<T> {
  return workUnitAsyncStorage.run({ phase: 'render', type } as never, fill);
}

/** A session source of the application's: a lookup, and the clock. */
async function sessionSource(): Promise<AssertedSession | null> {
  await new Promise((resolve) => {
    setTimeout(resolve, 1);
  });
  return Date.now() < ALICE.expires ? ALICE : null;
}

/** The entry of a kept root as the compile writes it, its private and remote functions so run. */
async function entry(): Promise<string> {
  const session = await inCache('private-cache', async () => keptSessionOf(await sessionSource()));
  return session === null
    ? 'rendered as it comes'
    : inCache('cache', () => Promise.resolve(`kept for ${session.user}`));
}

describe('a kept root’s entry in a runtime prefetch, with Next.js’s clock', () => {
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('reads its session and the clock inside its private cache, the prefetch not aborted', async () => {
    const { answer, controller, tracking } = await prerendered(entry);

    expect(answer).toBe('kept for alice');
    expect(controller.signal.aborted).toBe(false);
    expect(tracking.syncDynamicErrorWithStack).toBeNull();
  });

  it('pin: the same read of the clock outside any cache aborts the prefetch', async () => {
    const { answer, controller, tracking } = await prerendered(() =>
      Promise.resolve(keptSessionOf(ALICE)),
    );

    expect(answer).toBe(ALICE);
    expect(controller.signal.aborted).toBe(true);
    expect(tracking.syncDynamicErrorWithStack?.message).toContain(
      'encountered the unstable value `Date.now()` while prerendering',
    );
  });
});
