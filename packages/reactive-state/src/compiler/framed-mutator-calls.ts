import { type CallExpression, type Expression, isSpreadElement } from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { framedAppliedArguments } from './framed-keys.ts';

/** The native object mutators, and the arguments a call of one hands them, borrowed or not. */

export const PATHS = {
  assign: 'Object.assign',
  properties: 'Object.defineProperties',
  property: 'Object.defineProperty',
} as const;

const MUTATORS: ReadonlySet<string> = new Set(Object.values(PATHS));

/** A native object mutator and the arguments it runs with, after its target. */
export interface MutatorInvocation {
  readonly path: string;
  readonly args: readonly Expression[];
}

/**
 * The mutator a call runs, directly or through `.call`, `.apply` or `Reflect.apply`, with the
 * arguments it receives; none for a call of something else, or one whose arguments are unread.
 */
export function mutatorInvocation(call: CallExpression): MutatorInvocation | undefined {
  const path = globalPathOf(unwrapped(call.expression))?.join('.');
  if (path === undefined) return undefined;
  if (MUTATORS.has(path)) return { path, args: writtenArguments(call) };
  if (path === 'Reflect.apply') {
    const [callee, , list] = call.arguments;
    const native = callee === undefined ? undefined : globalPathOf(unwrapped(callee))?.join('.');
    return native !== undefined && MUTATORS.has(native) ? applied(call, native, list) : undefined;
  }
  const split = path.lastIndexOf('.');
  const native = path.slice(0, split);
  if (!MUTATORS.has(native)) return undefined;
  const how = path.slice(split + 1);
  if (how === 'apply') return applied(call, native, call.arguments[1]);
  if (how !== 'call') return undefined;
  const [receiver, ...rest] = writtenArguments(call);
  return receiver === undefined || isSpreadElement(receiver)
    ? undefined
    : { path: native, args: rest };
}

/** A mutator called with the entries of a written list. */
function applied(
  call: CallExpression,
  path: string,
  list: Expression | undefined,
): MutatorInvocation | undefined {
  const listed = list === undefined ? undefined : framedAppliedArguments(call, list);
  return listed === undefined ? undefined : { path, args: writtenArguments(call, listed) };
}

/**
 * The call's arguments in order, each spread of a written list, or of a constant list nothing
 * changes, replaced by the entries it stands for; a spread the compile cannot read stays one. A
 * list is expanded each time it is spread, but never within itself.
 */
export function writtenArguments(
  call: CallExpression,
  given: readonly Expression[] = call.arguments,
): readonly Expression[] {
  type Listed = readonly (readonly Expression[])[];
  const written: Expression[] = [];
  const pending = given.toReversed().map((node) => ({ node, within: [] as Listed }));
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    const listed = isSpreadElement(each.node)
      ? framedAppliedArguments(call, each.node.expression)
      : undefined;
    if (listed === undefined || each.within.includes(listed)) written.push(each.node);
    else {
      const within = [...each.within, listed];
      for (const node of listed.toReversed()) pending.push({ node, within });
    }
  }
  return written;
}
