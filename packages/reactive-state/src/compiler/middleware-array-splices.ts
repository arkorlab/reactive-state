import { type CallExpression, type Expression } from 'typescript/ast';

import { framedArgumentPrefix } from './framed-keys.ts';

/** Native toSpliced slots retain original payloads or the original inserted argument node. */

interface SpliceInput {
  readonly call: CallExpression;
  readonly keys: readonly string[];
  readonly receiver: Expression;
  readonly given: readonly Expression[] | undefined;
  readonly length: number;
  readonly index: number;
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

interface Projection {
  readonly of: Expression;
  readonly keys: readonly string[];
  readonly tail: readonly string[];
  readonly slot?: string;
}

/** Original argument count distinguishes cloning, suffix removal and explicit undefined deletion. */
export function middlewareArraySplice(
  input: SpliceInput,
  bounds: NativeBounds,
): Projection | undefined {
  const { call, given, receiver, keys, length, index } = input;
  const prefix = given === undefined ? undefined : framedArgumentPrefix(call, given, Infinity);
  const tail = keys.slice(1);
  const possible = { of: receiver, keys: [], tail };
  if (prefix === undefined || prefix.unknown || prefix.alternatives !== undefined)
    return index < 0 ? possible : { ...possible, slot: String(index) };
  const args = prefix.values;
  const start = bounds.start(args[0], length, 0);
  const count = args.length < 2 ? undefined : bounds.count(args[1]);
  if (start === undefined || (count === undefined && args.length >= 2))
    return index < 0 ? possible : { ...possible, slot: String(index) };
  let removed = 0;
  if (args.length === 1) removed = length - start;
  else if (args.length >= 2) removed = Math.min(Math.max(count ?? 0, 0), length - start);
  return selectedSpliceSlot(input, start, removed, args.slice(2));
}

/** Fixed copied positions distinguish retained slots from the actual inserted payload nodes. */
function selectedSpliceSlot(
  input: SpliceInput,
  start: number,
  removed: number,
  inserted: readonly Expression[],
): Projection | undefined {
  const { receiver, keys, length, index, relative } = input;
  const tail = keys.slice(1);
  const copiedLength = length - removed + inserted.length;
  const offset = relative && index < 0 ? copiedLength + index : index;
  if (offset < 0 || offset >= copiedLength) return undefined;
  if (offset >= start && offset < start + inserted.length) {
    const value = inserted[offset - start];
    return value === undefined ? undefined : { of: value, keys: tail, tail, slot: String(offset) };
  }
  const position = offset < start ? offset : offset - inserted.length + removed;
  return { of: receiver, keys: [String(position), ...tail], tail, slot: String(offset) };
}
