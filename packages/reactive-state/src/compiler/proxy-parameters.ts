import {
  type BinaryExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isBigIntLiteral,
  isBinaryExpression,
  isCallExpression,
  isClassExpression,
  isConditionalExpression,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isRegularExpressionLiteral,
  isSpreadElement,
  isTaggedTemplateExpression,
  isTemplateExpression,
  isTypeOfExpression,
  isVoidExpression,
  type Node,
  type ParameterDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, parametersOf } from './answers.ts';
import { globalOf, unwrapped } from './bounded.ts';
import { rootOf, targetsOf } from './kept.ts';
import { readsOf } from './local-module-reads.ts';
import { constantValue } from './numbers.ts';
import { parameterValue } from './parameter-values.ts';
import {
  type Frame,
  type Origin,
  type ProxyReading,
  sourcePath,
  sourceValue,
  writtenBefore,
} from './proxy-values.ts';
import { freeReads, hoistedIn } from './scope.ts';
import { interveningEvaluation } from './written-evaluation.ts';
import { writtenBy } from './written.ts';

/** Bound parameter metadata for a reference inside an active call frame. */
export interface ParameterFrame {
  readonly frame: Frame;
  readonly index: number;
  readonly parameter: ParameterDeclaration;
}

/** Assignment operators whose right-hand expression can become the target binding's value. */
const VALUE_ASSIGNMENTS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** Built-in calls whose completion value is never `undefined`. */
const DEFINED_CALLS: ReadonlySet<string> = new Set([
  'Boolean',
  'Number',
  'Proxy.revocable',
  'String',
  'Symbol',
]);

/** The nearest active source invocation whose lexical formal this identifier reads. */
export function parameterFrame(
  name: Identifier,
  frames: readonly Frame[],
): ParameterFrame | undefined {
  for (const frame of frames.toReversed()) {
    const parameters = parametersOf(frame.fn);
    const index = parameters.findIndex(
      (parameter) => isIdentifier(parameter.name) && readsOf(parameter.name, frame.fn)(name),
    );
    const parameter = parameters[index];
    if (parameter !== undefined) {
      return { frame, index, parameter };
    }
  }
  return undefined;
}

/** Resolves a parameter read through replacements, reassignments, arguments, and defaults. */
export function parameterOrigins(
  name: Identifier,
  binding: ParameterFrame,
  at: Origin,
): readonly Origin[] {
  const { frame, index, parameter } = binding;
  if (!isIdentifier(parameter.name)) {
    return [];
  }
  const replaced = parameterValue(frame.fn, parameter.name, name);
  if (replaced !== undefined) {
    return [{ ...at, value: replaced.value }];
  }
  const rest = parameter.dotDotDotToken !== undefined;
  if (rest) {
    return frame.given === undefined || bindingChanged(frame.fn, parameter.name, true)
      ? []
      : restOrigins(frame.given.slice(index), at.keys);
  }
  const assigned = assignedParameterValues(frame.fn, parameter.name).map((value) => ({
    ...at,
    value,
  }));
  return [...assigned, ...incomingParameterOrigins(frame, index, parameter, at)];
}

/** Incoming argument and `undefined`-fallback origins before any body assignment runs. */
function incomingParameterOrigins(
  frame: Frame,
  index: number,
  parameter: ParameterDeclaration,
  at: Origin,
): readonly Origin[] {
  const fallback: readonly Origin[] =
    parameter.initializer === undefined ? [] : [{ ...at, value: parameter.initializer }];
  const given = frame.given?.[index];
  if (frame.given === undefined || given === undefined) {
    return fallback;
  }
  const forwarded: Origin = {
    ...given,
    excluded: at.excluded,
    keys: [...given.keys, ...at.keys],
    spread: at.spread,
  };
  const presence = argumentPresence(given);
  if (presence === 'undefined') {
    return fallback;
  }
  return presence === 'defined' ? [forwarded] : [forwarded, ...fallback];
}

/** A rest array is fresh; only its indexed elements retain actual argument identities. */
function restOrigins(given: readonly Origin[], keys: readonly string[]): readonly Origin[] {
  const [key, ...rest] = keys;
  if (key === undefined) {
    return given;
  }
  const index = Number(key);
  const selected = String(index) === key && index >= 0 ? given[index] : undefined;
  return selected === undefined ? [] : [{ ...selected, keys: [...selected.keys, ...rest] }];
}

/** Collects unshadowed assignments and hoisted `var` initializers targeting `declared`. */
function assignedParameterValues(fn: Answering, declared: Identifier): readonly Expression[] {
  if (fn.body === undefined) {
    return [];
  }
  const isRead = readsOf(declared, fn);
  const found: Expression[] = [];
  for (const declaration of hoistedIn([fn.body])) {
    if (
      isIdentifier(declaration.name) &&
      declaration.name.text === declared.text &&
      declaration.initializer !== undefined
    ) {
      found.push(declaration.initializer);
    }
  }
  const visit = (node: Node): void => {
    if (
      isBinaryExpression(node) &&
      VALUE_ASSIGNMENTS.has(node.operatorToken.kind) &&
      isRead(unwrapped(node.left))
    ) {
      found.push(node.right);
    }
    node.forEachChild(visit);
  };
  visit(fn.body);
  return found;
}

