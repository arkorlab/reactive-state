import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isTaggedTemplateExpression,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, answersLater, isAnswering, parametersOf, returnedBy } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { metadataCallee } from './input-callees.ts';
import { rootOf, targetsOf } from './kept.ts';
import { readsOf } from './local-module-reads.ts';
import { parameterValue } from './parameter-values.ts';
import {
  heldConstant,
  literalTruth,
  originKey,
  propertyKey,
  type ProxyReading,
  sourcePath,
  sourceValue,
  writtenBefore,
} from './proxy-values.ts';
import { freeReads } from './scope.ts';
import { interveningEvaluation } from './written-evaluation.ts';
import { writtenBy } from './written.ts';

export type { ProxyReading } from './proxy-values.ts';

interface Frame {
  readonly fn: Answering;
  readonly given: readonly Origin[] | undefined;
}

interface ParameterFrame {
  readonly frame: Frame;
  readonly index: number;
  readonly parameter: ParameterDeclaration;
}

interface Context extends ProxyReading {
  readonly calls: ReadonlySet<Node>;
  readonly frames: readonly Frame[];
}

interface Origin {
  readonly value: Expression;
  readonly keys: readonly string[];
  readonly context: Context;
  readonly seen: ReadonlySet<Expression>;
}

/** Native calls whose result cannot retain the identity of an object they consume. */
const SCALARS: ReadonlySet<string> = new Set(['Boolean', 'JSON.stringify', 'Number', 'String']);

/** The source Proxy in a value's possible origins; no proof is made of an unknown call's result. */
export function proxyOrigin(
  values: readonly Expression[],
  reading: ProxyReading = {},
): Node | undefined {
  const context: Context = { ...reading, calls: new Set(), frames: [] };
  const visited = new WeakMap<Context, Map<Expression, Set<string>>>();
  const pending: Origin[] = values.map((value) => ({ context, keys: [], seen: new Set(), value }));
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const value = unwrapped(next.value);
    if (next.seen.has(value) || markVisited(visited, next.context, value, originStateKey(next))) {
      continue;
    }
    const at = { ...next, seen: new Set([...next.seen, value]), value };
    if (isProxy(at)) {
      return value;
    }
    pending.push(...originsOf(at));
  }
  return undefined;
}

/** Records `(context, value, state)` and reports whether that analysis state was already explored. */
function markVisited(
  visited: WeakMap<Context, Map<Expression, Set<string>>>,
  context: Context,
  value: Expression,
  state: string,
): boolean {
  let byExpression = visited.get(context);
  if (byExpression === undefined) {
    byExpression = new Map();
    visited.set(context, byExpression);
  }
  let states = byExpression.get(value);
  if (states === undefined) {
    states = new Set();
    byExpression.set(value, states);
  }
  if (states.has(state)) {
    return true;
  }
  states.add(state);
  return false;
}

/** Encodes the member projection carried by `origin` without ambiguity across key boundaries. */
function originStateKey(origin: Origin): string {
  return origin.keys.map((key) => `${key.length}:${key}`).join(',');
}

/** Whether the value itself, or the known proxy member of a revocable pair, is a Proxy. */
function isProxy(at: Origin): boolean {
  const { context, keys, value } = at;
  if (!isCallExpression(value) && !isNewExpression(value)) {
    return false;
  }
  const path = sourcePath(value.expression, context);
  return (
    (isNewExpression(value) && path === 'Proxy' && keys.length === 0) ||
    (isCallExpression(value) &&
      path === 'Proxy.revocable' &&
      (keys.length === 0 || (keys.length === 1 && keys[0] === 'proxy')))
  );
}

/** The values an expression can return, without executing its source or deferred bodies. */
function originsOf(at: Origin): readonly Origin[] {
  const { keys, value } = at;
  if (isIdentifier(value)) {
    return namedOrigins(value, at);
  }
  if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const key = isPropertyAccessExpression(value)
      ? value.name.text
      : originKey(value.argumentExpression, at.context);
    return key === undefined ? [] : [{ ...at, keys: [key, ...keys], value: value.expression }];
  }
  if (isConditionalExpression(value)) {
    const condition = sourceValue(value.condition, at.context);
    const truth = literalTruth(condition);
    const values =
      truth === undefined
        ? [value.whenTrue, value.whenFalse]
        : [truth ? value.whenTrue : value.whenFalse];
    return values.map((each) => ({ ...at, value: each }));
  }
  if (isBinaryExpression(value)) {
    if (value.operatorToken.kind === SyntaxKind.CommaToken) {
      return [{ ...at, value: value.right }];
    }
    return logicalOrigins(value.left, value.right, value.operatorToken.kind, at);
  }
  return containerOrigins(at);
}

