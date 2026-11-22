import {
  type ArrayLiteralExpression,
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isConditionalExpression,
  isNewExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isSpreadElement,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPath } from './global-answers.ts';
import {
  anyAliasRead,
  ASSIGNING,
  checkPrefixRead,
  isConstIdentifier,
  isIndex,
  isShrunkAt,
  lacksEntryAt,
  memberChain,
  pathsOverlap,
  type Target,
  unreplacedAt,
  writtenAt,
} from './local-write-paths.ts';
import { lockedAt } from './throw-deletes.ts';

/**
 * Target slot classification, deletions, `Object.assign` sources, and direct assignments on local
 * constants (`local-writes.ts`).
 */

/** A value the code puts into a constant: an object's entry, which may hold `undefined`, or an element. */
export interface Put {
  readonly value: Expression;
  readonly entry: boolean;
  readonly inside: Expression | undefined;
}

/** What is written into a constant: the values put in, and whether it is changed otherwise. */
export interface Writes {
  readonly values: readonly Put[];
  readonly changes: boolean;
}

export const CHANGED: Writes = { changes: true, values: [] };
export const NONE: Writes = { changes: false, values: [] };

export type SlotKind = 'changed' | 'element' | 'entry';

/** Count of guaranteed dense leading elements in `array` before any spread or hole. */
function densePrefixOf(array: ArrayLiteralExpression): number {
  let count = 0;
  for (const element of array.elements) {
    if (isOmittedExpression(element) || isSpreadElement(element)) break;
    count += 1;
  }
  return count;
}

/** Whether `node` constructs a sparse `Array(len)` or `new Array(len)` with holes. */
function isSparseArrayCall(node: Expression): boolean {
  const value = unwrapped(node);
  if (isConditionalExpression(value)) {
    return isSparseArrayCall(value.whenTrue) || isSparseArrayCall(value.whenFalse);
  }
  if (!isCallExpression(value) && !isNewExpression(value)) return false;
  if (globalPath(unwrapped(value.expression))?.join('.') !== 'Array') return false;
  const given = value.arguments ?? [];
  return given.length === 1 || given.some((each) => isSpreadElement(each));
}

/** Checks whether writing `last` on `array` stays within its dense prefix without holes. */
function arraySlotKind(array: ArrayLiteralExpression, last: string, target: Target): SlotKind {
  if (!isIndex(last) || array.elements.some((each) => isOmittedExpression(each))) {
    return 'changed';
  }
  const dense = isShrunkAt(target, target.keys.slice(0, -1)) ? 0 : densePrefixOf(array);
  return Number(last) <= dense ? 'element' : 'changed';
}

/**
 * The container at `containerKeys`: what `unreplacedAt` answers of it, or, where the code assigns
 * it, the object it assigns — `target.user = {}` — if what its initializer writes there and every
 * assignment of the whole path are objects the code writes, which no write of a key beside them
 * can leave a hole in. An assignment of an array, a call or a choice of values, a write of a part
 * of the path, and a hand-off the compile cannot follow leave it unknown.
 */
function containerAt(
  target: Target,
  containerKeys: readonly (string | undefined)[],
): Expression | undefined {
  const unreplaced = unreplacedAt(target, containerKeys);
  if (
    unreplaced !== undefined ||
    containerKeys.length === 0 ||
    !isConstIdentifier(target.declared)
  ) {
    return unreplaced;
  }
  const initial = writtenAt(target.initializer, containerKeys, target.resolve);
  const given: Expression[] = initial === undefined ? [] : [unwrapped(initial)];
  // Holds where the value the container has before an assignment is shown: written by the
  // initializer, or absent from an object the initializer writes plainly. An assignment may be one
  // that does not run (in a branch, in a loop), so it shows nothing of that value.
  const isHeld =
    initial !== undefined || lacksEntryAt(target.initializer, containerKeys, target.resolve);
  const isHazard = anyAliasRead(target, containerKeys, (node, suffix, at, queue) => {
    const { keys, top } = memberChain(node, at.resolve);
    const { parent } = top;
    if (
      keys.length === suffix.length &&
      pathsOverlap(keys, suffix) &&
      isBinaryExpression(parent) &&
      parent.left === top &&
      ASSIGNING.has(parent.operatorToken.kind)
    ) {
      given.push(unwrapped(parent.right));
      return false;
    }
    return checkPrefixRead(node, suffix, at, queue);
  });
  const [first] = given;
  const isObjects = given.every((each) => isObjectLiteralExpression(each));
  const isKnown = isHeld && isObjects && !isHazard;
  return isKnown ? first : undefined;
}

