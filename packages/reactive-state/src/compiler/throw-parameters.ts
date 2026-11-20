import {
  type BindingName,
  type Expression,
  type Identifier,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isArrowFunction,
  isAwaitExpression,
  isBindingElement,
  isBlock,
  isCallExpression,
  isExpressionStatement,
  isFunctionExpression,
  isIdentifier,
  isIfStatement,
  isNumericLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isReturnStatement,
  isSourceFile,
  isSpreadElement,
  isStringLiteral,
  isThrowStatement,
  type Node,
  type ParameterDeclaration,
  SyntaxKind,
  isSignatureDeclaration,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { runsLater } from './deferred-syntax.ts';
import { declarationOf } from './framed.ts';
import {
  metadataParameters,
  type MetadataSource,
  omittedArgument,
  parameterSources,
  selected,
} from './input-bindings.ts';
import { metadataInitializer, metadataInvocation } from './input-callees.ts';
import { rootOf, targetsOf } from './kept.ts';
import type { Resolve } from './numbers.ts';
import { bindingIdentifiers } from './scope.ts';
import { skipsEvaluation } from './skipped-evaluation.ts';
import { expandedInvocation } from './throw-arguments.ts';
import { nonIterableWritten } from './throw-collections.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';
import { writtenBy } from './written.ts';

/** Source-selected parameter initialization before a synchronous invocation enters its body. */

interface Initialization {
  readonly invalid: boolean;
  readonly initializers: readonly {
    readonly expression: Expression;
    readonly resolve: Resolve;
  }[];
}

interface Selection {
  readonly value: Expression | undefined;
  readonly unknown: boolean;
  readonly present?: boolean;
  readonly entries?: readonly Expression[];
}
interface Reading {
  readonly bindings: Map<ParameterDeclaration, Expression | undefined>;
  resolve: Resolve;
  readonly found: { readonly expression: Expression; readonly resolve: Resolve }[];
}
const UNKNOWN: Selection = { unknown: true, value: undefined };
const PRESENT: Selection = { present: true, unknown: true, value: undefined };
const INITIALIZING = new Set<Node>();

/** A synchronous initialization failure, with only active recursive inspections suppressed. */
export function invocationInitializationThrows(
  node: Node,
  resolve: Resolve | undefined,
  inspect: (expression: Expression, resolve: Resolve | undefined) => boolean,
): boolean {
  if (!isCallExpression(node) || INITIALIZING.has(node)) {
    return false;
  }
  INITIALIZING.add(node);
  try {
    const initialization = invocationInitialization(node, resolve);
    return (
      initialization !== undefined &&
      (initialization.invalid ||
        initialization.initializers.some((each) => inspect(each.expression, each.resolve)))
    );
  } finally {
    INITIALIZING.delete(node);
  }
}

/** An immediate source call's defaults; async functions turn initialization errors into rejections. */
function invocationInitialization(
  node: Node,
  resolve: Resolve | undefined,
): Initialization | undefined {
  if (!isCallExpression(node)) {
    return undefined;
  }
  const invocation = metadataInvocation(expandedInvocation(node, resolve));
  const fn = invocation?.callee;
  if (invocation === undefined || fn === undefined || !isAnswering(fn)) {
    return undefined;
  }
  const async = fn.modifiers?.some((modifier) => modifier.kind === SyntaxKind.AsyncKeyword);
  const generator = !isArrowFunction(fn) && fn.asteriskToken !== undefined;
  return async === true && !generator
    ? undefined
    : parameterInitialization(fn, invocation.given, resolve);
}

/** Selected defaults and binding failures in parameter order, before later parameters initialize. */
function parameterInitialization(
  fn: { readonly parameters: readonly ParameterDeclaration[] },
  given: readonly Expression[],
  outer: Resolve | undefined,
): Initialization {
  const bindings = new Map<ParameterDeclaration, Expression | undefined>();
  const found: Reading['found'] = [];
  for (const [index, parameter] of metadataParameters(fn).entries()) {
    const resolve = initializedResolve(new Map(bindings), outer);
    const reading = { bindings, found, resolve };
    const actual =
      parameter.dotDotDotToken === undefined
        ? sourceValue(given[index], resolve)
        : { entries: given.slice(index), present: true, unknown: false, value: undefined };
    const value = withDefault(actual, parameter.initializer, reading);
    if (!bindingInitializers(parameter.name, value, reading)) {
      return { initializers: found, invalid: true };
    }
    bindings.set(parameter, value.value);
  }
  return { initializers: found, invalid: false };
}

/** Earlier initialized parameters retain their actual values; current and later parameters do not. */
function initializedResolve(
  bindings: MetadataSource['bindings'],
  outer: Resolve | undefined,
): Resolve {
  return (name) => {
    const parameter = parameterSources(name, { bindings, value: name });
    if (parameter !== undefined) {
      return parameter.sources?.[0]?.value;
    }
    const declared = declarationOf(name);
    if (declared !== undefined) {
      return metadataInitializer(name);
    }
    return lexicalParameter(name) === undefined ? outer?.(name) : undefined;
  };
}

/** A lexical parameter shadows an outer name even before the parameter has initialized. */
function lexicalParameter(name: Identifier): ParameterDeclaration | undefined {
  if (declarationOf(name) !== undefined) {
    return undefined;
  }
  for (let at: Node = name.parent; !isSourceFile(at); at = at.parent) {
    if (isSignatureDeclaration(at)) {
      const found = metadataParameters(at).find((parameter) =>
        bindingIdentifiers(parameter.name).some((each) => each.text === name.text),
      );
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

/** A source value through unchanged aliases; a changed object cannot establish a missing member. */
function sourceValue(node: Expression | undefined, resolve: Resolve): Selection {
  if (node === undefined) {
    return { unknown: false, value: undefined };
  }
  const value = writtenOf(node, resolve);
  if (
    value !== unwrapped(node) &&
    (isArrayLiteralExpression(value) || isObjectLiteralExpression(value)) &&
    calleeUncertain(value, node)
  ) {
    return UNKNOWN;
  }
  return { unknown: false, value };
}

/** Only a proven omitted or undefined value selects a default; unknown values retain runtime checks. */
function withDefault(
  value: Selection,
  initializer: Expression | undefined,
  reading: Reading,
): Selection {
  if (
    initializer === undefined ||
    value.unknown ||
    value.present === true ||
    !omittedArgument(value.value, reading.bindings)
  ) {
    return value;
  }
  const resolve = reading.resolve;
  reading.found.push({ expression: initializer, resolve });
  const chosen = sourceValue(initializer, resolve);
  forgetWrittenParameters(initializer, reading);
  reading.resolve = initializedResolve(new Map(reading.bindings), resolve);
  return chosen;
}

/** Selected defaults can replace earlier formals; later reads must not reuse their old values. */
function forgetWrittenParameters(node: Node, reading: Reading): void {
  const visit = (each: Node): void => {
    if (runsLater(each) || skipsEvaluation(each, reading.resolve)) {
      return;
    }
    if (isBlock(each)) {
      for (const root of synchronousPrefix(each, reading.resolve)) {
        visit(root);
      }
      return;
    }
    if (isIfStatement(each)) {
      visit(each.expression);
      for (const branch of possibleBranches(each, reading.resolve)) {
        visit(branch);
      }
      return;
    }
    const written = writtenBy(each);
    const targets = written === undefined ? [] : targetsOf(written);
    for (const target of targets) {
      const root = rootOf(target);
      const parameter = root === undefined ? undefined : lexicalParameter(root);
      if (parameter !== undefined) {
        reading.bindings.delete(parameter);
      }
    }
    for (const root of immediateCallWork(each, reading.resolve)) {
      visit(root);
    }
    each.forEachChild(visit);
  };
  visit(node);
}

/** A direct IIFE can write through branches; generators and uncertain parameter bindings do not. */
function immediateCallWork(node: Node, resolve: Resolve): readonly Node[] {
  if (!isCallExpression(node)) {
    return [];
  }
  const fn = unwrapped(node.expression);
  if (
    (!isArrowFunction(fn) && !isFunctionExpression(fn)) ||
    (isFunctionExpression(fn) && fn.asteriskToken !== undefined) ||
    metadataParameters(fn).some(
      (parameter) => !isIdentifier(parameter.name) || parameter.initializer !== undefined,
    ) ||
    metadataInvocation(expandedInvocation(node, resolve))?.callee !== fn
  ) {
    return [];
  }
  return synchronousPrefix(fn.body, resolve);
}

/** Possible synchronous work ends at a source-proven return, throw or first suspension. */
function synchronousPrefix(body: Node, resolve: Resolve): readonly Node[] {
  const statements = isBlock(body) ? body.statements : [body];
  const roots: Node[] = [];
  for (const statement of statements) {
    if (containsAwait(statement)) {
      const operand = awaitedOperand(statement);
      if (operand !== undefined) {
        roots.push(operand);
      }
      break;
    }
    roots.push(statement);
    if (endsPrefix(statement, resolve)) {
      break;
    }
  }
  return roots;
}

/** A standalone await evaluates its operand before the function suspends. */
function awaitedOperand(node: Node): Expression | undefined {
  const expression =
    isExpressionStatement(node) || isReturnStatement(node) ? node.expression : node;
  return expression !== undefined && isAwaitExpression(expression)
    ? expression.expression
    : undefined;
}

/** Selected literal branches alone execute; an unknown condition can execute either branch. */
function possibleBranches(
  node: Node & {
    readonly expression: Expression;
    readonly thenStatement: Node;
    readonly elseStatement?: Node;
  },
  resolve: Resolve,
): readonly Node[] {
  const condition = writtenOf(node.expression, resolve);
  if (condition.kind === SyntaxKind.TrueKeyword) {
    return [node.thenStatement];
  }
  const otherwise = node.elseStatement === undefined ? [] : [node.elseStatement];
  return condition.kind === SyntaxKind.FalseKeyword
    ? otherwise
    : [node.thenStatement, ...otherwise];
}

/** A direct or selected unconditional completion makes the following suffix unreachable. */
function endsPrefix(node: Node, resolve: Resolve): boolean {
  if (isReturnStatement(node) || isThrowStatement(node)) {
    return true;
  }
  if (isBlock(node)) {
    return node.statements.some((statement) => endsPrefix(statement, resolve));
  }
  if (!isIfStatement(node)) {
    return false;
  }
  const branches = possibleBranches(node, resolve);
  const condition = writtenOf(node.expression, resolve);
  return (
    branches.length > 0 &&
    (condition.kind === SyntaxKind.TrueKeyword || node.elseStatement !== undefined) &&
    branches.every((branch) => endsPrefix(branch, resolve))
  );
}

/** Await in a nested function does not suspend the body that creates that function. */
function containsAwait(node: Node): boolean {
  return (
    isAwaitExpression(node) ||
    (!isAnswering(node) &&
      node.forEachChild((child) => (containsAwait(child) ? true : undefined)) === true)
  );
}

/** Pattern selection stops at an earlier nullish or non-iterable binding failure. */
function bindingInitializers(binding: BindingName, actual: Selection, reading: Reading): boolean {
  if (isIdentifier(binding)) {
    return true;
  }
  if (bindingFailure(binding, actual, reading.resolve)) {
    return false;
  }
  const members = readsIterator(binding, actual, reading.resolve) ? UNKNOWN : actual;
  for (const [index, element] of binding.elements.entries()) {
    if (!isBindingElement(element) || element.name === undefined) {
      continue;
    }
    const key = isArrayBindingPattern(binding)
      ? String(index)
      : propertyName(element.propertyName ?? element.name);
    const value =
      element.dotDotDotToken === undefined
        ? selectedValue(members, key, reading.resolve)
        : restValue(actual, index, reading.resolve);
    const chosen = withDefault(value, element.initializer, reading);
    if (!bindingInitializers(element.name, chosen, reading)) {
      return false;
    }
  }
  return true;
}

/** Whether an array pattern is written over an object literal, whose iterator it reads, not its numbers. */
function readsIterator(binding: BindingName, actual: Selection, resolve: Resolve): boolean {
  return (
    isArrayBindingPattern(binding) &&
    actual.value !== undefined &&
    isObjectLiteralExpression(writtenOf(actual.value, resolve))
  );
}

/** A statically missing, nullish or non-iterable pattern source. */
function bindingFailure(binding: BindingName, actual: Selection, resolve: Resolve): boolean {
  if (actual.unknown || actual.present === true || actual.entries !== undefined) {
    return false;
  }
  return (
    actual.value === undefined ||
    primitiveOf(actual.value, resolve) === 'nothing' ||
    (isArrayBindingPattern(binding) && nonIterableWritten(actual.value, resolve))
  );
}

/**
 * A literal member or a known inherited member, without reading a getter or unknown prototype; the
 * key `__proto__` reads the prototype where a literal writes one, so it stays unproven.
 */
function selectedValue(actual: Selection, key: string | undefined, resolve: Resolve): Selection {
  if (key === undefined || key === '__proto__' || actual.unknown) {
    return UNKNOWN;
  }
  const value = actual.value === undefined ? undefined : sourceValue(actual.value, resolve);
  if (value?.unknown === true) {
    return UNKNOWN;
  }
  const entries =
    actual.entries ??
    (value?.value !== undefined && isArrayLiteralExpression(value.value)
      ? value.value.elements
      : undefined);
  if (entries !== undefined) {
    return selectedArray(entries, key, resolve);
  }
  const picked = selected(value?.value, key);
  if (inheritsMember(value?.value, picked, key)) {
    return PRESENT;
  }
  return picked.unknown ? UNKNOWN : sourceValue(picked.value, resolve);
}

/** Whether an object literal that writes no prototype inherits `key` from `Object.prototype`. */
function inheritsMember(
  literal: Expression | undefined,
  picked: Pick<Selection, 'unknown' | 'value'>,
  key: string,
): boolean {
  return (
    literal !== undefined &&
    isObjectLiteralExpression(literal) &&
    picked.value === undefined &&
    !picked.unknown &&
    Object.hasOwn(Object.prototype, key) &&
    !literal.properties.some(
      (property) => isPropertyAssignment(property) && propertyName(property.name) === '__proto__',
    )
  );
}

/** A stored array entry, a hole or an inherited member that does not select its fallback. */
function selectedArray(entries: readonly Expression[], key: string, resolve: Resolve): Selection {
  if (entries.some((entry) => isSpreadElement(entry))) {
    return UNKNOWN;
  }
  if (
    key === 'length' ||
    Object.hasOwn(Array.prototype, key) ||
    Object.hasOwn(Object.prototype, key)
  ) {
    return PRESENT;
  }
  const index = Number(key);
  const entry = String(index) === key ? entries[index] : undefined;
  return sourceValue(
    entry === undefined || isOmittedExpression(entry) ? undefined : entry,
    resolve,
  );
}

/** A rest array is present and iterable; its entries remain available to nested binding patterns. */
function restValue(actual: Selection, index: number, resolve: Resolve): Selection {
  if (actual.unknown) {
    return PRESENT;
  }
  const value = actual.value === undefined ? undefined : sourceValue(actual.value, resolve).value;
  const entries =
    actual.entries ??
    (value !== undefined && isArrayLiteralExpression(value) ? value.elements : undefined);
  return entries === undefined || entries.some((entry) => isSpreadElement(entry))
    ? PRESENT
    : { entries: entries.slice(index), present: true, unknown: false, value: undefined };
}

/** A source-literal member key; computed names remain unproven. */
function propertyName(node: Node): string | undefined {
  if (isNumericLiteral(node)) {
    return String(Number(node.text));
  }
  return isIdentifier(node) || isStringLiteral(node) ? node.text : undefined;
}
