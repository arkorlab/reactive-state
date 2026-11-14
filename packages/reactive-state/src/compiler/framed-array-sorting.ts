import {
  type CallExpression,
  type Expression,
  type Identifier,
  type Node,
  isArrayLiteralExpression,
  isIdentifier,
  isOmittedExpression,
  isSpreadElement,
  isVariableDeclaration,
  isParameterDeclaration,
  isVariableDeclarationList,
  isVoidExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { sourceArrayFunction } from './framed-array-functions.ts';
import { frameBindingOf, frameDeclarationOf, type FrameBinding } from './framed-bindings.ts';
import { framedConsumedArguments } from './framed-text-arguments.ts';
import { constantValue } from './numbers.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** A native default sort can convert elements only when a comparator may be absent and two defined values may compare. */
export function defaultArrayComparison(
  receiver: Expression,
  call: CallExpression,
  given: readonly Expression[],
  applied?: Expression,
): boolean {
  if (!mayDefaultCompare(call, given, applied)) return false;
  const literal = smallLiteral(receiver, call);
  return literal === undefined || literal > 1;
}

/** Unknown apply lists or spread prefixes may supply no comparator or native undefined. */
function mayDefaultCompare(
  call: CallExpression,
  given: readonly Expression[],
  applied: Expression | undefined,
): boolean {
  let args = given;
  if (applied !== undefined) {
    const value = unwrapped(applied);
    if (!isArrayLiteralExpression(value)) return true;
    args = value.elements;
  }
  const first = framedConsumedArguments(call, args, 1);
  return (
    first.length === 0 ||
    first.some((each) => {
      const value = unwrapped(each);
      if (isSpreadElement(value) || absentValue(value)) return true;
      if (sourceArrayFunction(value)) return false;
      return constantValue(value) === undefined;
    })
  );
}

/** A direct or unexposed constant literal may prove that fewer than two defined values exist. */
function smallLiteral(receiver: Expression, call: CallExpression): number | undefined {
  const origin = unwrapped(receiver);
  let value = origin;
  const aliases = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0 || aliases.has(selected.binding))
      return undefined;
    const binding = selected.binding;
    aliases.add(binding);
    if (
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\s/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return undefined;
    value = unwrapped(binding.initializer);
  }
  if (!isArrayLiteralExpression(value)) return undefined;
  if (value.elements.some((each) => isSpreadElement(each))) return undefined;
  const count = value.elements.filter((each) => !absentValue(each)).length;
  if (count > 1 || aliases.size === 0) return count;
  return isIdentifier(origin) && exposedArray(origin, aliases, call) ? undefined : count;
}

/** Any other value use removes the small-array proof, including possible later closure mutations. */
function exposedArray(
  receiver: Identifier,
  aliases: ReadonlySet<FrameBinding>,
  call: Node,
): boolean {
  const pending: Node[] = [call.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (node !== receiver && isIdentifier(node) && readsBinding(node)) {
      const binding = frameDeclarationOf(node);
      if (
        binding !== undefined &&
        node !== binding.name &&
        (isVariableDeclaration(binding) || isParameterDeclaration(binding)) &&
        aliases.has(binding)
      ) {
        const parent = node.parent;
        if (!isVariableDeclaration(parent) || parent.initializer !== node || !aliases.has(parent))
          return true;
      }
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Holes and explicit native undefined sort without comparing their text. */
function absentValue(node: Expression): boolean {
  return (
    isOmittedExpression(node) ||
    isVoidExpression(node) ||
    globalPathOf(unwrapped(node))?.join('.') === 'undefined'
  );
}
