import {
  type CallExpression,
  type Expression,
  type Identifier,
  type NewExpression,
  type Node,
  type VariableDeclaration,
  isBlock,
  isCallExpression,
  isIdentifier,
  isNewExpression,
  isSourceFile,
  isVariableDeclaration,
  isVariableStatement,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf, frameDeclarationOf } from './framed-bindings.ts';
import { storedIntlReceiver } from './render-intl-projections.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** Fresh native formatter evidence retains the original read's exposure boundary. */

/** Whole aliases share the read's owner and block, without earlier or captured non-wiring use. */
export function freshIntlReceiver(
  expression: Expression,
  read: Node,
): CallExpression | NewExpression | undefined {
  const stored = storedIntlReceiver(expression, read);
  if (stored !== undefined) return stored;
  const allowed = new Set<Node>();
  const bindings = new Set<Node>();
  const block = readBlock(read);
  let value = unwrapped(expression);
  while (isIdentifier(value)) {
    if (allowed.has(value)) return undefined;
    allowed.add(value);
    const binding = wholeIntlConstant(value);
    if (binding?.initializer === undefined || bindings.has(binding)) return undefined;
    if (binding.parent.parent.parent !== block || executionOwner(binding) !== executionOwner(read))
      return undefined;
    bindings.add(binding);
    allowed.add(binding.name);
    value = unwrapped(binding.initializer);
  }
  if (!isNewExpression(value) && !isCallExpression(value)) return undefined;
  return unexposedReceiver(read, bindings, allowed) ? value : undefined;
}

/** A prior replacement, descriptor, handoff or captured use leaves this added proof opaque. */
function unexposedReceiver(
  read: Node,
  bindings: ReadonlySet<Node>,
  allowed: ReadonlySet<Node>,
): boolean {
  if (bindings.size === 0) return true;
  const owner = executionOwner(read);
  const pending: Node[] = [read.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isIdentifier(node) && !allowed.has(node) && readsBinding(node)) {
      const binding = frameDeclarationOf(node);
      if (
        binding !== undefined &&
        bindings.has(binding) &&
        (node.pos < read.pos || executionOwner(node) !== owner)
      )
        return false;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** The nearest ordinary block retains the read's original lexical position. */
function readBlock(read: Node): Node {
  let node = read;
  while (!isBlock(node) && !isSourceFile(node)) node = node.parent;
  return node;
}

/** Only a whole written constant retains a receiver or literal key's original source. */
export function wholeIntlConstant(name: Identifier): VariableDeclaration | undefined {
  const selected = frameBindingOf(name);
  if (selected === undefined || selected.keys.length > 0) return undefined;
  const { binding } = selected;
  if (!isVariableDeclaration(binding) || !isIdentifier(binding.name)) return undefined;
  const statement = binding.parent.parent;
  return isVariableStatement(statement) &&
    /^const\s/u.test(statement.declarationList.getText(statement.getSourceFile()))
    ? binding
    : undefined;
}
