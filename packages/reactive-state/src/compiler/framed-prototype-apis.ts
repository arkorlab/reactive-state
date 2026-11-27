import { type CallExpression, type Expression, isExpression, type Node } from 'typescript/ast';

import { globalPathOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { unreferencedLocalFunction } from './framed-function-references.ts';
import { framedPossibleBranch, repeatedBodyRead } from './framed-writes.ts';
import { isTypeOnly } from './scope.ts';

/** Additional prototype origins retain opacity after native namespace replacement or exposure. */

const NAMESPACES = new Set(['Object', 'Reflect']);

/** Only the exact selected native API references are exempt from earlier namespace exposures. */
export function prototypeApisUnexposed(
  read: CallExpression,
  selected: readonly Expression[],
): boolean {
  const pending: Node[] = [read.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isExpression(node) && namespaceExposure(node, read, selected)) return false;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** Native namespace state is shared across iterations, while uncalled local functions add no use. */
function namespaceExposure(
  node: Expression,
  read: CallExpression,
  selected: readonly Expression[],
): boolean {
  if (!NAMESPACES.has(globalPathOf(node)?.join('.') ?? '')) return false;
  if (selected.some((value) => node.pos >= value.pos && node.end <= value.end)) return false;
  const owner = executionOwner(read);
  const other = executionOwner(node);
  if (other === owner) {
    if (
      (node.pos >= read.pos || destructuredFirst(read, node)) &&
      !repeatedBodyRead(node, read, read.getSourceFile(), owner)
    )
      return false;
  } else if (unreferencedLocalFunction(other, owner)) return false;
  return framedPossibleBranch(node);
}
