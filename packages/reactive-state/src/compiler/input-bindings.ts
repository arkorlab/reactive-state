import {
  type BinaryExpression,
  type BindingName,
  type Expression,
  type Identifier,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBindingElement,
  isBlock,
  isCallExpression,
  isConditionalExpression,
  isExpressionStatement,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSignatureDeclaration,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isVoidExpression,
  type Node,
  type ParameterDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { declarationOf } from './framed.ts';
import { metadataInitializer } from './input-callees.ts';
import {
  literalPropertyName,
  type LiteralSelection,
  selected,
  UNKNOWN_SELECTION,
} from './input-selections.ts';
import { targetsOf } from './kept.ts';
import { constantValue } from './numbers.ts';
import { bindingIdentifiers } from './scope.ts';
import { includesApplication } from './written-evaluation.ts';
import { writtenBy } from './written.ts';

export { selected } from './input-selections.ts';

/** Actual constructor/trap arguments and their binding projections at a source read. */

export interface MetadataSource {
  readonly value: Expression;
  readonly bindings: ReadonlyMap<ParameterDeclaration, Expression | undefined>;
}

export interface PresentParameterArray {
  readonly entries: readonly Expression[];
  readonly template?: boolean;
}

const PRESENT_ARRAYS = new WeakMap<
  MetadataSource['bindings'],
  ReadonlyMap<ParameterDeclaration, PresentParameterArray>
>();

const DEFINING = new Set<Identifier>();

const DEFINED_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ArrayLiteralExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.ClassExpression,
  SyntaxKind.DeleteExpression,
  SyntaxKind.FalseKeyword,
  SyntaxKind.FunctionExpression,
  SyntaxKind.NewExpression,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.ObjectLiteralExpression,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.TemplateExpression,
  SyntaxKind.TrueKeyword,
  SyntaxKind.TypeOfExpression,
]);

/** Present rest or template-string parameter entries associated with a call's binding map. */
export function presentParameterArray(
  bindings: MetadataSource['bindings'],
  parameter: ParameterDeclaration,
): PresentParameterArray | undefined {
  return PRESENT_ARRAYS.get(bindings)?.get(parameter);
}

/** Records the present rest or template-string arrays created for a call's binding map. */
export function recordParameterArrays(
  bindings: MetadataSource['bindings'],
  arrays: ReadonlyMap<ParameterDeclaration, PresentParameterArray>,
): void {
  PRESENT_ARRAYS.set(bindings, arrays);
}

interface Step {
  readonly key: string | undefined;
  readonly fallback: Expression | undefined;
}
interface Projection {
  readonly steps: readonly Step[];
  readonly fresh: boolean;
}

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
  const arrays = new Map(PRESENT_ARRAYS.get(outer));
  const parameters = metadataParameters(fn);
  for (const [index, parameter] of parameters.entries()) {
    const argument = given[index];
    if (parameter.dotDotDotToken !== undefined) {
      bindings.set(parameter, undefined);
      arrays.set(parameter, { entries: given.slice(index) });
      continue;
    }
    arrays.delete(parameter);
    bindings.set(parameter, omittedArgument(argument, outer) ? parameter.initializer : argument);
  }
  recordParameterArrays(bindings, arrays);
  return bindings;
}

/** Whether an expression is source-proven not to evaluate to undefined. */
export function definedArgument(
  argument: Expression | undefined,
  bindings: MetadataSource['bindings'],
  seen: ReadonlySet<Expression> = new Set(),
): boolean {
  if (argument === undefined || omittedArgument(argument, bindings)) {
    return false;
  }
  const value = unwrapped(argument);
  if (seen.has(value)) {
    return false;
  }
  const nextSeen = new Set([...seen, value]);
  if (isIdentifier(value)) {
    return definedIdentifier(value, bindings, nextSeen);
  }
  if (isConditionalExpression(value)) {
    return (
      definedArgument(value.whenTrue, bindings, nextSeen) &&
      definedArgument(value.whenFalse, bindings, nextSeen)
    );
  }
  return DEFINED_KINDS.has(value.kind) || constantValue(value, metadataInitializer) !== undefined;
}

