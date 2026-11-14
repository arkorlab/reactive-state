import {
  type Expression,
  isArrowFunction,
  isBlock,
  isBindingElement,
  isGetAccessorDeclaration,
  isSetAccessorDeclaration,
  isPropertyAssignment,
  type Identifier,
  isCallExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isObjectBindingPattern,
  isPropertyAccessExpression,
  isReturnStatement,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { argumentArrayExposed } from './framed-array-selections.ts';
import { frameBindingOf, frameMemberName } from './framed-bindings.ts';
import { framedQuietPrimitive } from './framed-native-evaluation.ts';
import { framedProxyDescriptorValues } from './framed-proxy-descriptors.ts';

/** An adjacent sole descriptor-value binding retains its native converted getter without effects. */

/** Only a first sole const binding followed by a direct member return adds a carried value. */
export function framedProxyDescriptorBinding(node: Expression): readonly Expression[] | undefined {
  if (!isIdentifier(node)) return undefined;
  const selected = frameBindingOf(node);
  if (selected?.keys.at(-1) !== 'value') return undefined;
  const { binding, keys } = selected;
  if (
    !isVariableDeclaration(binding) ||
    binding.initializer === undefined ||
    !isVariableDeclarationList(binding.parent)
  )
    return undefined;
  if (
    !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
    binding.parent.declarations.length !== 1
  )
    return undefined;
  if (!solePattern(binding.name) || !adjacentMemberReturn(binding.parent.parent, node))
    return undefined;
  if (argumentArrayExposed(node, new Set([binding]), nonBindingName)) return undefined;
  const call = unwrapped(binding.initializer);
  if (!isCallExpression(call)) return undefined;
  const path = globalPathOf(unwrapped(call.expression))?.join('.');
  const names = selectedNames(path, call.arguments[1], keys);
  if (names === undefined) return undefined;
  const target = call.arguments[0];
  return target === undefined
    ? undefined
    : framedProxyDescriptorValues(target, names, {
        consumer: node,
        observation: call,
        emptyBindingPrefix: true,
      });
}

/** Finite singular or plural binding paths select the same actual native observation. */
function selectedNames(
  path: string | undefined,
  key: Expression | undefined,
  keys: readonly string[],
): readonly string[] | undefined {
  if (path === 'Object.getOwnPropertyDescriptors')
    return keys.length === 2 ? keys.slice(0, 1) : undefined;
  if (!['Object.getOwnPropertyDescriptor', 'Reflect.getOwnPropertyDescriptor'].includes(path ?? ''))
    return undefined;
  if (key === undefined || keys.length !== 1 || !framedQuietPrimitive(key)) return undefined;
  const value = unwrapped(key);
  return 'text' in value && typeof value.text === 'string' ? [value.text] : undefined;
}

/** One closed object binding has no additional default, rest, getter selection or key effect. */
function solePattern(node: Node): boolean {
  let name = node;
  while (isObjectBindingPattern(name)) {
    if (name.elements.length !== 1) return false;
    const element = name.elements[0];
    if (
      element === undefined ||
      element.initializer !== undefined ||
      element.dotDotDotToken !== undefined ||
      element.name === undefined
    )
      return false;
    const key = element.propertyName;
    if (key !== undefined && isComputedPropertyName(key) && !framedQuietPrimitive(key.expression))
      return false;
    name = element.name;
  }
  return isIdentifier(name);
}

/** Empty prior owner work and a direct following read leave no prefix or intervening mutation. */
function adjacentMemberReturn(statement: Node, node: Expression): boolean {
  if (!isVariableStatement(statement) || !isBlock(statement.parent)) return false;
  const block = statement.parent;
  const [first, next] = block.statements;
  if (
    first !== statement ||
    next === undefined ||
    !isReturnStatement(next) ||
    next.expression === undefined
  )
    return false;
  const owner = block.parent;
  if (
    !isFunctionDeclaration(owner) &&
    !isFunctionExpression(owner) &&
    !isArrowFunction(owner) &&
    !isMethodDeclaration(owner)
  )
    return false;
  if (
    owner.parameters.some((parameter) => {
      return (
        !isIdentifier(parameter.name) ||
        parameter.initializer !== undefined ||
        parameter.dotDotDotToken !== undefined
      );
    })
  )
    return false;
  let value = unwrapped(next.expression);
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    if (
      frameMemberName(value) === undefined ||
      (isElementAccessExpression(value) && !framedQuietPrimitive(value.argumentExpression))
    )
      return false;
    value = unwrapped(value.expression);
  }
  return value === node;
}

/** Static member and binding names do not expose a same-spelled extracted value. */
function nonBindingName(name: Identifier): boolean {
  const { parent } = name;
  return (
    (isBindingElement(parent) ||
      isGetAccessorDeclaration(parent) ||
      isSetAccessorDeclaration(parent) ||
      isMethodDeclaration(parent) ||
      isPropertyAssignment(parent) ||
      isPropertyAccessExpression(parent)) &&
    parent.name === name
  );
}
