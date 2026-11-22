import {
  type Expression,
  isFunctionDeclaration,
  isFunctionLikeDeclaration,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isReturnStatement,
  type Node,
} from 'typescript/ast';

import { unwrapped } from '../../src/compiler/bounded.ts';
import { writtenArrayKey } from '../../src/compiler/framed-array-functions.ts';
import { framedHeldMember } from '../../src/compiler/framed-held-members.ts';

/**
 * Whether the member a function of the source returns may be its `error` parameter, as the walks of
 * held members follow it. The function is the one named, and its own first `return` is the read:
 * not a `return` of a function written inside it (a getter, a callback) or of another function of the
 * source, whichever the walk meets last.
 */
export function readSelectsError(root: Node, name = 'frames'): boolean {
  const target = functionNamed(root, name);
  if (target === undefined) throw new Error(`the source has no function ${name}`);
  const read = firstReturn(target);
  if (read === undefined) throw new Error(`the function ${name} returns nothing`);
  return framedHeldMember(read, [], isErrorAt);
}

/** The function declared with a name, wherever it stands. */
function functionNamed(root: Node, name: string): Node | undefined {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isFunctionDeclaration(node) && node.name?.text === name) return node;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return undefined;
}

/** What the first `return` of a function's own body gives, in source order. */
function firstReturn(declaration: Node): Expression | undefined {
  const pending: Node[] = [];
  declaration.forEachChild((child) => {
    pending.unshift(child);
  });
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isReturnStatement(node)) return node.expression;
    if (isFunctionLikeDeclaration(node)) continue;
    const children: Node[] = [];
    node.forEachChild((child) => {
      children.push(child);
    });
    pending.push(...children.toReversed());
  }
  return undefined;
}

/** The `error` parameter, selected from a literal by its keys or from a variable that holds it. */
function isErrorAt(value: Expression, keys: readonly string[]): boolean {
  const each = unwrapped(value);
  const [key, ...rest] = keys;
  if (key === undefined) return isIdentifier(each) && each.text === 'error';
  if (isIdentifier(each)) return framedHeldMember(each, keys, isErrorAt);
  if (!isObjectLiteralExpression(each)) return false;
  return each.properties.some((property) => {
    return (
      isPropertyAssignment(property) &&
      writtenArrayKey(property.name) === key &&
      isErrorAt(property.initializer, rest)
    );
  });
}
