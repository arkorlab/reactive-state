import { sharedRender } from './context.ts';

/**
 * What the application's code may read that no commit announces the change of — the clock, chance,
 * another service — watched while a render every visitor is to share runs: such a read makes the
 * render the request's (`Call.requestBound`), for the authority renders it for each request instead.
 * It answers as it always does; nothing is refused. The compile refuses the plain cases at build
 * time; this is what holds where a library reads one for the application.
 *
 * Each global is wrapped once per isolate, by its own key, and only notes a read inside a shared
 * render: any other code, the authority's own included, reads it as before.
 */

const INSTALLED = Symbol.for('arkorlab.reactive-state.untracked');

type Holder = Record<PropertyKey, unknown>;

/** Wraps `holder[name]`, a function, to note a read of `what` inside a shared render. */
function watch(holder: Holder | undefined, name: string, what: string): void {
  const original = holder?.[name];
  if (holder === undefined || typeof original !== 'function') {
    return;
  }
  function watched(this: unknown, ...args: unknown[]): unknown {
    sharedRender()?.boundToRequest(what);
    return Reflect.apply(original as (...given: unknown[]) => unknown, this, args);
  }
  Object.defineProperty(holder, name, { configurable: true, value: watched, writable: true });
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
  watch(shared['Date'] as Holder | undefined, 'now', 'Date.now()');
  watch(shared['Math'] as Holder | undefined, 'random', 'Math.random()');
  watch(crypto, 'randomUUID', 'crypto.randomUUID()');
  watch(crypto, 'getRandomValues', 'crypto.getRandomValues()');
  watch(shared['performance'] as Holder | undefined, 'now', 'performance.now()');
}
