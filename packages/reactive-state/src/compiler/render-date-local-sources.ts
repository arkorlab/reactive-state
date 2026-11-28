import {
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isCallExpression,
  isElementAccessExpression,
  isFunctionLikeDeclaration,
  isIdentifier,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { isImportBinding } from './exported-values.ts';
import { frameBindingOf, frameDeclarationOf } from './framed-bindings.ts';
import { framedQuietPrimitive, framedQuietSource } from './framed-native-evaluation.ts';
import { framedPrefixSameOwner } from './framed-native-prefix.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { bindingIdentifiers, hoistedIn, isBlockScoped } from './scope.ts';
import { writtenBy } from './written.ts';

/**
 * What the native Date text readers (`render-date-conversions.ts`) read of a value's source: a
 * local mutable operand's earlier possible initializer, the execution owner a value shares with its
 * consumer, and whether a value is one the compile cannot read at all.
 */

/** A whole local mutable operand retains its earlier possible initializer under the existing prefix proof. */
export function conversionLocalSource(
  expression: Expression,
  consumer: Expression,
): Expression | undefined {
  const target = unwrapped(expression);
  if (!isIdentifier(target)) return undefined;
  const selected = frameBindingOf(target);
  if (selected === undefined || selected.keys.length > 0) return undefined;
  const { binding } = selected;
  if (
    !isVariableDeclaration(binding) ||
    !isIdentifier(binding.name) ||
    !isVariableDeclarationList(binding.parent) ||
    binding.initializer === undefined ||
    binding.end >= consumer.pos ||
    !framedPrefixSameOwner(binding, consumer) ||
    !/^(?:let|var)\b/u.test(binding.parent.getText(binding.getSourceFile()))
  )
    return undefined;
  return isBlockScoped(binding.parent) || singleAssignmentVar(binding, consumer)
    ? binding.initializer
    : undefined;
}

/** Only this native Date text owner opts into guarded local array initializer ownership. */
export function dateCoowned(value: Expression, consumer: Expression): boolean {
  return framedOriginCoowned(value, consumer, localArrayInitializer);
}

/**
 * Whether a value is one of unknown provenance, which may be any value, a Date among them: rooted —
 * past the members read off it and the callees it calls — at a parameter, a name a parameter's
 * pattern takes apart, or an import. What the module's own code gives a name is the readers' to
 * read, as is a primitive written there.
 */
export function unknownValue(value: Expression): boolean {
  if (framedQuietPrimitive(value)) return false;
  let root = framedQuietSource(value) ?? unwrapped(value);
  while (
    isPropertyAccessExpression(root) ||
    isElementAccessExpression(root) ||
    isCallExpression(root)
  )
    root = unwrapped(root.expression);
  if (!isIdentifier(root)) return false;
  const selected = frameBindingOf(root);
  if (selected === undefined)
    return frameDeclarationOf(root) === undefined && isImportBinding(root);
  return isParameterDeclaration(selected.binding);
}

/**
 * Whether an argument is one the compile cannot read: of unknown provenance (`unknownValue`), or
 * carried across an execution owner (`dateCoowned`), where other code may change what it holds.
 */
export function unreadArgument(value: Expression, read: Expression): boolean {
  return !framedQuietPrimitive(value) && (!dateCoowned(value, read) || unknownValue(value));
}

/**
 * Whether evaluating a value writes, as the code shows it there — an assignment, a count, a
 * deletion (`writtenBy`) — which may rewrite what a conversion reads after it; a function the value
 * only makes runs none of its body.
 */
export function writesWhenEvaluated(value: Expression): boolean {
  const pending: Node[] = [value];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isFunctionLikeDeclaration(node)) continue;
    if (writtenBy(node) !== undefined) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** The original initializer is rechecked by the existing ownership walk, including const aliases. */
function localArrayInitializer(name: Identifier, consumer: Expression): Expression | undefined {
  const read = name.pos < consumer.pos ? name : consumer;
  const source = conversionLocalSource(name, read);
  const array = source === undefined ? undefined : framedQuietSource(source);
  return array !== undefined && isArrayLiteralExpression(array) ? source : undefined;
}

/** Another hoisted declaration of a var may replace its value without an assignment expression. */
function singleAssignmentVar(binding: VariableDeclaration, consumer: Expression): boolean {
  if (!isIdentifier(binding.name)) return false;
  const name = binding.name.text;
  let region: Node = binding;
  while (framedPrefixSameOwner(region.parent, consumer)) region = region.parent;
  return hoistedIn([region]).every(
    (other) =>
      other === binding || bindingIdentifiers(other.name).every((bound) => bound.text !== name),
  );
}
