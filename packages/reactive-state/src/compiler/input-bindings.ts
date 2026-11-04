import {
  type BindingName,
  type BinaryExpression,
  type Expression,
  type Identifier,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBindingElement,
  isBlock,
  isCallExpression,
  isExpressionStatement,
  isIdentifier,
  isNewExpression,
  isNumericLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isVoidExpression,
  type Node,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
  SyntaxKind,
  isSignatureDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { declarationOf } from './framed.ts';
import { metadataInitializer } from './input-callees.ts';
import { targetsOf } from './kept.ts';
import { constantValue } from './numbers.ts';
import { bindingIdentifiers } from './scope.ts';
import { includesApplication } from './written-evaluation.ts';
import { writtenBy } from './written.ts';

/** Actual constructor/trap arguments and their binding projections at a source read. */

export interface MetadataSource {
  readonly value: Expression;
  readonly bindings: ReadonlyMap<ParameterDeclaration, Expression | undefined>;
}

interface Step {
  readonly key: string | undefined;
  readonly fallback: Expression | undefined;
}
interface Projection {
  readonly steps: readonly Step[];
  readonly fresh: boolean;
}
interface Selection {
  readonly value: Expression | undefined;
  readonly unknown: boolean;
  readonly assigned?: boolean;
  readonly fresh?: boolean;
}
const UNKNOWN: Selection = { unknown: true, value: undefined };

/**
 * A function's parameters as a call binds them: a leading `this` declaration, which TypeScript
 * erases, aside.
 */
export function metadataParameters(node: {
  readonly parameters: readonly ParameterDeclaration[];
}): readonly ParameterDeclaration[] {
  return node.parameters.filter(
    (parameter) => !isIdentifier(parameter.name) || parameter.name.text !== 'this',
  );
}

/** Actual arguments, including defaults and the fresh array a rest parameter constructs. */
export function metadataArguments(
  fn: { readonly parameters: readonly ParameterDeclaration[] },
  given: readonly Expression[],
  outer: MetadataSource['bindings'],
): MetadataSource['bindings'] {
  const bindings = new Map(outer);
  const parameters = metadataParameters(fn);
  for (const [index, parameter] of parameters.entries()) {
    const argument = given[index];
    let value = omittedArgument(argument, outer) ? parameter.initializer : argument;
    if (parameter.dotDotDotToken !== undefined) {
      value = undefined;
    }
    bindings.set(parameter, value);
  }
  return bindings;
}

/** Whether an argument selects the default, including source-proven undefined aliases. */
export function omittedArgument(
  argument: Expression | undefined,
  bindings: MetadataSource['bindings'],
): boolean {
  const seen = new Set<Expression>();
  let value = argument;
  while (value !== undefined) {
    value = unwrapped(value);
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    if (isVoidExpression(value) || globalPathOf(value)?.join('.') === 'undefined') {
      return true;
    }
    if (!isIdentifier(value)) {
      return false;
    }
    const actual = argumentSource(value, bindings);
    if (actual.unknown) {
      return false;
    }
    value = actual.value;
  }
  return true;
}

/** A parameter's actual argument or a constant alias, without treating an unknown read as absent. */
function argumentSource(name: Identifier, bindings: MetadataSource['bindings']): Selection {
  const parameter = parameterOf(name);
  if (parameter !== undefined && bindings.has(parameter)) {
    return parameterArgument(name, parameter, bindings);
  }
  const value = metadataInitializer(name);
  return value === undefined ? UNKNOWN : { unknown: false, value };
}

/** A rest identifier holds a present array unless a preceding assignment replaces it. */
function parameterArgument(
  name: Identifier,
  parameter: ParameterDeclaration,
  bindings: MetadataSource['bindings'],
): Selection {
  if (parameter.dotDotDotToken === undefined || !isIdentifier(parameter.name)) {
    return { unknown: false, value: bindings.get(parameter) };
  }
  const rebound = reassigned(name, parameter);
  if (rebound.fresh === true) {
    return UNKNOWN;
  }
  return rebound.value === undefined && rebound.assigned !== true ? UNKNOWN : rebound;
}

/** A lexical parameter, including one whose binding is a pattern rather than a name. */
function parameterOf(name: Identifier): ParameterDeclaration | undefined {
  if (declarationOf(name) !== undefined) {
    return undefined;
  }
  for (let at: Node = name.parent; !isSourceFile(at); at = at.parent) {
    if (!isSignatureDeclaration(at)) {
      continue;
    }
    const found = at.parameters.find((parameter) =>
      bindingIdentifiers(parameter.name).some((bound) => bound.text === name.text),
    );
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/** A parameter read's actual value; an absent entry is a non-parameter. */
export function parameterSources(
  name: Identifier,
  source: MetadataSource,
): { readonly sources: readonly MetadataSource[] | undefined } | undefined {
  const parameter = parameterOf(name);
  if (parameter === undefined || !source.bindings.has(parameter)) {
    return undefined;
  }
  const rebound = reassigned(name, parameter);
  if (rebound.unknown) {
    return { sources: undefined };
  }
  if (rebound.fresh === true || (rebound.assigned === true && rebound.value === undefined)) {
    return { sources: [] };
  }
  if (rebound.value !== undefined) {
    return { sources: [{ ...source, value: rebound.value }] };
  }
  const projection = bindingProjection(parameter.name, name.text, []);
  if (parameter.dotDotDotToken !== undefined) {
    return { sources: isIdentifier(parameter.name) ? [] : undefined };
  }
  if (projection?.fresh === true) {
    return { sources: [] };
  }
  if (projection === undefined) {
    return { sources: undefined };
  }
  return { sources: projectedSources(projection, source, source.bindings.get(parameter)) };
}

/** A binding's literal projections and defaults after its actual argument has been selected. */
function projectedSources(
  projection: Projection,
  source: MetadataSource,
  argument: Expression | undefined,
): readonly MetadataSource[] | undefined {
  let value: Selection = { unknown: false, value: argument };
  for (const step of projection.steps) {
    value = value.unknown ? UNKNOWN : selected(value.value, step.key);
    if (!value.unknown && omittedArgument(value.value, source.bindings)) {
      value = { unknown: false, value: step.fallback };
    }
  }
  if (value.unknown) {
    return undefined;
  }
  return value.value === undefined ? [] : [{ ...source, value: value.value }];
}

/** The members a parameter pattern selects, and the fresh copy one of its rest bindings makes. */
function bindingProjection(
  binding: BindingName,
  name: string,
  steps: readonly Step[],
): Projection | undefined {
  if (isIdentifier(binding)) {
    return binding.text === name ? { fresh: false, steps } : undefined;
  }
  for (const [index, element] of binding.elements.entries()) {
    if (!isBindingElement(element) || element.name === undefined) {
      continue;
    }
    const named = element.propertyName ?? element.name;
    let key = isIdentifier(named) || isStringLiteral(named) ? named.text : undefined;
    if (isArrayBindingPattern(binding)) {
      key = String(index);
    }
    const found = bindingProjection(element.name, name, [
      ...steps,
      { fallback: element.initializer, key },
    ]);
    if (found === undefined) {
      continue;
    }
    if (element.dotDotDotToken !== undefined && !isIdentifier(element.name)) {
      return undefined;
    }
    return { ...found, fresh: found.fresh || element.dotDotDotToken !== undefined };
  }
  return undefined;
}

/** A written literal member, after constant aliases; unknown holders/spreads remain unproven. */
export function selected(node: Expression | undefined, key: string | undefined): Selection {
  if (node === undefined) {
    return { unknown: false, value: undefined };
  }
  if (key === undefined) {
    return UNKNOWN;
  }
  const value = literalValue(node);
  if (value !== undefined && isObjectLiteralExpression(value)) {
    return selectedProperty(value, key);
  }
  if (
    value !== undefined &&
    isArrayLiteralExpression(value) &&
    !value.elements.some((element) => isSpreadElement(element))
  ) {
    const item = value.elements[Number(key)];
    return {
      unknown: false,
      value: item === undefined || isOmittedExpression(item) ? undefined : item,
    };
  }
  return UNKNOWN;
}

/** A value followed through constants without evaluating a conversion or application call. */
function literalValue(node: Expression): Expression | undefined {
  const seen = new Set<Expression>();
  let value = unwrapped(node);
  while (isIdentifier(value)) {
    if (seen.has(value)) {
      return undefined;
    }
    seen.add(value);
    const initializer = metadataInitializer(value);
    if (initializer === undefined) {
      return value;
    }
    value = unwrapped(initializer);
  }
  return value;
}

/** A literal object's last own definition, with unknown computed names or spreads left unproven. */
function selectedProperty(value: ObjectLiteralExpression, key: string): Selection {
  let inherited = false;
  for (const property of value.properties.toReversed()) {
    if (isSpreadAssignment(property)) {
      return UNKNOWN;
    }
    const named = propertyName(property.name);
    if (named === undefined) {
      return UNKNOWN;
    }
    inherited ||= inheritedProperty(property);
    if (named === key) {
      if (isPropertyAssignment(property)) {
        return { unknown: false, value: property.initializer };
      }
      if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
        return { unknown: false, value: property.name };
      }
      return UNKNOWN;
    }
  }
  return inherited ? UNKNOWN : { unknown: false, value: undefined };
}

/** A literal prototype can supply a missing property instead of selecting a binding's default. */
function inheritedProperty(node: Node): boolean {
  return (
    isPropertyAssignment(node) &&
    propertyName(node.name) === '__proto__' &&
    !ignoredPrototype(node.initializer)
  );
}

/** Null and primitive prototype-setter values leave no custom object to supply missing members. */
function ignoredPrototype(node: Expression): boolean {
  const value = literalValue(node);
  if (value === undefined || (includesApplication(value) && globalPathOf(value) === undefined)) {
    return false;
  }
  return (
    value.kind === SyntaxKind.NullKeyword ||
    value.kind === SyntaxKind.BigIntLiteral ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    isVoidExpression(value) ||
    globalPathOf(value)?.join('.') === 'undefined' ||
    constantValue(value, metadataInitializer) !== undefined
  );
}

/** A literal binding key whose comparison executes no application code. */
function propertyName(node: Node): string | undefined {
  if (isNumericLiteral(node)) {
    return String(Number(node.text));
  }
  return isIdentifier(node) || isStringLiteral(node) ? node.text : undefined;
}

/** An unconditional preceding assignment, unless later branches or calls can change the binding. */
function reassigned(name: Identifier, parameter: ParameterDeclaration): Selection {
  let at: Node = name;
  while (at !== parameter.parent && !isSourceFile(at)) {
    if (isBlock(at.parent)) {
      const previous = previousAssignment(at, name.text, parameter);
      if (previous.unknown || previous.value !== undefined || previous.assigned === true) {
        return previous;
      }
    }
    at = at.parent;
  }
  return { unknown: false, value: undefined };
}

/** The latest unconditional assignment before one statement, with later effects taking precedence. */
function previousAssignment(at: Node, name: string, parameter: ParameterDeclaration): Selection {
  if (!isBlock(at.parent)) {
    return UNKNOWN;
  }
  const statements: readonly Node[] = at.parent.statements;
  const index = statements.indexOf(at);
  for (const statement of statements.slice(0, index).toReversed()) {
    const expression = isExpressionStatement(statement)
      ? unwrapped(statement.expression)
      : undefined;
    if (
      expression !== undefined &&
      isBinaryExpression(expression) &&
      expression.operatorToken.kind === SyntaxKind.EqualsToken
    ) {
      const assigned = assignedParameter(expression, name, parameter);
      if (assigned !== undefined) {
        return assigned;
      }
    }
    if (mayReassign(statement, parameter, name)) {
      return UNKNOWN;
    }
  }
  return { unknown: false, value: undefined };
}

/** Conditional assignments and calls can replace a captured parameter before the read. */
function mayReassign(node: Node, parameter: ParameterDeclaration, name: string): boolean {
  let found = false;
  const visit = (each: Node): void => {
    if (
      isCallExpression(each) ||
      isNewExpression(each) ||
      changedParameter(each, parameter, name)
    ) {
      found = true;
    }
    if (!found) {
      each.forEachChild(visit);
    }
  };
  visit(node);
  return found;
}

/** A source-proven write to the parameter binding, including compound and unary assignments. */
function changedParameter(node: Node, parameter: ParameterDeclaration, name: string): boolean {
  const written = writtenBy(node);
  return (written === undefined ? [] : targetsOf(written)).some(
    (target) => isIdentifier(target) && target.text === name && parameterOf(target) === parameter,
  );
}

/** The last selected target of a plain assignment, without evaluating pattern effects. */
function assignedParameter(
  expression: BinaryExpression,
  name: string,
  parameter: ParameterDeclaration,
): Selection | undefined {
  const target = targetsOf(expression.left).findLast(
    (each) => isIdentifier(each) && each.text === name && parameterOf(each) === parameter,
  );
  if (target === undefined) {
    return undefined;
  }
  const projection = assignmentProjection(target, expression.left);
  if (projection === undefined || includesApplication(expression.left)) {
    return UNKNOWN;
  }
  if (projection.fresh) {
    return { assigned: true, fresh: true, unknown: false, value: undefined };
  }
  let value: Selection = { unknown: false, value: expression.right };
  for (const step of projection.steps) {
    value = value.unknown ? UNKNOWN : selected(value.value, step.key);
    if (!value.unknown && omittedArgument(value.value, new Map())) {
      value = { unknown: false, value: step.fallback };
    }
  }
  return { ...value, assigned: true };
}

/** Literal array/object selections leading to one assignment target, including its defaults. */
function assignmentProjection(target: Node, root: Node): Projection | undefined {
  const steps: Step[] = [];
  let fallback: Expression | undefined;
  for (let at = target; at !== root;) {
    const parent = at.parent;
    if (at === target && (isSpreadElement(parent) || isSpreadAssignment(parent))) {
      return { fresh: true, steps: [] };
    }
    if (
      isBinaryExpression(parent) &&
      parent.operatorToken.kind === SyntaxKind.EqualsToken &&
      parent.left === at
    ) {
      fallback = parent.right;
      at = parent;
      continue;
    }
    if (isArrayLiteralExpression(parent)) {
      steps.push({ fallback, key: String(parent.elements.indexOf(at as Expression)) });
      fallback = undefined;
      at = parent;
      continue;
    }
    if (
      (!isPropertyAssignment(parent) && !isShorthandPropertyAssignment(parent)) ||
      !isObjectLiteralExpression(parent.parent)
    ) {
      return undefined;
    }
    steps.push({
      fallback: isShorthandPropertyAssignment(parent)
        ? parent.objectAssignmentInitializer
        : fallback,
      key: propertyName(parent.name),
    });
    fallback = undefined;
    at = parent.parent;
  }
  return { fresh: false, steps: steps.toReversed() };
}
