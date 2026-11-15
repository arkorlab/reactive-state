import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { answersLater, isAnswering, returnedBy } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { metadataCallee } from './input-callees.ts';
import { parameterFrame, parameterOrigins, spreadBinding } from './proxy-parameters.ts';
import {
  type Context,
  heldConstant,
  literalTruth,
  objectOrigins,
  type Origin,
  originKey,
  type ProxyReading,
  sourcePath,
  sourceValue,
  writtenBefore,
} from './proxy-values.ts';

export type { ProxyReading } from './proxy-values.ts';

/** Native calls whose result cannot retain the identity of an object they consume. */
const SCALARS: ReadonlySet<string> = new Set(['Boolean', 'JSON.stringify', 'Number', 'String']);

/** The source Proxy in a value's possible origins; no proof is made of an unknown call's result. */
export function proxyOrigin(
  values: readonly Expression[],
  reading: ProxyReading = {},
): Node | undefined {
  const context: Context = { ...reading, calls: new Set(), frames: [], spreadKeys: new Map() };
  const visited = new WeakMap<Context, Map<Expression, Set<string>>>();
  const pending: Origin[] = [
    ...values.map((value) => ({ context, keys: [], seen: new Set<Expression>(), value })),
    ...callableReturnOrigins(context),
  ];
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

/** Seeds return expressions of exported callables inside each callable's own parameter frame. */
function callableReturnOrigins(base: Context): readonly Origin[] {
  return (base.callables ?? []).flatMap((fn) => {
    const context: Context = { ...base, frames: [{ fn, given: undefined }] };
    return returnedBy(fn).map((value) => ({ context, keys: [], seen: new Set(), value }));
  });
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

/** Encodes the member projection and spread state carried by `origin` unambiguously. */
function originStateKey(origin: Origin): string {
  const path = origin.keys.map((key) => `${key.length}:${key}`).join(',');
  if (origin.spread !== true) {
    return path;
  }
  const skipped =
    origin.excluded === undefined
      ? ''
      : [...origin.excluded]
          .toSorted()
          .map((key) => `${key.length}:${key}`)
          .join(',');
  return `${path}|spread|${skipped}`;
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
      value.elements.map((each) => ({
        ...at,
        excluded: undefined,
        keys: [],
        spread: undefined,
        value: each,
      })),
    );
    if (expanded === undefined) {
      return [];
    }
    const elements = key === undefined ? expanded : [expanded[Number(key)]];
    return elements.flatMap((each) =>
      each === undefined
        ? []
        : [
            {
              ...each,
              excluded: key === undefined ? undefined : at.excluded,
              keys: [...each.keys, ...rest],
              spread: key === undefined ? undefined : at.spread,
            },
          ],
    );
  }
  return [];
}

/** A parameter's actual argument or a lexical constant, with the argument's original scope. */
function namedOrigins(name: Identifier, at: Origin): readonly Origin[] {
  const binding = parameterFrame(name, at.context.frames);
  if (binding !== undefined) {
    return parameterOrigins(name, binding, at);
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
  const given = argumentOrigins(
    call.arguments.map((value) => ({
      ...at,
      excluded: undefined,
      keys: [],
      spread: undefined,
      value,
    })),
  );
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
