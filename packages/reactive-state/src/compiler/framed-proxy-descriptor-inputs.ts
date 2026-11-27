import {
  type Expression,
  isArrowFunction,
  isBlock,
  isComputedPropertyName,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isReturnStatement,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isVariableStatement,
  type Node,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
  type PropertyName,
} from 'typescript/ast';

import { answersLater } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import {
  framedQuietInputs,
  framedQuietPrimitive,
  framedQuietSource,
} from './framed-native-evaluation.ts';

/** Native descriptor conversion requires finite quiet record construction and synchronous readers. */

const ERRORS = new Set([
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);

type Member = ObjectLiteralExpression['properties'][number];

/** A field's finite name cannot execute a supplied key conversion. */
export function framedProxyFieldName(name: PropertyName | undefined): string | undefined {
  if (
    name === undefined ||
    (isComputedPropertyName(name) && !framedQuietPrimitive(name.expression))
  )
    return undefined;
  const key = writtenArrayKey(name);
  return key === '__proto__' ? undefined : key;
}

/** Deferred callable fields are created without executing their bodies or defaults. */
export function framedProxyRecordQuiet(record: ObjectLiteralExpression): boolean {
  return framedProxyInputQuiet(record);
}

/** Whole literal records may contain deferred functions; application invocations remain opaque. */
export function framedProxyInputQuiet(expression: Expression): boolean {
  const pending = [expression];
  const seen = new Set<Expression>();
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const value = framedQuietSource(node, false);
    if (value === undefined) return false;
    if (seen.has(value)) continue;
    seen.add(value);
    if (isArrowFunction(value) || isFunctionExpression(value)) continue;
    if (isObjectLiteralExpression(value)) {
      if (value.properties.some((property) => !quietField(property, pending))) return false;
    } else if (!framedQuietInputs([node], ERRORS)) return false;
  }
  return true;
}

/** A literal field evaluates only its computed key and data initializer at record creation. */
function quietField(property: Member, pending: Expression[]): boolean {
  if (isSpreadAssignment(property) || framedProxyFieldName(property.name) === undefined)
    return false;
  if (isPropertyAssignment(property)) pending.push(property.initializer);
  else if (isShorthandPropertyAssignment(property) && isIdentifier(property.name))
    pending.push(property.name);
  else
    return (
      isMethodDeclaration(property) ||
      isGetAccessorDeclaration(property) ||
      isSetAccessorDeclaration(property)
    );
  return true;
}

/** A native trap consumes its supplied parameters and only quiet missing defaults. */
export function framedProxyTrapResult(node: Node, supplied: number): Expression | undefined {
  const value = isPropertyAssignment(node) ? unwrapped(node.initializer) : node;
  if (!isMethodDeclaration(value) && !isFunctionExpression(value) && !isArrowFunction(value))
    return undefined;
  if (answersLater(value) || value.body === undefined) return undefined;
  const parameters = value.parameters;
  if (parameters.some((parameter, index) => !quietParameter(parameter, index, supplied)))
    return undefined;
  if (!isBlock(value.body)) return framedProxyInputQuiet(value.body) ? value.body : undefined;
  for (const statement of value.body.statements) {
    if (isReturnStatement(statement)) return quietReturn(statement.expression);
    if (!quietConstant(statement)) return undefined;
  }
  return undefined;
}

/** A returned literal or binding adds only its proved quiet source evaluation. */
function quietReturn(expression: Expression | undefined): Expression | undefined {
  return expression !== undefined && framedProxyInputQuiet(expression) ? expression : undefined;
}

/** Quiet whole const prefixes cannot invoke an application callback before returning the descriptor. */
function quietConstant(statement: Node): boolean {
  if (
    !isVariableStatement(statement) ||
    !/^const\b/u.test(statement.declarationList.getText(statement.getSourceFile()))
  )
    return false;
  return statement.declarationList.declarations.every((declaration) => {
    return (
      isIdentifier(declaration.name) &&
      declaration.initializer !== undefined &&
      framedProxyInputQuiet(declaration.initializer)
    );
  });
}

/** A native-supplied target and key skip defaults; additional evaluated defaults must be quiet. */
function quietParameter(parameter: ParameterDeclaration, index: number, supplied: number): boolean {
  return (
    isIdentifier(parameter.name) &&
    parameter.dotDotDotToken === undefined &&
    (index < supplied ||
      parameter.initializer === undefined ||
      framedProxyInputQuiet(parameter.initializer))
  );
}

/** Native ToPropertyDescriptor reads a getter result, whereas setter-only fields yield undefined. */
export function framedProxyFieldValue(property: Member): Expression | undefined {
  if (isPropertyAssignment(property)) return property.initializer;
  if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) return property.name;
  if (!isGetAccessorDeclaration(property)) return undefined;
  const first = property.body?.statements[0];
  return first !== undefined && property.body?.statements.length === 1 && isReturnStatement(first)
    ? first.expression
    : undefined;
}
