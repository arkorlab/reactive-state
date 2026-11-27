import type { Json } from '../program.ts';
import { preparation } from './context.ts';

/**
 * What the application's own server prepared for a server operation (`prepareOperation`): the
 * authority makes no call of its own to anything outside it, and holds none of the application's
 * context — a token its server alone has — so the server looks up what the operation needs, and
 * sends only the result with the call. The authority keeps none of it.
 */

/**
 * The JSON the application's `prepareOperation` hook answered for the operation under way, or
 * `undefined` where it answered none or no hook is named. Read by a server operation alone
 * (`TypeError` wherever else the authority runs the application's code: a render, a route
 * middleware, a shared view, or outside any evaluation). The hook runs on the application's server,
 * for the application's own call: a value of it is as private as the application makes it, and what
 * the operation returns or throws is kept as any result is.
 */
export function prepared(): Json | undefined {
  const read = preparation();
  if (read === undefined) {
    throw new TypeError(
      'prepared() is called by a server operation alone: not by a render, a route middleware or a shared view.',
    );
  }
  if (read === 'settled') {
    throw new TypeError(
      'prepared() was read after the server operation that started it had settled: its preparation belongs to that call alone, and code that outlives it is not handed it.',
    );
  }
  return read();
}