/** Whether a constant or bound parameter identifier is proven non-undefined at its read. */
function definedIdentifier(
  name: Identifier,
  bindings: MetadataSource['bindings'],
  seen: ReadonlySet<Expression>,
): boolean {
  if (DEFINING.has(name)) {
    return false;
  }
  DEFINING.add(name);
  try {
    const parameter = parameterSources(name, { bindings, value: name });
    if (parameter !== undefined) {
      if (parameter.present === true) {
        return true;
      }
      const only = parameter.sources?.length === 1 ? parameter.sources[0]?.value : undefined;
      return only === undefined ? false : definedArgument(only, bindings, seen);
    }
    return definedArgument(metadataInitializer(name), bindings, seen);
  } finally {
    DEFINING.delete(name);
  }
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
function argumentSource(name: Identifier, bindings: MetadataSource['bindings']): LiteralSelection {
  const parameter = parameterOf(name);
  if (parameter !== undefined && bindings.has(parameter)) {
    return parameterArgument(name, parameter, bindings);
  }
  const value = metadataInitializer(name);
  return value === undefined ? UNKNOWN_SELECTION : { unknown: false, value };
}

/** A rest identifier holds a present array unless a preceding assignment replaces it. */
function parameterArgument(
  name: Identifier,
  parameter: ParameterDeclaration,
  bindings: MetadataSource['bindings'],
): LiteralSelection {
  if (parameter.dotDotDotToken === undefined || !isIdentifier(parameter.name)) {
    return { unknown: false, value: bindings.get(parameter) };
  }
  const rebound = reassigned(name, parameter);
  if (rebound.fresh === true) {
    return UNKNOWN_SELECTION;
  }
  return rebound.value === undefined && rebound.assigned !== true ? UNKNOWN_SELECTION : rebound;
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
):
  | { readonly present?: boolean; readonly sources: readonly MetadataSource[] | undefined }
  | undefined {
  const parameter = parameterOf(name);
  if (parameter === undefined || !source.bindings.has(parameter)) {
    return undefined;
  }
  const rebound = reassigned(name, parameter);
  if (rebound.unknown) {
    return { sources: undefined };
  }
  if (rebound.fresh === true) {
    return { present: true, sources: [] };
  }
  if (rebound.assigned === true && rebound.value === undefined) {
    return { sources: [] };
  }
  if (rebound.value !== undefined) {
    return { sources: [{ ...source, value: rebound.value }] };
  }
  return boundParameterSources(name, parameter, source);
}

/** A parameter's own fresh container or projected argument sources before any reassignment. */
function boundParameterSources(
  name: Identifier,
  parameter: ParameterDeclaration,
  source: MetadataSource,
): { readonly present?: boolean; readonly sources: readonly MetadataSource[] | undefined } {
  if (
    parameter.dotDotDotToken !== undefined ||
    presentParameterArray(source.bindings, parameter) !== undefined
  ) {
    return isIdentifier(parameter.name) ? { present: true, sources: [] } : { sources: undefined };
  }
  const projection = bindingProjection(parameter.name, name.text, []);
  if (projection?.fresh === true) {
    return { present: true, sources: [] };
  }
  if (projection === undefined) {
    return { sources: undefined };
  }
  return { sources: projectedSources(projection, source, parameter) };
}

/** A binding's literal projections and defaults after its actual argument has been selected. */
function projectedSources(
  projection: Projection,
  source: MetadataSource,
  parameter: ParameterDeclaration,
): readonly MetadataSource[] | undefined {
  const argument = source.bindings.get(parameter);
  if (
    parameter.initializer !== undefined &&
    argument !== parameter.initializer &&
    !definedArgument(argument, source.bindings)
  ) {
    return undefined;
  }
  let value: LiteralSelection = { unknown: false, value: argument };
  for (const step of projection.steps) {
    value = value.unknown ? UNKNOWN_SELECTION : selected(value.value, step.key);
    if (!value.unknown && omittedArgument(value.value, source.bindings)) {
      value = { unknown: false, value: step.fallback };
    } else if (
      !value.unknown &&
      step.fallback !== undefined &&
      !definedArgument(value.value, source.bindings)
    ) {
      return undefined;
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

/** An unconditional preceding assignment, unless later branches or calls can change the binding. */
function reassigned(name: Identifier, parameter: ParameterDeclaration): LiteralSelection {
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
function previousAssignment(
  at: Node,
  name: string,
  parameter: ParameterDeclaration,
): LiteralSelection {
  if (!isBlock(at.parent)) {
    return UNKNOWN_SELECTION;
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
      return UNKNOWN_SELECTION;
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
): LiteralSelection | undefined {
  const target = targetsOf(expression.left).findLast(
    (each) => isIdentifier(each) && each.text === name && parameterOf(each) === parameter,
  );
  if (target === undefined) {
    return undefined;
  }
  const projection = assignmentProjection(target, expression.left);
  if (projection === undefined || includesApplication(expression.left)) {
    return UNKNOWN_SELECTION;
  }
  if (projection.fresh) {
    return { assigned: true, fresh: true, unknown: false, value: undefined };
  }
  let value: LiteralSelection = { unknown: false, value: expression.right };
  for (const step of projection.steps) {
    value = value.unknown ? UNKNOWN_SELECTION : selected(value.value, step.key);
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
      key: literalPropertyName(parent.name),
    });
    fallback = undefined;
    at = parent.parent;
  }
  return { fresh: false, steps: steps.toReversed() };
}
