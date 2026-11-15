import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isCallExpression,
  isExpression,
  isIdentifier,
  isNewExpression,
  isOmittedExpression,
  isSourceFile,
  isSpreadElement,
  isVariableDeclaration,
  type Node,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedSourceValues } from './framed-sources.ts';

/** Native toSpliced slots retain original payloads or the original inserted argument node. */

interface SpliceInput {
  readonly call: CallExpression;
  readonly keys: readonly string[];
  readonly receiver: Expression;
  readonly given: readonly Expression[] | undefined;
  readonly applied?: Expression;
  readonly length: number;
  readonly relative: boolean;
}

interface NativeBounds {
  readonly start: (
    value: Expression | undefined,
    length: number,
    fallback: number,
  ) => number | undefined;
  readonly count: (value: Expression | undefined) => number | undefined;
}

interface SpliceWindow {
  readonly start: number;
  readonly removed: number;
  readonly inserted: readonly Expression[];
}

interface SpliceOrigin {
  readonly of: Expression;
  readonly keys: readonly string[];
  readonly tail: readonly string[];
  readonly slot?: string;
  readonly references: readonly Identifier[];
}

/** Canonical integer keys select copied slots; negative keys apply only to relative at reads. */
export function middlewareCopySlotIndex(
  key: string | undefined,
  relative: boolean,
): number | undefined {
  if (key === undefined) return undefined;
  const index = Number(key);
  return String(index) === key && Number.isSafeInteger(index) && (relative || index >= 0)
    ? index
    : undefined;
}

/** Original argument count distinguishes cloning, suffix removal and explicit undefined deletion. */
export function middlewareArraySplice(
  input: SpliceInput,
  bounds: NativeBounds,
): readonly SpliceOrigin[] {
  const index = middlewareCopySlotIndex(input.keys[0], input.relative);
  if (index === undefined) return [];
  const { call, given, length } = input;
  const prefix = given === undefined ? undefined : framedArgumentPrefix(call, given, Infinity);
  if (prefix === undefined || prefix.unknown || prefix.alternatives !== undefined)
    return unknownSpliceOrigins(input, index);
  const args = prefix.values;
  const start = bounds.start(args[0], length, 0);
  const count = args.length < 2 ? undefined : bounds.count(args[1]);
  if (start === undefined || (count === undefined && args.length >= 2))
    return unknownSpliceOrigins(input, index);
  let removed = 0;
  if (args.length === 1) removed = length - start;
  else if (args.length >= 2) removed = Math.min(Math.max(count ?? 0, 0), length - start);
  return selectedSpliceSlot(input, index, { start, removed, inserted: args.slice(2) });
}

/** Fixed copied positions distinguish retained slots from the actual inserted payload nodes. */
function selectedSpliceSlot(
  input: SpliceInput,
  index: number,
  window: SpliceWindow,
): readonly SpliceOrigin[] {
  const { receiver, keys, length, relative } = input;
  const { start, removed, inserted } = window;
  const tail = keys.slice(1);
  const copiedLength = length - removed + inserted.length;
  const offset = relative && index < 0 ? copiedLength + index : index;
  if (offset < 0 || offset >= copiedLength) return [];
  const slot = String(offset);
  if (offset >= start && offset < start + inserted.length) {
    const value = inserted[offset - start];
    return value === undefined ? [] : [{ ...elementOrigin(value, tail), slot }];
  }
  const position = offset < start ? offset : offset - inserted.length + removed;
  return [
    {
      of: receiver,
      keys: [String(position), ...tail],
      tail,
      slot,
      references: literalOwners(receiver),
    },
  ];
}

/** Opaque bounds or spreads retain both the receiver array and every candidate inserted payload. */
function unknownSpliceOrigins(input: SpliceInput, index: number): readonly SpliceOrigin[] {
  const tail = input.keys.slice(1);
  const slot = index < 0 ? undefined : String(index);
  const origins = [
    wholeOrigin(input.receiver, tail),
    ...insertedOrigins(input.call, input.given, input.applied, tail),
  ];
  return slot === undefined ? origins : origins.map((origin) => ({ ...origin, slot }));
}

