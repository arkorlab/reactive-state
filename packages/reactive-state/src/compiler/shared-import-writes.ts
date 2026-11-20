import {
  type Expression,
  type Identifier,
  isAsExpression,
  isCallExpression,
  isElementAccessExpression,
  isExpression,
  isNonNullExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isSourceFile,
  type Node,
} from 'typescript/ast';

import { namesNamespace, unwrapped } from './bounded.ts';
import { targetsOf } from './kept.ts';
import { writtenArgumentBy, writtenBy } from './written.ts';

/**
 * Whether `identifier`, an import of a shared module's, is written where it stands: itself or a
 * member of it written as `writtenBy` reads a write — assigned, counted, deleted, the target of a
 * loop of no declaration, or of a pattern one of those has for its target (`[defaults.value] =
 * rows`), changed in place by a method that changes what it is called on, or given first to a
 * function of a global's that changes what it is given. A cast, a parenthesis or a `!` around it, or
 * around a member of it, is the same value. Not one it is handed to a function of the application's,
 * or copies: what a function does with an argument is that function's, and a copy is the code's
 * own. Of a namespace import (`import * as math from …`, `namesNamespace`) the namespace itself is
 * no write of the module's: a call of one of its exports, `math.add(1, 2)`, `cookies.set(…)`, has
 * the namespace for its receiver and is no method of a collection, whatever its name; a member of
 * it, `math.items.push(x)`, `math.total = 1`, stays one.
 */
export function isWrittenAt(identifier: Identifier): boolean {
  const rooted = new Set<Node>();
  let node: Expression = identifier;
  for (;;) {
    rooted.add(node);
    const { parent } = node;
    if (
      !(
        isParenthesizedExpression(parent) ||
        isNonNullExpression(parent) ||
        isAsExpression(parent) ||
        isSatisfiesExpression(parent) ||
        ((isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
          parent.expression === node)
      )
    ) {
      break;
    }
    node = parent;
  }
  const namespace = namesNamespace(identifier);
  for (let each = node.parent; !isSourceFile(each); each = each.parent) {
    const found = writtenIn(each).some((target) => {
      return (
        rooted.has(target) &&
        !(namespace && isExpression(target) && unwrapped(target) === identifier)
      );
    });
    if (found) {
      return true;
    }
  }
  return false;
}

/**
 * What `node` writes into, each: what `writtenBy` names, of an assignment or a loop each target of
 * the pattern it writes (`targetsOf`); of a call its receiver or first argument as it is, no
 * pattern (`[...defaults.items].sort()` sorts the array it builds), and what `writtenArgumentBy`
 * names beside it — the event a dispatch is given, the buffers a structured clone's transfer list
 * detaches (`structuredClone(value, { transfer: [defaults.buffer] })`).
 */
function writtenIn(node: Node): readonly Node[] {
  const written = writtenBy(node);
  if (isCallExpression(node)) {
    return written === undefined ? writtenArgumentBy(node) : [written, ...writtenArgumentBy(node)];
  }
  return written === undefined ? [] : targetsOf(written);
}
