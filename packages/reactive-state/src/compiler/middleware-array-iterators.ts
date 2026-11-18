import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isElementAccessExpression,
  isExpression,
  isExpressionStatement,
  isIdentifier,
  isObjectLiteralExpression,
  isComputedPropertyName,
  isPropertyAssignment,
  isPropertyAccessExpression,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { answersLater } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { argumentArrayExposed } from './framed-array-selections.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { DEFAULT_ITERATOR, iteratorMemberName } from './framed-iterator-guards.ts';
import { framedQuietPrimitive } from './framed-native-evaluation.ts';
import { targetsOf } from './kept.ts';
import { middlewareArraySource } from './middleware-array-elements.ts';
import { isTypeOnly } from './scope.ts';
import { writtenBy } from './written.ts';

/** Native array iterator payloads add possible original identities, never a shared-input exemption. */

interface IteratorSource {
  readonly call: CallExpression;
  readonly aliases: ReadonlySet<FrameBinding>;
}

/** A next result's value may retain any original payload after an unproven iterator cursor. */
export function middlewareArrayIteratorOrigin(
  call: CallExpression,
  keys: readonly string[],
):
  | {
      readonly of: Expression;
      readonly keys: readonly string[];
      readonly tail: readonly string[];
      readonly whole?: boolean | undefined;
      readonly references: readonly Identifier[];
    }
  | undefined {
  const member = unwrapped(call.expression);
  if (
    keys[0] !== 'value' ||
    (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) ||
    frameMemberName(member) !== 'next'
  )
    return undefined;
  const source = iteratorSource(member.expression);
  if (source === undefined || freshOwnNext(call, source.aliases, member.expression))
    return undefined;
  const acquisition = unwrapped(source.call.expression);
  const consumed = iteratorMemberName(acquisition) === 'entries' ? 2 : 1;
  if (consumed === 2 && keys[1] !== '1') return undefined;
  const receiver = middlewareArrayIteratorCollection(source.call);
  return receiver === undefined
    ? undefined
    : { of: receiver, keys: [], tail: keys.slice(consumed), whole: true, references: [] };
}

/** Whole constant iterator aliases retain their acquisition without asserting a first cursor. */
function iteratorSource(expression: Expression): IteratorSource | undefined {
  let value = unwrapped(expression);
  const aliases = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    const binding = selected?.binding;
    if (
      binding === undefined ||
      selected?.keys.length !== 0 ||
      aliases.has(binding) ||
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return undefined;
    aliases.add(binding);
    value = unwrapped(binding.initializer);
  }
  return isCallExpression(value) ? { call: value, aliases } : undefined;
}

/** Only a definitely installed directly fresh own-next result is independent of the source payload. */
function freshOwnNext(
  call: CallExpression,
  aliases: ReadonlySet<FrameBinding>,
  receiver: Expression,
): boolean {
  let installed = false;
  const pending: Node[] = [call.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    const written = writtenBy(node);
    if (
      written !== undefined &&
      node.pos < call.expression.end &&
      targetsOf(written).some((target) => nextTarget(target, aliases))
    ) {
      if (!definitePriorWrite(node, call) || !independentNextResult(node)) return false;
      installed = true;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return (
    installed &&
    !argumentArrayExposed(receiver, aliases, (reference) => freshWriteRead(reference, call))
  );
}

/** Only the proved fresh installation and the actual callee read preserve this precision exception. */
function freshWriteRead(reference: Identifier, call: CallExpression): boolean {
  const member = useOf(reference).parent;
  if (
    (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) ||
    frameMemberName(member) !== 'next'
  )
    return false;
  const operation = useOf(member).parent;
  return definitePriorWrite(operation, call) && independentNextResult(operation);
}

/** An explicit own next member belongs to the acquired iterator aliases, never an opaque namespace. */
function nextTarget(node: Node, aliases: ReadonlySet<FrameBinding>): boolean {
  if (!isExpression(node)) return false;
  const value = unwrapped(node);
  if (
    (!isPropertyAccessExpression(value) && !isElementAccessExpression(value)) ||
    frameMemberName(value) !== 'next'
  )
    return false;
  const receiver = unwrapped(value.expression);
  if (isIdentifier(receiver)) {
    const binding = frameBindingOf(receiver)?.binding;
    if (binding !== undefined && aliases.has(binding)) return true;
  }
  return false;
}

/** A direct completed same-owner prefix statement proves an own method was installed at this read. */
function definitePriorWrite(node: Node, call: CallExpression): boolean {
  const statement = node.parent;
  return (
    node.end < call.pos &&
    isExpressionStatement(statement) &&
    isBlock(statement.parent) &&
    statement.parent.parent === executionOwner(call)
  );
}

/** Native values, entries and default iteration retain possible literal-array payloads. */
function middlewareArrayIteratorCollection(call: CallExpression): Expression | undefined {
  const member = unwrapped(call.expression);
  if (
    (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) ||
    ![DEFAULT_ITERATOR, 'entries', 'values'].includes(iteratorMemberName(member) ?? '')
  )
    return undefined;
  const source = middlewareArraySource(member.expression);
  return source !== undefined &&
    isArrayLiteralExpression(source) &&
    !source.elements.some((element) => isSpreadElement(element))
    ? member.expression
    : undefined;
}

/** A direct synchronous arrow returning only independent literal result data adds no original payload. */
function independentNextResult(node: Node): boolean {
  if (!isBinaryExpression(node) || node.operatorToken.kind !== SyntaxKind.EqualsToken) return false;
  const callable = unwrapped(node.right);
  if (
    !isArrowFunction(callable) ||
    callable.parameters.length > 0 ||
    answersLater(callable) ||
    isBlock(callable.body)
  )
    return false;
  const result = unwrapped(callable.body);
  if (!isObjectLiteralExpression(result) || !independentLiteral(result)) return false;
  for (const field of result.properties.toReversed()) {
    if (!isPropertyAssignment(field) || !isIdentifier(field.name)) return false;
    if (field.name.text === 'value') return independentLiteral(field.initializer);
  }
  return false;
}

/** Direct fresh arrays and own data objects contain no binding, accessor or application evaluation. */
function independentLiteral(expression: Expression): boolean {
  const value = unwrapped(expression);
  if (!isObjectLiteralExpression(value) && !isArrayLiteralExpression(value)) return false;
  const pending: Expression[] = [value];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const current = unwrapped(next);
    if (isIdentifier(current)) return false;
    if (framedQuietPrimitive(current)) continue;
    const values = directLiteralValues(current);
    if (values === undefined) return false;
    pending.push(...values);
  }
  return true;
}

/** Closed literal entries contain no spread, shorthand, accessor or computed-key evaluation. */
function directLiteralValues(value: Expression): readonly Expression[] | undefined {
  if (isArrayLiteralExpression(value))
    return value.elements.some((element) => isSpreadElement(element)) ? undefined : value.elements;
  if (!isObjectLiteralExpression(value)) return undefined;
  const values: Expression[] = [];
  for (const field of value.properties) {
    if (!isPropertyAssignment(field) || isComputedPropertyName(field.name)) return undefined;
    values.push(field.initializer);
  }
  return values;
}
