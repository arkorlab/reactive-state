import {
  type Expression,
  type ObjectLiteralElementLike,
  type PropertyName,
  type ArrayLiteralExpression,
  isParameterDeclaration,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isArrowFunction,
  isElementAccessExpression,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isReturnStatement,
  isStringLiteral,
  isNumericLiteral,
  isNoSubstitutionTemplateLiteral,
  isIdentifier,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadElement,
  isTypeNode,
  type Node,
  SyntaxKind,
  type ParameterDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameBindingOf, frameMemberName } from './framed-bindings.ts';
import { framedDefaultTaken } from './framed-constructor-defaults.ts';

/** Added constructor-default paths require finite, quiet source-written default evaluation. */

interface Input {
  readonly value: Expression;
  readonly keys: readonly string[];
  readonly any?: boolean;
}

type Inputs = readonly (readonly Input[])[];

/** The parameters a default reads, what the construction supplies them, and getters' returns read. */
interface Reading {
  readonly parameters: readonly ParameterDeclaration[];
  readonly slots: Inputs;
  readonly returned: Expression[];
}

const OPAQUE_EVALUATION: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AwaitExpression,
  SyntaxKind.BinaryExpression,
  SyntaxKind.CallExpression,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.ClassExpression,
  SyntaxKind.ComputedPropertyName,
  SyntaxKind.DeleteExpression,
  SyntaxKind.GetAccessor,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.NewExpression,
  SyntaxKind.PostfixUnaryExpression,
  SyntaxKind.PrefixUnaryExpression,
  SyntaxKind.SetAccessor,
  SyntaxKind.SpreadAssignment,
  SyntaxKind.SpreadElement,
  SyntaxKind.TaggedTemplateExpression,
  SyntaxKind.TemplateExpression,
  SyntaxKind.YieldExpression,
]);

/**
 * Application calls and unknown member getters in any parameter keep the earlier scan — those a
 * read of a supplied getter runs too, whose return is scanned as the parameters are.
 */
export function framedConstructorDefaultEvaluation(
  parameters: readonly ParameterDeclaration[],
  slots: Inputs,
  evaluated: readonly Expression[],
): boolean {
  const pending: Node[] = [...parameters, ...evaluated];
  const getters = new Set<Expression>();
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeNode(node) || isArrowFunction(node) || isFunctionExpression(node)) continue;
    if (OPAQUE_EVALUATION.has(node.kind)) return false;
    const returned: Expression[] = [];
    if (!quietSelection(node, { parameters, returned, slots })) return false;
    for (const each of returned) {
      if (!getters.has(each)) pending.push(each);
      getters.add(each);
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** A top-level parameter pattern reads only a shown literal source rather than opaque getters. */
function knownPattern(parameter: ParameterDeclaration, reading: Reading): boolean {
  const { parameters, slots } = reading;
  const source = parameterInput(parameters.indexOf(parameter), parameters, slots);
  if (source === undefined) return false;
  const value = defaultSource(source.value, source.keys, reading);
  return (
    value !== undefined && (isObjectLiteralExpression(value) || isArrayLiteralExpression(value))
  );
}

/** A parameter's definite supplied root or its definite selected default. */
function parameterInput(
  index: number,
  parameters: readonly ParameterDeclaration[],
  slots: Inputs,
): Input | undefined {
  const given = slots[index] ?? [];
  const parameter = parameters[index];
  if (parameter === undefined) return undefined;
  if (framedDefaultTaken(given))
    return parameter.initializer === undefined
      ? undefined
      : { keys: [], value: parameter.initializer };
  return given.length === 1 ? given[0] : undefined;
}

/**
 * Original parameter/member chains select only finite own literal fields, without call inference;
 * what a getter read on the way returns is kept (`returned`), for its evaluation to be scanned.
 */
function defaultSource(
  expression: Expression,
  keys: readonly string[],
  reading: Reading,
): Expression | undefined {
  let value = unwrapped(expression);
  let remaining = [...keys];
  const seen = new Set<Node>();
  for (;;) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    const next = defaultStep(value, remaining, reading);
    if (next === null) return value;
    if (next === undefined) return undefined;
    value = unwrapped(next.value);
    remaining = [...next.keys];
  }
}

/**
 * A default's member read reaches one ordinary own field or a present ordinary array slot; a
 * getter's return, which the read evaluates, is kept (`returned`). A key the code computes after
 * the field may replace it, `['message']`, with what the read cannot tell: none then.
 */