/** Containers and source calls retain the origins of values they actually return or store. */
function containerOrigins(at: Origin): readonly Origin[] {
  const { keys, value } = at;
  if (isCallExpression(value)) {
    return callOrigins(value, at);
  }
  if (isObjectLiteralExpression(value)) {
    return objectOrigins(value, at);
  }
  if (isArrayLiteralExpression(value)) {
    const [key, ...rest] = keys;
    const expanded = argumentOrigins(
      value.elements.map((each) => ({ ...at, keys: [], value: each })),
    );
    if (expanded === undefined) {
      return [];
    }
    const elements = key === undefined ? expanded : [expanded[Number(key)]];
    return elements.flatMap((each) =>
      each === undefined ? [] : [{ ...each, keys: [...each.keys, ...rest] }],
    );
  }
  return [];
}

/** A parameter's actual argument or a lexical constant, with the argument's original scope. */
function namedOrigins(name: Identifier, at: Origin): readonly Origin[] {
  const binding = parameterFrame(name, at);
  if (binding !== undefined) {
    const { frame, index, parameter } = binding;
    if (!isIdentifier(parameter.name)) {
      return [];
    }
    const replaced = parameterValue(frame.fn, parameter.name, name);
    if (replaced !== undefined) {
      return [{ ...at, value: replaced.value }];
    }
    const rest = parameter.dotDotDotToken !== undefined;
    if (frame.given === undefined || bindingChanged(frame.fn, parameter.name, rest)) {
      return [];
    }
    if (rest) {
      return restOrigins(frame.given.slice(index), at.keys);
    }
    const given = frame.given[index];
    if (given !== undefined) {
      return [{ ...given, keys: [...given.keys, ...at.keys] }];
    }
    return parameter.initializer === undefined ? [] : [{ ...at, value: parameter.initializer }];
  }
  const held = heldConstant(name, at.context);
  if (
    held === undefined ||
    (isObjectLiteralExpression(unwrapped(held)) && writtenBefore(name, at.context))
  ) {
    return [];
  }
  return [{ ...at, value: held }];
}

