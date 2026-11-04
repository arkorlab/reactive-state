import {
  type ArrayLiteralExpression,
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isCallExpression,
  isFunctionExpression,
  isExpressionStatement,
  isIdentifier,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { unreferencedLocalFunction } from './framed-function-references.ts';
import { framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** Blob iterates its root parts array rather than calling that array's own text method. */

const DESCRIPTOR_ARGUMENTS = 3;

/** A root sequence may retain a quiet own toString decoration without exposing its entries. */
export function framedBlobSequence(
  expression: Expression,
  call: CallExpression,
  original: (value: Expression) => Expression | undefined,
): ArrayLiteralExpression | undefined {
  const value = unwrapped(original(expression) ?? expression);
  if (isArrayLiteralExpression(value)) return value;
  const source = sequenceAlias(expression);
  return source !== undefined && quietSequenceUses(expression, call, source.bindings)
    ? source.array
    : undefined;
}

/** Only whole constant aliases of a finite written array establish its original sequence. */
function sequenceAlias(
  expression: Expression,
):
  | { readonly array: ArrayLiteralExpression; readonly bindings: ReadonlySet<FrameBinding> }
  | undefined {
  let value = unwrapped(expression);
  const bindings = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0 || bindings.has(selected.binding))
      return undefined;
    const { binding } = selected;
    if (
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return undefined;
    bindings.add(binding);
    value = unwrapped(binding.initializer);
  }
  return isArrayLiteralExpression(value) ? { array: value, bindings } : undefined;
}

/** Other possible reads, element writes, iterator replacements and captures keep the sequence opaque. */
function quietSequenceUses(
  expression: Expression,
  call: CallExpression,
  bindings: ReadonlySet<FrameBinding>,
): boolean {
  const pending: Node[] = [expression.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (
      isIdentifier(node) &&
      readsBinding(node) &&
      !quietSequenceUse(node, expression, call, bindings)
    )
      return false;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** The selected read, alias wiring and a native own text definition cannot change sequence iteration. */
function quietSequenceUse(
  name: Identifier,
  expression: Expression,
  call: CallExpression,
  bindings: ReadonlySet<FrameBinding>,
): boolean {
  const selected = frameBindingOf(name);
  if (
    selected === undefined ||
    name === selected.binding.name ||
    !bindings.has(selected.binding) ||
    name === unwrapped(expression)
  )
    return true;
  const owner = executionOwner(call);
  const writer = executionOwner(name);
  if (
    writer === owner &&
    (name.pos >= call.pos || destructuredFirst(call, name)) &&
    !repeatedFrameRead(name, call, selected.binding, owner)
  )
    return true;
  if (writer !== owner && unreferencedLocalFunction(writer, owner)) return true;
  if (!framedPossibleBranch(name)) return true;
  const { parent } = name;
  return (
    (isVariableDeclaration(parent) && parent.initializer === name && bindings.has(parent)) ||
    ownSequenceText(name)
  );
}

/** This exact native descriptor installs a function without calling it or altering indexed entries. */
function ownSequenceText(name: Identifier): boolean {
  const call = name.parent;
  if (
    !isCallExpression(call) ||
    !isExpressionStatement(call.parent) ||
    globalPathOf(call.expression)?.join('.') !== 'Object.defineProperty' ||
    call.arguments.length !== DESCRIPTOR_ARGUMENTS ||
    call.arguments[0] !== name
  )
    return false;
  const [, key, descriptor] = call.arguments;
  if (
    descriptor === undefined ||
    key === undefined ||
    !isStringLiteral(key) ||
    key.text !== 'toString'
  )
    return false;
  return quietTextDescriptor(descriptor);
}

/** A fresh own-data function descriptor is installed without running its body. */
function quietTextDescriptor(descriptor: Expression): boolean {
  const value = unwrapped(descriptor);
  if (!isObjectLiteralExpression(value) || value.properties.length !== 1) return false;
  const property = value.properties[0];
  if (property === undefined || (!isMethodDeclaration(property) && !isPropertyAssignment(property)))
    return false;
  const field = property.name;
  if ((!isIdentifier(field) && !isStringLiteral(field)) || field.text !== 'value') return false;
  if (isMethodDeclaration(property)) return property.body !== undefined;
  const initializer = unwrapped(property.initializer);
  return isArrowFunction(initializer) || isFunctionExpression(initializer);
}
