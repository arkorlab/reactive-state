import {
  type ArrowFunction,
  type CallExpression,
  type Expression,
  type FunctionExpression,
  type Identifier,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isBindingElement,
  isBlock,
  isComputedPropertyName,
  isConditionalExpression,
  isElementAccessExpression,
  isExpressionStatement,
  isFunctionExpression,
  isIdentifier,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isVariableStatement,
  isVoidExpression,
  type Node,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { answersLater } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { frameMemberName } from './framed-bindings.ts';
import {
  immediateMember,
  immediateSelection,
  quietErrorConstruction,
} from './framed-copy-guards.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { framedOriginPrefix } from './framed-origin-prefix.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** A mapper's receiver, arguments, parameters and body that run no application code when evaluated. */

/** Native mappers a borrowed call names as its target, read without a getter. */
const NATIVE_MAPPERS = new Set([
  'Array.prototype.flatMap',
  'Array.prototype.map',
  'Array.prototype.reduce',
  'Array.prototype.reduceRight',
]);
const LOGICAL: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/** Names a mapper body may assign without leaving its quiet evaluation. */
type Writable = (name: Identifier) => boolean;

/**
 * Whether a synchronous mapper, its native call, receiver and arguments run no application code
 * before an immediate indexed member read of the call (a direct member read, where `direct`):
 * quiet literals, reads, callable creations and native Error constructions, quiet parameter
 * patterns and defaults, and a body of const declarations, quiet statements and writes of the
 * `writable` names, ending in a quiet return.
 */
export function quietMapperCall(
  parameter: ParameterDeclaration,
  capture: CallExpression,
  receiver: Expression,
  options: {
    readonly writable?: Writable;
    readonly direct?: boolean;
    readonly packedRest?: ParameterDeclaration;
  } = {},
): boolean {
  const fn = parameter.parent;
  const evaluated = framedArgumentPrefix(capture, capture.arguments, Infinity);
  return (
    !evaluated.unknown &&
    (isArrowFunction(fn) || isFunctionExpression(fn)) &&
    fn.parameters.length > 0 &&
    quietMapperFunction(fn, capture, receiver, { ...options, evaluated: evaluated.values })
  );
}

/** A source callback retains quiet evaluation after a caller proves the full original argument list. */
export function quietMapperFunction(
  fn: ArrowFunction | FunctionExpression,
  capture: CallExpression,
  receiver: Expression,
  options: {
    readonly evaluated: readonly Expression[];
    readonly writable?: Writable;
    readonly direct?: boolean;
    readonly read?: Expression;
    readonly packedRest?: ParameterDeclaration;
  },
): boolean {
  const writable = options.writable ?? (() => false);
  return (
    !answersLater(fn) &&
    (options.direct === true ? immediateMember(capture) : immediateSelection(capture)) &&
    framedOriginPrefix(capture) &&
    quietCallee(capture.expression) &&
    quietValues([receiver, ...options.evaluated], writable) &&
    quietBody(fn, writable, options.read, options.packedRest)
  );
}

/** Written member keys select the native method without a getter or a key conversion. */
function quietCallee(callee: Expression): boolean {
  let value = unwrapped(callee);
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    if (frameMemberName(value) === undefined) return false;
    value = unwrapped(value.expression);
  }
  return true;
}

/** Written literals, reads, callable creations and quiet native Error constructions only. */
function quietValues(
  values: readonly Expression[],
  writable: Writable,
  read?: Expression,
): boolean {
  const pending = [...values];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const value = unwrapped(next);
    if (value === read || quietAtom(value)) continue;
    const children = quietChildren(value, writable);
    if (children === undefined) return false;
    pending.push(...children);
  }
  return true;
}

/** Quiet parameter patterns and defaults, and a quiet body ending in a return. */
function quietBody(
  fn: ArrowFunction | FunctionExpression,
  writable: Writable,
  read?: Expression,
  packedRest?: ParameterDeclaration,
): boolean {
  const parameters = fn.parameters;
  if (parameters.some((each) => !quietPattern(each, writable, each === packedRest))) return false;
  const { body } = fn;
  if (!isBlock(body)) return quietValues([body], writable, read);
  const statements = body.statements;
  for (const [at, statement] of statements.entries()) {
    if (isReturnStatement(statement))
      return (
        at === statements.length - 1 &&
        (statement.expression === undefined || quietValues([statement.expression], writable, read))
      );
    if (!quietStatement(statement, writable, read)) return false;
  }
  return true;
}