function literalField(
  value: Expression,
  key: string,
  returned: Expression[],
): Expression | undefined {
  if (isArrayLiteralExpression(value)) return literalElement(value, key);
  if (!isObjectLiteralExpression(value)) return undefined;
  let field: ObjectLiteralElementLike | undefined;
  let replaceable = false;
  for (const property of value.properties) {
    if (
      !isPropertyAssignment(property) &&
      !isShorthandPropertyAssignment(property) &&
      !isGetAccessorDeclaration(property)
    )
      return undefined;
    const name = literalName(property.name);
    replaceable ||= name === undefined;
    if (name !== key) continue;
    field = property;
    replaceable = false;
  }
  const result = field === undefined || replaceable ? undefined : fieldResult(field);
  if (result !== undefined && field !== undefined && isGetAccessorDeclaration(field))
    returned.push(result);
  return result;
}

/** Each source-written member or top-level pattern reads only a shown ordinary literal. */
function quietSelection(node: Node, reading: Reading): boolean {
  if (isPropertyAccessExpression(node) || isElementAccessExpression(node))
    return defaultSource(node, [], reading) !== undefined;
  if (!isObjectBindingPattern(node) && !isArrayBindingPattern(node)) return true;
  const parameter = reading.parameters.find((each) => each.name === node);
  return parameter === undefined || knownPattern(parameter, reading);
}

/** One parameter, member or literal field advances the finite default's original source. */
function defaultStep(
  value: Expression,
  keys: readonly string[],
  reading: Reading,
): Input | null | undefined {
  const { parameters, slots } = reading;
  if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const key = frameMemberName(value) ?? suppliedKey(value, parameters, slots);
    return key === undefined ? undefined : { value: value.expression, keys: [key, ...keys] };
  }
  if (isIdentifier(value)) return selectedParameter(value, keys, parameters, slots);
  const [key, ...rest] = keys;
  if (key === undefined) return null;
  const field = literalField(value, key, reading.returned);
  return field === undefined ? undefined : { value: field, keys: rest };
}

/** A prior constructor parameter retains the definite actual source that its default can read. */
function selectedParameter(
  value: Expression,
  keys: readonly string[],
  parameters: readonly ParameterDeclaration[],
  slots: Inputs,
): Input | null | undefined {
  if (!isIdentifier(value)) return undefined;
  const selected = frameBindingOf(value);
  const binding = selected?.binding;
  const index =
    binding !== undefined && isParameterDeclaration(binding) ? parameters.indexOf(binding) : -1;
  if (index === -1) return keys.length === 0 ? null : undefined;
  const input = parameterInput(index, parameters, slots);
  return input === undefined || input.any === true
    ? undefined
    : { value: input.value, keys: [...input.keys, ...(selected?.keys ?? []), ...keys] };
}

/** A present finite native array position performs no unknown indexed getter evaluation. */
function literalElement(value: ArrayLiteralExpression, key: string): Expression | undefined {
  if (value.elements.some((each) => isSpreadElement(each))) return undefined;
  const index = Number(key);
  if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key) return undefined;
  const field = value.elements[index];
  return field === undefined || isOmittedExpression(field) ? undefined : field;
}

/** A constructor key parameter may prove a quiet actual literal without changing unknown-key origins. */
function suppliedKey(
  value: Expression,
  parameters: readonly ParameterDeclaration[],
  slots: Inputs,
): string | undefined {
  if (!isElementAccessExpression(value)) return undefined;
  const name = unwrapped(value.argumentExpression);
  if (!isIdentifier(name)) return undefined;
  const selected = frameBindingOf(name);
  const binding = selected?.binding;
  if (binding === undefined || !isParameterDeclaration(binding) || selected?.keys.length !== 0)
    return undefined;
  const input = parameterInput(parameters.indexOf(binding), parameters, slots);
  if (input === undefined || input.any === true || input.keys.length > 0) return undefined;
  const key = unwrapped(input.value);
  return isIdentifier(key) ? undefined : literalName(key);
}

/** A direct source-return getter performs no other application work before selecting the field. */
function fieldResult(property: ObjectLiteralElementLike): Expression | undefined {
  if (isPropertyAssignment(property)) return property.initializer;
  if (isShorthandPropertyAssignment(property))
    return isIdentifier(property.name) ? property.name : undefined;
  if (!isGetAccessorDeclaration(property)) return undefined;
  const statements = property.body?.statements;
  const first = statements?.[0];
  return first !== undefined && statements?.length === 1 && isReturnStatement(first)
    ? first.expression
    : undefined;
}

/** Literal own names and supplied primitive keys have their original native spelling. */
function literalName(name: PropertyName | Expression): string | undefined {
  if (isIdentifier(name)) return name.text;
  if (isStringLiteral(name) || isNoSubstitutionTemplateLiteral(name)) return name.text;
  return isNumericLiteral(name) ? String(Number(name.text)) : undefined;
}
