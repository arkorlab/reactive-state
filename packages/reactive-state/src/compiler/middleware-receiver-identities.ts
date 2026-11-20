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
import { framedSourceValues } from './framed-sources.ts';
import { framedAssignedSources } from './framed-writes.ts';
import { declarationOf } from './framed.ts';

/** Bounded receiver-identity alias and literal source matching across lexical reassignments. */

const MAX_RECEIVER_KEYS = 16;
const MAX_RECEIVER_STEPS = 256;

export interface ReceiverResolutionContext {
  readonly sourceOf: (expression: Expression) => Expression | undefined;
  readonly memberOf: (value: Expression, name: string) => Expression | undefined;
}

interface ReceiverWork {
  readonly expression: Expression;
  readonly keys: readonly string[];
  readonly truncated: boolean;
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

interface ClampedKeys {
  readonly bounded: readonly string[];
  readonly truncated: boolean;
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
    pending: [{ expression, keys: [], truncated: false }],
    seen: new Set<string>(),
  };
  let steps = 0;
  for (let item = state.pending.pop(); item !== undefined; item = state.pending.pop()) {
    steps += 1;
    if (steps > MAX_RECEIVER_STEPS) {
      state.overflow = true;
      state.opaque = true;
      break;
    }
    const value = unwrapped(item.expression);
    if (item.keys.length === 0 && !item.truncated) {
      recordDirectSource(value, context.sourceOf, state.literals);
    }
    const path = memberPath(value);
    const keys = [...path.keys, ...item.keys];
    if (isIdentifier(path.root)) stepIdentifierReceiver(path.root, keys, item.truncated, state);
    else stepLiteralReceiver(path.root, keys, item.truncated, state);
  }
  return {
    ambiguous: state.overflow && state.opaque,
    bindings: state.bindings,
    literals: state.literals,
  };
}

/** Adds any resolved literal container for an exact zero-offset receiver candidate. */
function recordDirectSource(
  value: Expression,
  sourceOf: (expression: Expression) => Expression | undefined,
  literals: Set<Expression>,
): void {
  const resolved = sourceOf(value);
  if (resolved !== undefined) literals.add(resolved);
}

/** Clamps `keys` to `MAX_RECEIVER_KEYS` while recording path overflow and key truncation. */
function clampReceiverKeys(
  keys: readonly string[],
  truncated: boolean,
  state: ReceiverState,
): ClampedKeys {
  if (keys.length > MAX_RECEIVER_KEYS) {
    state.overflow = true;
    return { bounded: keys.slice(0, MAX_RECEIVER_KEYS), truncated: true };
  }
  return { bounded: keys, truncated };
}

/** Records a lexical binding key and queues its initializer and assigned source values. */
function stepIdentifierReceiver(
  root: Identifier,
  keys: readonly string[],
  truncated: boolean,
  state: ReceiverState,
): void {
  const selected = frameBindingOf(root);
  const declared = selected?.binding ?? declarationOf(root);
  const fullKeys = [...(selected?.keys ?? []), ...keys];
  const clamped = clampReceiverKeys(fullKeys, truncated, state);
  if (declared === undefined) {
    state.opaque = true;
    return;
  }
  const key = `${String(declared.pos)}:${clamped.bounded.join('.')}`;
  if (!clamped.truncated) state.bindings.add(key);
  if (selected === undefined) {
    state.opaque = true;
    return;
  }
  const seenKey = `${key}:${clamped.truncated ? '1' : '0'}`;
  if (state.seen.has(seenKey)) return;
  state.seen.add(seenKey);
  if (selected.binding.initializer === undefined) state.opaque = true;
  else {
    state.pending.push({
      expression: selected.binding.initializer,
      keys: clamped.bounded,
      truncated: clamped.truncated,
    });
  }
  for (const assigned of framedAssignedSources(root)) {
    const assignedClamped = clampReceiverKeys([...assigned.keys, ...keys], truncated, state);
    state.pending.push({
      expression: assigned.value,
      keys: assignedClamped.bounded,
      truncated: assignedClamped.truncated,
    });
  }
}

/** Steps pending member keys through branch or literal containers, marking truncated survivors opaque. */
function stepLiteralReceiver(
  root: Expression,
  keys: readonly string[],
  truncated: boolean,
  state: ReceiverState,
): void {
  const branches = framedSourceValues(root);
  if (branches !== undefined) {
    for (const branch of branches) {
      state.pending.push({ expression: branch, keys, truncated });
    }
    return;
  }
  if (!plainReceiverLiteral(root)) {
    state.opaque = true;
    if (keys.length > MAX_RECEIVER_KEYS) state.overflow = true;
  }
  const [first, ...rest] = keys;
  if (first === undefined) {
    if (truncated) state.opaque = true;
    else state.literals.add(root);
    return;
  }
  const next = state.memberOf(root, first);
  if (next !== undefined) state.pending.push({ expression: next, keys: rest, truncated });
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