/** A const declaration of plain names with quiet initializers, or a quiet expression statement. */
function quietStatement(statement: Node, writable: Writable, read?: Expression): boolean {
  if (isExpressionStatement(statement)) return quietValues([statement.expression], writable, read);
  return (
    isVariableStatement(statement) &&
    /^const\b/u.test(statement.declarationList.getText(statement.getSourceFile())) &&
    statement.declarationList.declarations.every((each) => {
      return (
        isIdentifier(each.name) &&
        each.initializer !== undefined &&
        quietValues([each.initializer], writable, read)
      );
    })
  );
}

/** Each bound name, written key and default of the first parameter evaluates quietly. */
function quietPattern(
  parameter: ParameterDeclaration,
  writable: Writable,
  packedRest = false,
): boolean {
  if (
    (!packedRest && parameter.dotDotDotToken !== undefined) ||
    (parameter.initializer !== undefined && !quietValues([parameter.initializer], writable))
  )
    return false;
  const pending: Node[] = [parameter.name];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (quietBindingAtom(node, packedRest)) continue;
    if (isObjectBindingPattern(node) || isArrayBindingPattern(node)) pending.push(...node.elements);
    else if (
      isBindingElement(node) &&
      node.dotDotDotToken === undefined &&
      node.name !== undefined &&
      (node.initializer === undefined || quietValues([node.initializer], writable)) &&
      (node.propertyName === undefined ||
        !isComputedPropertyName(node.propertyName) ||
        framedMapKey(node.propertyName.expression) !== undefined)
    )
      pending.push(node.name);
    else return false;
  }
  return true;
}

/** Plain names and packed pattern holes perform no argument member read. */
function quietBindingAtom(node: Node, packedRest: boolean): boolean {
  if (isIdentifier(node) || isOmittedExpression(node)) return true;
  return packedRest && packedPatternOmission(node);
}

/** The syntax API represents a packed array-pattern elision as an empty binding element. */
function packedPatternOmission(node: Node): boolean {
  return (
    isBindingElement(node) &&
    node.name === undefined &&
    isArrayBindingPattern(node.parent) &&
    node.getText(node.getSourceFile()).length === 0
  );
}

/** Reads, primitive literals, callable creations and quiet native Error constructions. */
function quietAtom(value: Expression): boolean {
  return (
    isIdentifier(value) ||
    isOmittedExpression(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    framedMapKey(value) !== undefined ||
    framedNativeConstructor(value, NATIVE_MAPPERS) ||
    quietErrorConstruction(value)
  );
}

/** Literal parts, quiet selections' operands, spreads of written arrays and writes of writable names. */
function quietChildren(value: Expression, writable: Writable): readonly Expression[] | undefined {
  if (isArrayLiteralExpression(value)) return quietElements(value.elements);
  if (isObjectLiteralExpression(value)) return quietObject(value);
  if (isConditionalExpression(value)) return [value.condition, value.whenTrue, value.whenFalse];
  if (isBinaryExpression(value)) {
    const kind = value.operatorToken.kind;
    if (LOGICAL.has(kind)) return [value.left, value.right];
    const target = unwrapped(value.left);
    return kind === SyntaxKind.EqualsToken && isIdentifier(target) && writable(target)
      ? [value.right]
      : undefined;
  }
  return isVoidExpression(value) ? [value.expression] : undefined;
}

/** Plain elements, and spreads of written arrays, which iterate no application code. */
function quietElements(elements: readonly Expression[]): readonly Expression[] | undefined {
  const children: Expression[] = [];
  for (const element of elements) {
    if (!isSpreadElement(element)) children.push(element);
    else if (isArrayLiteralExpression(unwrapped(element.expression)))
      children.push(element.expression);
    else return undefined;
  }
  return children;
}

/** Own data fields with written keys; spreads, accessors and methods may run code when read. */
function quietObject(value: ObjectLiteralExpression): readonly Expression[] | undefined {
  const found: Expression[] = [];
  for (const field of value.properties) {
    if (isSpreadAssignment(field)) return undefined;
    if (isComputedPropertyName(field.name) && framedMapKey(field.name.expression) === undefined)
      return undefined;
    if (isPropertyAssignment(field)) found.push(field.initializer);
    else if (isShorthandPropertyAssignment(field) && isIdentifier(field.name))
      found.push(field.name);
    else return undefined;
  }
  return found;
}
