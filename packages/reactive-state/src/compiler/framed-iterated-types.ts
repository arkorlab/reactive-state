import {
  type Expression,
  isCallExpression,
  isElementAccessExpression,
  isPropertyAccessExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { type FrameTypeSelection, frameTypeOf } from './framed-bindings.ts';
import { DEFAULT_ITERATOR, iteratorMemberName } from './framed-iterator-guards.ts';
import { namesLocalMemberTypeArgument } from './local-type-member-arguments.ts';
import { namesLocalMemberArrayType, namesLocalMemberType } from './local-type-reading.ts';

/** The native types whose iteration yields their elements, and a Map's, its `[key, value]` entries. */
const SETS: ReadonlySet<string> = new Set(['ReadonlySet', 'Set']);
const MAPS: ReadonlySet<string> = new Set(['Map', 'ReadonlyMap']);
const ITERABLES: ReadonlySet<string> = new Set(['Iterable', 'IterableIterator']);

/** A place of an iteration, as an array pattern or a `for … of` header numbers it. */
const POSITION = /^(?:0|[1-9]\d*)$/u;

/** The slots of an entry: its key and its value. */
const SLOT = /^[01]$/u;

/**
 * Whether what a declared Set, Map or Iterable yields at a place of its iteration may be one of
 * `names`, as the element of a declared array does where the code reads it by that number: the
 * first of `keys` is the place, and a Map's entry is read by its slot after it (`['0', '1']` is the
 * value of its first entry). The type is the one a name, or a member of one, is written with
 * (`frameTypeOf`); a member of what is yielded is not read.
 */
export function namesIteratedType(
  selected: FrameTypeSelection,
  keys: readonly string[],
  names: ReadonlySet<string>,
): boolean {
  const [position, slot, ...rest] = keys;
  if (position === undefined || !POSITION.test(position) || rest.length > 0) return false;
  const argument = (nativeNames: ReadonlySet<string>, index: number): boolean => {
    return namesLocalMemberTypeArgument(
      selected.type,
      selected.keys,
      { nativeNames, index },
      names,
    );
  };
  if (slot === undefined) return argument(SETS, 0) || argument(ITERABLES, 0);
  return SLOT.test(slot) && argument(MAPS, Number(slot));
}

/**
 * Whether the first value a native iterator of a declared list, Set or Map yields, at the path read
 * on in it, may be one of `names`, by what the type declares: a list's element, a Set's, a Map's key or
 * value; an entry's slot, a list's index excepted, is read by its number. `method` is `values`,
 * `keys`, `entries` or `default`: the default iterator yields what `values` does, a Map's what
 * `entries` does; the keys of a list are numbers.
 */
function namesYieldedType(
  selected: FrameTypeSelection,
  method: string,
  path: readonly string[],
  names: ReadonlySet<string>,
): boolean {
  const [slot, ...rest] = path;
  const element = (inner: readonly string[]): boolean => {
    return inner.length === 0
      ? namesLocalMemberArrayType(selected.type, selected.keys, names)
      : namesLocalMemberType(selected.type, [...selected.keys, '0', ...inner], names);
  };
  const iterated = (keys: readonly string[]): boolean => namesIteratedType(selected, keys, names);
  // A member of what `keys` or `values` yields, or of an entry's slot, is no entry slot of its own.
  if (method === 'keys') return path.length === 0 && (iterated(['0']) || iterated(['0', '0']));
  if (method === 'values')
    return element(path) || (path.length === 0 && (iterated(['0']) || iterated(['0', '1'])));
  if (method === 'default') return element(path) || iterated(['0', ...path]);
  if (method !== 'entries') return false;
  return (
    iterated(['0', ...path]) ||
    (slot === '1' && element(rest)) ||
    ((slot === '0' || slot === '1') && rest.length === 0 && iterated(['0']))
  );
}

/** The methods of a native collection that acquire an iterator, and the default one. */
const ACQUIRING: ReadonlySet<string> = new Set(['default', 'entries', 'keys', 'values']);

/**
 * Whether what the native iterator `node` acquires of a collection written with a type yields, at
 * the path read on in it, may be one of `names` (`namesYieldedType`): `input.values()`,
 * `input[Symbol.iterator]()`, of a name or a member of one; no other call is read. A receiver
 * `written` answers for is not asked.
 */
export function namesAcquiredType(
  node: Expression,
  path: readonly string[],
  names: ReadonlySet<string>,
  written?: (receiver: Expression) => boolean,
): boolean {
  const call = unwrapped(node);
  if (!isCallExpression(call)) return false;
  const member = unwrapped(call.expression);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return false;
  const name = iteratorMemberName(member);
  const method = name === DEFAULT_ITERATOR ? 'default' : name;
  if (method === undefined || !ACQUIRING.has(method) || written?.(member.expression) === true)
    return false;
  const selected = frameTypeOf(member.expression);
  return selected !== undefined && namesYieldedType(selected, method, path, names);
}

/**
 * Whether the elements a written array, or the places a written Set, Map or Iterable gives where it
 * is spread, may be one of `names`, at the index the code selects (`undefined`: any): a spread of a
 * Set is read as the list it makes, and its first place is its elements.
 */
export function namesTypedElements(
  value: Expression,
  index: number | undefined,
  names: ReadonlySet<string>,
): boolean {
  const type = frameTypeOf(value);
  return (
    type !== undefined &&
    (namesLocalMemberArrayType(type.type, type.keys, names, { index }) ||
      namesIteratedType(type, ['0'], names))
  );
}