/**
 * Classifies whether `last` is a valid hole-free write on `container`. An entry of an object the
 * code writes is one under any key it reads from a page's values: which key that is, is not
 * something the compile tells (`last` is `undefined`). Of an array's it is refused: a key the code
 * does not name may leave a hole.
 */
export function slotEntryKind(
  container: Expression | undefined,
  last: string | undefined,
  target: Target,
): SlotKind {
  const value = container === undefined ? undefined : unwrapped(container);
  if (value !== undefined && isObjectLiteralExpression(value)) return 'entry';
  if (last === undefined) return 'changed';
  if (value !== undefined && isArrayLiteralExpression(value)) {
    return arraySlotKind(value, last, target);
  }
  if (value !== undefined && isSparseArrayCall(value)) return 'changed';
  return isIndex(last) && Number(last) === 0 ? 'element' : 'changed';
}

/** Validates the target key and container, returning the slot classification. */
export function checkedSlotOf(target: Target): SlotKind {
  const { keys } = target;
  const last = keys.at(-1);
  if (last === 'length' || target.endsInSymbol === true || keys.length === 0) return 'changed';
  if (keys.includes('__proto__')) return 'changed';
  const container = containerAt(target, keys.slice(0, -1));
  return slotEntryKind(container, last, target);
}

/**
 * `delete target.prop`: safe where the container at `keys.slice(0, -1)` is a plain object literal,
 * and where the code shows the property locked there (`lockedAt`): a strict deletion of it throws,
 * as the checks of what throws tell (`deletesLocked`), and takes nothing away.
 */
export function deletedAt(target: Target): Writes {
  if (target.keys.length === 0) return NONE;
  const container = containerAt(target, target.keys.slice(0, -1));
  if (container === undefined) return CHANGED;
  if (isObjectLiteralExpression(unwrapped(container))) return NONE;
  const last = target.keys.at(-1);
  return last !== undefined && lockedAt(container, last, target.resolve) ? NONE : CHANGED;
}

/** `Reflect.deleteProperty(target, key)`: safe only on an unreplaced plain object literal. */
export function deletedByReflect(target: Target): Writes {
  const container = containerAt(target, target.keys);
  return container !== undefined && isObjectLiteralExpression(unwrapped(container))
    ? NONE
    : CHANGED;
}

/** `Object.assign(target, ...sources)`: safe only on an unreplaced plain object literal without spreads. */
export function assignedFrom(sources: readonly Expression[], target: Target): Writes {
  const at = containerAt(target, target.keys);
  const isSpread = sources.some((each) => isSpreadElement(each));
  if (isSpread || at === undefined || !isObjectLiteralExpression(unwrapped(at))) return CHANGED;
  return {
    changes: false,
    values: sources.map((value) => ({ entry: true, inside: target.inside, value })),
  };
}

/** Direct (`=` / `&&=` / `||=` / `??=`) assignment onto `target`. */
export function assignedValue(value: Expression, target: Target): Writes {
  if (target.keys.length === 0) return NONE;
  const slot = checkedSlotOf(target);
  if (slot === 'changed') return CHANGED;
  return {
    changes: false,
    values: [{ entry: slot === 'entry', inside: target.inside, value }],
  };
}
