import type { Json } from '../program.ts';
import { toJson } from '../runtime/json.ts';
import { sessionChanger } from './context.ts';

/**
 * A server operation's request that the application's own session change (`sessionChange`): the
 * authority holds no session or cookie of the application's, so it keeps the change with the
 * operation's answer, and the application's server applies it as the answer reaches it.
 */

/** The largest change, in bytes of its JSON text in UTF-8. */
const MAX_CHANGE_BYTES = 4096;

/**
 * Asks that the application's session change by `change`, which the application's `sessionChange`
 * applier is handed once the operation has succeeded and before its page renders again. JSON of
 * 4 KiB at most (`TypeError` otherwise), asked once by an operation's run (`TypeError` for a second
 * call), and only by a server operation (`TypeError` wherever else the authority runs the
 * application's code). An operation that refuses, throws or faults carries no change.
 */
export function changeSession(change: unknown): void {
  const take = sessionChanger();
  if (take === undefined) {
    throw new TypeError(
      'changeSession(change) is called by a server operation alone: not by a render, a route middleware or a shared view.',
    );
  }
  // A value of the change writes a byte of its text at least: more values than bytes is too large.
  const json: Json = toJson(change, 'changeSession(change): the change', MAX_CHANGE_BYTES);
  const bytes = new TextEncoder().encode(JSON.stringify(json)).byteLength;
  if (bytes > MAX_CHANGE_BYTES) {
    throw new TypeError(
      `changeSession(change): the change is ${String(bytes)} bytes of JSON, ${String(MAX_CHANGE_BYTES)} at most.`,
    );
  }
  take(json);
}
