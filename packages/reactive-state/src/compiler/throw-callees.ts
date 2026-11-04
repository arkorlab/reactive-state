import {
  type Expression,
  isElementAccessExpression,
  isPropertyAccessExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { literalKey } from './exported-values.ts';
import { globalPath } from './global-answers.ts';
import type { Resolve } from './numbers.ts';
import { writtenOf } from './throw-shapes.ts';

/** The global object read through another name, whose members are globals themselves. */
const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(['globalThis', 'self', 'window']);

/**
 * The global a callee reads through constant aliases, including a namespace's or global object's
 * static members; none of a value the resolver cannot follow, or of a cycle between its members.
 */
export function globalCalleePath(
  node: Expression,
  resolve: Resolve | undefined,
): readonly string[] | undefined {
  const names: string[] = [];
  const seen = new Set<Expression>();
  let each = node;
  for (;;) {
    const value = writtenOf(each, resolve);
    if (seen.has(value)) {
      return undefined;
    }
    seen.add(value);
    const path = globalPath(value);
    if (path !== undefined) {
      return withoutGlobalObject([...path, ...names]);
    }
    if (isPropertyAccessExpression(value)) {
      names.unshift(value.name.text);
      each = value.expression;
    } else if (isElementAccessExpression(value)) {
      const key = literalKey(unwrapped(value.argumentExpression));
      if (key === undefined) {
        return undefined;
      }
      names.unshift(key);
      each = value.expression;
    } else {
      return undefined;
    }
  }
}

/** A global's path past the global object itself, including when an alias held that object. */
function withoutGlobalObject(path: string[]): readonly string[] {
  while (path.length > 1 && GLOBAL_OBJECTS.has(path[0] ?? '')) {
    path.shift();
  }
  return path;
}
