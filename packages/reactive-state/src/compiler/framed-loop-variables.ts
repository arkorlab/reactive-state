import { type ForOfStatement, isForOfStatement, isVariableDeclarationList } from 'typescript/ast';

import { type AssignedFrameSource, iteratedFrameSources } from './framed-assignment-patterns.ts';
import type { FrameBinding } from './framed-bindings.ts';
import { namesAcquiredType } from './framed-iterated-types.ts';

/**
 * What a variable a `for … of` header declares holds: the values the loop iterates, at the places
 * the iteration gives (`iteratedFrameSources`), as `let each; for (each of list)` takes them, each
 * with `keys`, the path the read goes on by, after its own. A parameter, and a declaration that is
 * no loop's header, take none.
 */
export function framedLoopSources(
  declared: FrameBinding,
  keys: readonly string[],
): readonly AssignedFrameSource[] {
  const loop = loopOf(declared);
  if (loop === undefined) return [];
  const sources = iteratedFrameSources(loop.expression);
  return sources.map((each) => ({ value: each.value, keys: [...each.keys, ...keys] }));
}

/**
 * Whether what a `for … of` over a native iterator of a collection written with a type yields, at the
 * `keys` a pattern of the header selects, may be one of `names` (`namesAcquiredType`):
 * `for (const each of input.values())`, `for (const [, each] of input.entries())`.
 */
export function framedLoopYields(
  declared: FrameBinding,
  keys: readonly string[],
  names: ReadonlySet<string>,
): boolean {
  const loop = loopOf(declared);
  return loop !== undefined && namesAcquiredType(loop.expression, keys, names);
}

/** The `for … of` whose header declares the variable, if there is one. */
function loopOf(declared: FrameBinding): ForOfStatement | undefined {
  const list = declared.parent;
  if (!isVariableDeclarationList(list)) return undefined;
  const loop = list.parent;
  return isForOfStatement(loop) && loop.initializer === list ? loop : undefined;
}