/** A possibly reassigned or mutated rest parameter no longer preserves its incoming tuple arity. */
function bindingChanged(fn: Answering, declared: Identifier, members = false): boolean {
  const isRead = readsOf(declared, fn);
  const visit = (node: Node): boolean => {
    if (members && handedParameter(node, isRead)) {
      return true;
    }
    const target = !members && isCallExpression(node) ? undefined : writtenBy(node);
    if (
      target !== undefined &&
      targetsOf(target).some((each) => {
        const name = members ? rootOf(each) : each;
        return name !== undefined && isIdentifier(name) && isRead(name);
      })
    ) {
      return true;
    }
    return node.forEachChild((child) => (visit(child) ? true : undefined)) === true;
  };
  return fn.body !== undefined && visit(fn.body);
}

/** A handed rest array can have its entries replaced before its selected value is returned. */
function handedParameter(node: Node, isRead: (name: Identifier) => boolean): boolean {
  let given: readonly Expression[] = [];
  if (isCallExpression(node) || isNewExpression(node)) {
    given = node.arguments ?? [];
  } else if (isTaggedTemplateExpression(node)) {
    given = [node.template];
  }
  return given.some(
    (each) => !isSpreadElement(each) && [...freeReads(each)].some((name) => isRead(name)),
  );
}

/** A rest array's entries, or an explicitly unknown binding after a prior write/evaluation. */
export function spreadBinding(
  name: Identifier,
  at: Origin,
): { readonly values?: readonly Origin[] | undefined } | undefined {
  if (writtenBefore(name, at.context)) {
    return {};
  }
  const held = sourceValue(name, at.context);
  if (isArrayLiteralExpression(held) && interveningEvaluation(held, name)) {
    return {};
  }
  const binding = parameterFrame(name, at.context.frames);
  if (binding?.parameter.dotDotDotToken === undefined || at.keys.length > 0) {
    return undefined;
  }
  const { frame, index, parameter } = binding;
  return isIdentifier(parameter.name) && !bindingChanged(frame.fn, parameter.name, true)
    ? { values: frame.given?.slice(index) }
    : {};
}

/** Classifies whether an argument origin is guaranteed `undefined`, defined, or possibly either. */
function argumentPresence(given: Origin): 'defined' | 'possible' | 'undefined' {
  if (given.keys.length > 0) {
    return 'possible';
  }
  const value = sourceValue(given.value, given.context);
  if (isVoidExpression(value) || globalOf(value) === 'undefined') {
    return 'undefined';
  }
  return guaranteedDefined(value, given.context, new Set(), true) ? 'defined' : 'possible';
}

/** Checks whether `node` never evaluates to `undefined` (or `null` when `!nullable`). */
function guaranteedDefined(
  node: Expression,
  reading: ProxyReading,
  seen: ReadonlySet<Expression>,
  nullable: boolean,
): boolean {
  const value = sourceValue(node, reading);
  if (seen.has(value)) {
    return false;
  }
  const following = new Set([...seen, value]);
  if (constantValue(value) !== undefined || nonUndefinedLeaf(value, nullable)) {
    return true;
  }
  if (isConditionalExpression(value)) {
    return (
      guaranteedDefined(value.whenTrue, reading, following, nullable) &&
      guaranteedDefined(value.whenFalse, reading, following, nullable)
    );
  }
  if (isBinaryExpression(value)) {
    return guaranteedDefinedBinary(value, reading, following, nullable);
  }
  return isCallExpression(value) && DEFINED_CALLS.has(sourcePath(value.expression, reading) ?? '');
}

/** Checks binary operators whose result is guaranteed non-`undefined`. */
function guaranteedDefinedBinary(
  value: BinaryExpression,
  reading: ProxyReading,
  seen: Set<Expression>,
  nullable: boolean,
): boolean {
  const kind = value.operatorToken.kind;
  if (kind === SyntaxKind.CommaToken || kind === SyntaxKind.BarBarToken) {
    return guaranteedDefined(value.right, reading, seen, nullable);
  }
  if (kind === SyntaxKind.QuestionQuestionToken) {
    return (
      guaranteedDefined(value.left, reading, seen, false) ||
      guaranteedDefined(value.right, reading, seen, nullable)
    );
  }
  return (
    kind === SyntaxKind.AmpersandAmpersandToken &&
    guaranteedDefined(value.left, reading, seen, nullable) &&
    guaranteedDefined(value.right, reading, seen, nullable)
  );
}

/** Checks literal, unary, and constructed expressions that never evaluate to `undefined`. */
function nonUndefinedLeaf(value: Expression, nullable: boolean): boolean {
  return (
    (nullable && value.kind === SyntaxKind.NullKeyword) ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    isBigIntLiteral(value) ||
    isTemplateExpression(value) ||
    isRegularExpressionLiteral(value) ||
    isObjectLiteralExpression(value) ||
    isArrayLiteralExpression(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    isClassExpression(value) ||
    isNewExpression(value) ||
    isTypeOfExpression(value) ||
    isPrefixUnaryExpression(value) ||
    isPostfixUnaryExpression(value)
  );
}
