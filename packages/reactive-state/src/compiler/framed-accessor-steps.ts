import {
  type BinaryExpression,
  type CallExpression,
  type Expression,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isElementAccessExpression,
  isExpressionStatement,
  isIdentifier,
  isObjectLiteralExpression,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isStringLiteral,
  type Node,
  type VariableDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import {
  framedAccessorDescriptor,
  framedAccessorFieldValue,
  framedAccessorName,
  framedAccessorQuietValue,
} from './framed-accessor-descriptors.ts';
import {
  framedAccessorAssign,
  framedAccessorDefine,
  framedAccessorTarget,
  type AccessorTarget,
} from './framed-accessor-targets.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedQuietPrimitive } from './framed-native-evaluation.ts';
import { framedQuietOwnerPrefix } from './framed-native-prefix.ts';

const DEFINITION_ARITY = 3;

/** Only complete unconditional definition and empty-setter operations precede a new accessor read. */
export function framedAccessorSteps(
  consumer: Expression,
  key: string,
  targets: Map<VariableDeclaration, AccessorTarget>,
): boolean {
  const statement = bodyStatement(consumer);
  if (statement === undefined || !isBlock(statement.parent)) return false;
  const calls = new Set<CallExpression>();
  const writes = new Set<BinaryExpression>();
  for (const before of statement.parent.statements) {
    if (before === statement) break;
    if (!isExpressionStatement(before)) continue;
    const value = unwrapped(before.expression);
    if (isCallExpression(value)) {
      if (applyDefinition(value, key, consumer, targets)) calls.add(value);
    } else if (isBinaryExpression(value) && applyAssignment(value, key, consumer, targets))
      writes.add(value);
  }
  return framedQuietOwnerPrefix(consumer, {
    primitive: (value) =>
      framedQuietPrimitive(value) || (isBinaryExpression(value) && writes.has(value)),
    value: (value) => [...writes].some((write) => unwrapped(write.left) === value),
    call: (call) => calls.has(call),
    construct: framedAccessorQuietValue,
  });
}

/** The new proof handles an immediate ordinary body statement, without conditional or repeated CFG inference. */
function bodyStatement(node: Node): Node | undefined {
  for (let at = node; ; at = at.parent) {
    const parent = at.parent;
    if (isBlock(parent)) return at;
    if (parent.kind === SyntaxKind.SourceFile || parent.kind === SyntaxKind.Constructor)
      return undefined;
  }
}

/** Native singular/plural definitions read every literal descriptor, and assign invokes each setter. */
function applyDefinition(
  call: CallExpression,
  key: string,
  consumer: Expression,
  targets: Map<VariableDeclaration, AccessorTarget>,
): boolean {
  const path = globalPathOf(unwrapped(call.expression))?.join('.');
  const [input, name, descriptor] = call.arguments;
  if (input === undefined || name === undefined) return false;
  const target = framedAccessorTarget(input, { key, consumer, targets });
  if (target === undefined) return false;
  if (path === 'Object.assign') return assigned(call, target, key);
  if (path === 'Object.defineProperties') return plural(call, target, key);
  return (
    (path === 'Object.defineProperty' || path === 'Reflect.defineProperty') &&
    call.arguments.length === DEFINITION_ARITY &&
    descriptor !== undefined &&
    framedQuietPrimitive(name) &&
    literalKey(name) === key &&
    installed(target, descriptor)
  );
}

/** Exact literal keys have no coercion or possible alternative target slot. */
function literalKey(node: Expression): string | undefined {
  const value = unwrapped(node);
  return isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value) ? value.text : undefined;
}

/** A single directly written descriptor controls the selected own slot. */
function installed(target: AccessorTarget, node: Expression): boolean {
  const descriptor = framedAccessorDescriptor(node);
  return descriptor !== undefined && framedAccessorDefine(target, descriptor);
}

/** Unselected descriptor attributes must also be plain quiet data before any definition is installed. */
function plural(call: CallExpression, target: AccessorTarget, key: string): boolean {
  const map = call.arguments[1];
  if (map === undefined || call.arguments.length !== 2) return false;
  const value = unwrapped(map);
  if (!isObjectLiteralExpression(value)) return false;
  let selected;
  for (const field of value.properties) {
    if (!isPropertyAssignment(field)) return false;
    const name = framedAccessorName(field.name);
    const descriptor = framedAccessorDescriptor(field.initializer);
    if (name === undefined || name === '__proto__' || descriptor === undefined) return false;
    if (name === key) selected = descriptor;
  }
  return selected === undefined || framedAccessorDefine(target, selected);
}

/** A closed own source containing only the selected key cannot invoke a separate unknown setter. */
function assigned(call: CallExpression, target: AccessorTarget, key: string): boolean {
  const sources = call.arguments.slice(1);
  if (sources.length === 0) return false;
  return sources.every((source) => assignSource(source, target, key));
}

/** All copied values have quiet own creation and no source getter or unrelated selected setter. */
function assignSource(input: Expression, target: AccessorTarget, key: string): boolean {
  const value = unwrapped(input);
  if (!isObjectLiteralExpression(value)) return false;
  for (const field of value.properties) {
    if (
      !isPropertyAssignment(field) &&
      !(isShorthandPropertyAssignment(field) && isIdentifier(field.name))
    )
      return false;
    const source = framedAccessorFieldValue(field);
    if (source === undefined) return false;
    if (framedAccessorName(field.name) !== key || !framedAccessorQuietValue(source)) return false;
    if (!framedAccessorAssign(target, source)) return false;
  }
  return true;
}

/** A plain selected member assignment evaluates a quiet RHS and invokes only a proved empty setter. */
function applyAssignment(
  node: BinaryExpression,
  key: string,
  consumer: Expression,
  targets: Map<VariableDeclaration, AccessorTarget>,
): boolean {
  if (node.operatorToken.kind !== SyntaxKind.EqualsToken || !framedAccessorQuietValue(node.right))
    return false;
  const left = unwrapped(node.left);
  if (
    (!isPropertyAccessExpression(left) && !isElementAccessExpression(left)) ||
    left.questionDotToken !== undefined ||
    frameMemberName(left) !== key ||
    (isElementAccessExpression(left) && !framedQuietPrimitive(left.argumentExpression))
  )
    return false;
  const target = framedAccessorTarget(left.expression, { key, consumer, targets });
  return target !== undefined && framedAccessorAssign(target, node.right);
}