/** The nearest active source invocation whose lexical formal this identifier reads. */
function parameterFrame(name: Identifier, at: Origin): ParameterFrame | undefined {
  for (const frame of at.context.frames.toReversed()) {
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

/** A possibly reassigned parameter no longer proves that its original argument is returned. */
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

/** A source call's returned expressions, binding ordinary parameters to their actual arguments. */
function callOrigins(call: CallExpression, at: Origin): readonly Origin[] {
  if (at.context.calls.has(call)) {
    return [];
  }
  const path = sourcePath(call.expression, at.context);
  if (path !== undefined && SCALARS.has(path)) {
    return [];
  }
  const target = at.context.functionOf?.(call.expression) ?? metadataCallee(call.expression);
  if (target === undefined || !isAnswering(target) || answersLater(target)) {
    return [];
  }
  const given = argumentOrigins(call.arguments.map((value) => ({ ...at, keys: [], value })));
  const context: Context = {
    ...at.context,
    calls: new Set([...at.context.calls, call]),
    frames: [...at.context.frames, { fn: target, given }],
  };
  return returnedBy(target).map((value) => ({ ...at, context, seen: new Set(), value }));
}

/** Known tuple spreads expand in argument order; an unknown iterator leaves arity unproven. */
function argumentOrigins(given: readonly Origin[]): readonly Origin[] | undefined {
  const pending = given.toReversed();
  const result: Origin[] = [];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (!isSpreadElement(next.value)) {
      result.push(next);
      continue;
    }
    const expanded = spreadOrigins({ ...next, value: next.value.expression });
    if (expanded === undefined) {
      return undefined;
    }
    pending.push(...expanded.toReversed());
  }
  return result;
}

/** A literal tuple or an unchanged rest array, retaining each element's original context. */
function spreadOrigins(origin: Origin): readonly Origin[] | undefined {
  let at = origin;
  const seen = new Set<Expression>();
  for (;;) {
    const value = unwrapped(at.value);
    if (seen.has(value) || at.seen.has(value)) {
      return undefined;
    }
    seen.add(value);
    const current = { ...at, value };
    if (isArrayLiteralExpression(value) && at.keys.length === 0) {
      const tuple = { ...current, seen: new Set([...at.seen, ...seen]) };
      return value.elements.map((each) => ({ ...tuple, keys: [], value: each }));
    }
    const bound = isIdentifier(value) ? spreadBinding(value, at) : undefined;
    if (bound !== undefined) {
      return bound.values;
    }
    const following = originsOf(current);
    const [next] = following;
    if (next === undefined || following.length !== 1 || isCallExpression(value)) {
      return undefined;
    }
    at = next;
  }
}

/** A rest array's entries, or an explicitly unknown binding after a prior write/evaluation. */
function spreadBinding(
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
  const binding = parameterFrame(name, at);
  if (binding?.parameter.dotDotDotToken === undefined || at.keys.length > 0) {
    return undefined;
  }
  const { frame, index, parameter } = binding;
  return isIdentifier(parameter.name) && !bindingChanged(frame.fn, parameter.name, true)
    ? { values: frame.given?.slice(index) }
    : {};
}

/** Own data entries are measured; an accessor is executed only when its member is selected. */
function objectOrigins(object: ObjectLiteralExpression, at: Origin): readonly Origin[] {
  const [key, ...rest] = at.keys;
  if (key === undefined) {
    return dataOrigins(object, at);
  }
  let setter = false;
  for (const property of object.properties.toReversed()) {
    if (isSpreadAssignment(property)) {
      return [];
    }
    const named = propertyKey(property.name, at.context);
    if (named === undefined) {
      return [];
    }
    if (named !== key) {
      continue;
    }
    if (isSetAccessorDeclaration(property)) {
      setter = true;
      continue;
    }
    if (isGetAccessorDeclaration(property)) {
      return returnedBy(property).map((value) => ({ ...at, keys: rest, value }));
    }
    return setter ? [] : dataProperty(property, { ...at, keys: rest });
  }
  return [];
}

/** Only surviving data entries are traversed; accessors are not invoked by measurement. */
function dataOrigins(object: ObjectLiteralExpression, at: Origin): readonly Origin[] {
  const found: Origin[] = [];
  const seen = new Set<string>();
  for (const property of object.properties.toReversed()) {
    if (isSpreadAssignment(property)) {
      break;
    }
    const key = propertyKey(property.name, at.context);
    if (key === undefined) {
      break;
    }
    if (!seen.has(key)) {
      found.push(...dataProperty(property, at));
      seen.add(key);
    }
  }
  return found;
}

/** A data entry's value, rather than a deferred accessor or method body. */
function dataProperty(property: ObjectLiteralElementLike, at: Origin): readonly Origin[] {
  if (isPropertyAssignment(property)) {
    return [{ ...at, value: property.initializer }];
  }
  return isShorthandPropertyAssignment(property) && isIdentifier(property.name)
    ? [{ ...at, value: property.name }]
    : [];
}

/** A logical operator's possible result values, respecting known skipped operands. */
function logicalOrigins(
  left: Expression,
  right: Expression,
  kind: SyntaxKind,
  at: Origin,
): readonly Origin[] {
  if (
    ![
      SyntaxKind.AmpersandAmpersandToken,
      SyntaxKind.BarBarToken,
      SyntaxKind.QuestionQuestionToken,
    ].includes(kind)
  ) {
    return [];
  }
  const value = sourceValue(left, at.context);
  const truth = literalTruth(value);
  if (truth !== undefined && kind !== SyntaxKind.QuestionQuestionToken) {
    const choosesRight = kind === SyntaxKind.AmpersandAmpersandToken ? truth : !truth;
    return [{ ...at, value: choosesRight ? right : left }];
  }
  return [left, right].map((each) => ({ ...at, value: each }));
}
