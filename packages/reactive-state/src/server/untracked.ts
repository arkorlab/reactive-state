import { sharedRender } from './context.ts';

/**
 * What the application's code may read that no commit announces the change of — the clock, chance,
 * another service — watched while a render every visitor is to share runs: such a read makes the
 * render the request's (`Call.requestBound`), for the authority renders it for each request instead.
 * It answers as it always does; nothing is refused. The compile refuses the plain cases at build
 * time; this is what holds where a library reads one for the application.
 *
 * Each global is wrapped once per isolate, by its own key, and only notes a read inside a shared
 * render: any other code, the authority's own included, reads it as before. The framework's own
 * read of the clock inside one (`ownNow`), by which its client tells when to ask a database again,
 * is not noted.
 */

const INSTALLED = Symbol.for('arkorlab.reactive-state.untracked');
/**
 * Whether the framework reads the clock now (`ownNow`): of the isolate, as `INSTALLED` is, so that
 * the watch of one copy of this module sees the read of another — an application's bundle and the
 * authority's may each hold one.
 */
const OWN_READ = Symbol.for('arkorlab.reactive-state.own-clock');

type Holder = Record<PropertyKey, unknown>;

/**
 * Wraps `holder[name]`, a function, to note a read of `what` inside a shared render: of the clock
 * (`clock`), none the framework reads itself.
 */
function watch(holder: Holder | undefined, name: string, what: string, clock = false): void {
  const original = holder?.[name];
  if (holder === undefined || typeof original !== 'function') {
    return;
  }
  function watched(this: unknown, ...args: unknown[]): unknown {
    if (!clock || (globalThis as unknown as Holder)[OWN_READ] !== true) {
      sharedRender()?.boundToRequest(what);
    }
    return Reflect.apply(original as (...given: unknown[]) => unknown, this, args);
  }
  Object.defineProperty(holder, name, { configurable: true, value: watched, writable: true });
}

/**
 * The time, as `Date.now()` answers it — a test's spy of it too — read by the framework for its own
 * bookkeeping, which no render's answer holds: the watch does not note it. The call awaits nothing,
 * so no other render, promise or timer runs while it does. What runs within it is whatever stands
 * in `Date.now`'s place — the runtime's clock through the watch, a test's spy, or a clock an
 * application put there — and of that the watch of the clock alone is excused: whatever else such a
 * clock reads beside the time is noted as ever.
 */
export function ownNow(): number {
  const shared = globalThis as unknown as Holder;
  const outer = shared[OWN_READ];
  shared[OWN_READ] = true;
  try {
    return Date.now();
  } finally {
    shared[OWN_READ] = outer;
  }
}

/** Watches the reads of the request nothing tracks, once for the isolate. */
export function watchUntracked(): void {
  const shared = globalThis as unknown as Holder;
  if (shared[INSTALLED] === true) {
    return;
  }
  shared[INSTALLED] = true;
  const crypto = shared['crypto'] as Holder | undefined;
  watch(shared, 'fetch', 'fetch()');
  watch(shared['Date'] as Holder | undefined, 'now', 'Date.now()', true);
  watch(shared['Math'] as Holder | undefined, 'random', 'Math.random()');
  watch(crypto, 'randomUUID', 'crypto.randomUUID()');
  watch(crypto, 'getRandomValues', 'crypto.getRandomValues()');
  watch(shared['performance'] as Holder | undefined, 'now', 'performance.now()');
}