/** Candidate inserted values come from arguments past the two bounds or unresolved spread tuples. */
function insertedOrigins(
  call: CallExpression,
  given: readonly Expression[] | undefined,
  applied: Expression | undefined,
  tail: readonly string[],
): readonly SpliceOrigin[] {
  if (given === undefined)
    return applied === undefined ? [] : spreadOrigins(applied, tail, new Set());
  const prefix = framedArgumentPrefix(call, given, Infinity);
  if (!prefix.unknown && prefix.alternatives === undefined)
    return prefix.values.slice(2).map((value) => elementOrigin(value, tail));
  return mixedArgumentOrigins(call, given, tail);
}

/** Arguments after an unresolved spread may land in the inserted range regardless of written index. */
function mixedArgumentOrigins(
  call: CallExpression,
  given: readonly Expression[],
  tail: readonly string[],
): readonly SpliceOrigin[] {
  const origins: SpliceOrigin[] = [];
  const state = { position: 0, afterSpread: false };
  for (const argument of given) {
    if (!isSpreadElement(argument)) {
      appendInserted(origins, [argument], state, tail);
      continue;
    }
    const expanded = framedArgumentPrefix(call, [argument], Infinity);
    if (!expanded.unknown && expanded.alternatives === undefined) {
      appendInserted(origins, expanded.values, state, tail);
      continue;
    }
    state.afterSpread = true;
    origins.push(...spreadOrigins(argument.expression, tail, new Set()));
  }
  return origins;
}

/** Only argument slots at or after index two, or shifted past an opaque spread, insert items. */
function appendInserted(
  origins: SpliceOrigin[],
  values: readonly Expression[],
  state: { position: number; afterSpread: boolean },
  tail: readonly string[],
): void {
  for (const value of values) {
    if (state.afterSpread || state.position >= 2) origins.push(elementOrigin(value, tail));
    state.position += 1;
  }
}

/** Unresolved spread expressions keep whole array containers and literal branch elements. */
function spreadOrigins(
  expression: Expression,
  tail: readonly string[],
  seen: Set<Node>,
): readonly SpliceOrigin[] {
  const value = unwrapped(expression);
  if (seen.has(value)) return [];
  seen.add(value);
  if (isArrayLiteralExpression(value)) return arraySpreadOrigins(value.elements, tail, seen);
  const branches = framedSourceValues(value);
  if (branches !== undefined)
    return branches.flatMap((branch) => spreadOrigins(branch, tail, seen));
  return [wholeOrigin(expression, tail)];
}

/** Literal spread arrays contribute each non-hole element and recurse into nested spreads. */
function arraySpreadOrigins(
  elements: readonly Expression[],
  tail: readonly string[],
  seen: Set<Node>,
): readonly SpliceOrigin[] {
  const origins: SpliceOrigin[] = [];
  for (const element of elements) {
    if (isOmittedExpression(element)) continue;
    if (isSpreadElement(element)) origins.push(...spreadOrigins(element.expression, tail, seen));
    else origins.push(elementOrigin(element, tail));
  }
  return origins;
}

/** An inserted argument supplies the selected element directly under the remaining member tail. */
function elementOrigin(of: Expression, tail: readonly string[]): SpliceOrigin {
  return { of, keys: tail, tail, references: literalOwners(of) };
}

/** An array container with an unknown selected slot retains its whole collection identity. */
function wholeOrigin(expression: Expression, tail: readonly string[]): SpliceOrigin {
  const of = unwrapped(expression);
  return { of, keys: [], tail, references: literalOwners(of) };
}

/** Original literal descendants retain their lexical collection owner, stopping at call or callable boundaries. */
function literalOwners(value: Expression): readonly Identifier[] {
  let within: Node = value;
  for (let node: Node = value.parent; !isSourceFile(node); within = node, node = node.parent) {
    if (isAnswering(node) || isCallExpression(node) || isNewExpression(node)) return [];
    if (isVariableDeclaration(node) && isExpression(within) && node.initializer === within)
      return isIdentifier(node.name) ? [node.name] : [];
  }
  return [];
}
