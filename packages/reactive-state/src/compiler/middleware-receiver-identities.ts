import {
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadElement,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { memberPath } from './exported-values.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { framedAssignedValues } from './framed-writes.ts';
import { declarationOf } from './framed.ts';

/** Bounded receiver-identity alias and literal source matching across lexical reassignments. */

const MAX_RECEIVER_KEYS = 16;

export interface ReceiverResolutionContext {
  readonly sourceOf: (expression: Expression) => Expression | undefined;
  readonly memberOf: (value: Expression, name: string) => Expression | undefined;
}

interface ReceiverWork {
  readonly expression: Expression;
  readonly keys: readonly string[];
  readonly saturated: boolean;
}

interface ReceiverIdentitySet {
  readonly ambiguous: boolean;
  readonly bindings: ReadonlySet<string>;
  readonly literals: ReadonlySet<Expression>;
}

interface ReceiverState {
  readonly bindings: Set<string>;
  readonly literals: Set<Expression>;
  readonly memberOf: (value: Expression, name: string) => Expression | undefined;
  opaque: boolean;
  overflow: boolean;
  readonly pending: ReceiverWork[];
  readonly seen: Set<string>;
}

/** Matches two receiver expressions across syntax, literal sources, mutable aliases, and patterns. */
export function sameSelectorReceiver(
  left: Expression,
  right: Expression,
  context: ReceiverResolutionContext,
): boolean {
  const first = unwrapped(left);
  const second = unwrapped(right);
  if (first === second) return true;
  const leftSet = collectReceiverIdentities(first, context);
  const rightSet = collectReceiverIdentities(second, context);
  if (leftSet.ambiguous || rightSet.ambiguous) return true;
  for (const literal of rightSet.literals) {
    if (leftSet.literals.has(literal)) return true;
  }
  for (const key of rightSet.bindings) {
    if (leftSet.bindings.has(key)) return true;
  }
  return false;
}

/** Collects reachable literal sources and `(declarationPos:path)` keys across alias chains. */
function collectReceiverIdentities(
  expression: Expression,
  context: ReceiverResolutionContext,
): ReceiverIdentitySet {
  const state: ReceiverState = {
    bindings: new Set<string>(),
    literals: new Set<Expression>(),
    memberOf: context.memberOf,
    opaque: false,
    overflow: false,
    pending: [{ expression, keys: [], saturated: false }],
    seen: new Set<string>(),
  };
  for (let item = state.pending.pop(); item !== undefined; item = state.pending.pop()) {
    const value = unwrapped(item.expression);
    if (item.keys.length === 0) recordDirectSource(value, context.sourceOf, state.literals);
    const path = memberPath(value);
    const keys = [...path.keys, ...item.keys];
    if (isIdentifier(path.root)) stepIdentifierReceiver(path.root, keys, item.saturated, state);
    else stepLiteralReceiver(path.root, keys, item.saturated, state);
  }
  return {
    ambiguous: state.overflow && state.opaque,
    bindings: state.bindings,
    literals: state.literals,
  };
}

/** Adds any resolved literal container for a zero-offset receiver candidate. */
function recordDirectSource(
  value: Expression,
  sourceOf: (expression: Expression) => Expression | undefined,
  literals: Set<Expression>,
): void {
  const resolved = sourceOf(value);
  if (resolved !== undefined) literals.add(resolved);
}

/** Records a lexical binding key and queues its initializer and assigned source values. */
function stepIdentifierReceiver(
  root: Identifier,
  keys: readonly string[],
  saturated: boolean,
  state: ReceiverState,
): void {
  const selected = frameBindingOf(root);
  const declared = selected?.binding ?? declarationOf(root);
  if (declared === undefined) {
    state.opaque = true;
    return;
  }
  const fullKeys = [...(selected?.keys ?? []), ...keys];
  if (fullKeys.length > MAX_RECEIVER_KEYS) {
    state.overflow = true;
    return;
  }
  const key = `${String(declared.pos)}:${fullKeys.join('.')}`;
  state.bindings.add(key);
  if (selected === undefined) {
    state.opaque = true;
    return;
  }
  const nextSaturated = saturated || fullKeys.length === MAX_RECEIVER_KEYS;
  const seenKey = `${key}:${nextSaturated ? '1' : '0'}`;
  if (state.seen.has(seenKey)) return;
  state.seen.add(seenKey);
  if (selected.binding.initializer === undefined) state.opaque = true;
  else {
    state.pending.push({
      expression: selected.binding.initializer,
      keys: fullKeys,
      saturated: nextSaturated,
    });
  }
  if (selected.keys.length === 0) {
    for (const assigned of framedAssignedValues(root)) {
      state.pending.push({ expression: assigned, keys, saturated });
    }
  }
}

/** Steps pending member keys through literal containers or records the terminal literal node. */
function stepLiteralReceiver(
  root: Expression,
  keys: readonly string[],
  saturated: boolean,
  state: ReceiverState,
): void {
  if (!plainReceiverLiteral(root)) state.opaque = true;
  const [first, ...rest] = keys;
  if (first === undefined) {
    if (saturated && nonEmptyReceiverLiteral(root)) state.opaque = true;
    state.literals.add(root);
    return;
  }
  const next = state.memberOf(root, first);
  if (next !== undefined) state.pending.push({ expression: next, keys: rest, saturated });
}

/** Verifies `value` is a static spread-free array or identifier-keyed data object literal. */
function plainReceiverLiteral(value: Expression): boolean {
  if (isArrayLiteralExpression(value)) {
    return value.elements.every((element) => !isSpreadElement(element));
  }
  if (!isObjectLiteralExpression(value)) return false;
  return value.properties.every((field) => {
    return (
      (isPropertyAssignment(field) || isShorthandPropertyAssignment(field)) &&
      isIdentifier(field.name)
    );
  });
}

/** Checks whether a terminal literal container at max key depth still holds inner members. */
function nonEmptyReceiverLiteral(value: Expression): boolean {
  return (
    (isArrayLiteralExpression(value) && value.elements.length > 0) ||
    (isObjectLiteralExpression(value) && value.properties.length > 0)
  );
}
