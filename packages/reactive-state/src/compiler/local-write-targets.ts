import {
  type ArrayLiteralExpression,
  type Expression,
  isArrayLiteralExpression,
  isCallExpression,
  isConditionalExpression,
  isNewExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isSpreadElement,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPath } from './global-answers.ts';
import { isIndex, isShrunkAt, type Target, unreplacedAt } from './local-write-paths.ts';

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

/** Classifies whether `last` is a valid hole-free write on `container`. */
export function slotEntryKind(
  container: Expression | undefined,
  last: string,
  target: Target,
): SlotKind {
  const value = container === undefined ? undefined : unwrapped(container);
  if (value !== undefined && isObjectLiteralExpression(value)) return 'entry';
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
  if (last === undefined || last === 'length' || keys.includes('__proto__')) return 'changed';
  const container = unreplacedAt(target, keys.slice(0, -1));
  return slotEntryKind(container, last, target);
}

/** `delete target.prop`: safe only when the container at `keys.slice(0, -1)` is a plain object literal. */
export function deletedAt(target: Target): Writes {
  if (target.keys.length === 0) return NONE;
  const container = unreplacedAt(target, target.keys.slice(0, -1));
  return container !== undefined && isObjectLiteralExpression(unwrapped(container))
    ? NONE
    : CHANGED;
}

/** `Reflect.deleteProperty(target, key)`: safe only on an unreplaced plain object literal. */
export function deletedByReflect(target: Target): Writes {
  const container = unreplacedAt(target, target.keys);
  return container !== undefined && isObjectLiteralExpression(unwrapped(container))
    ? NONE
    : CHANGED;
}

/** `Object.assign(target, ...sources)`: safe only on an unreplaced plain object literal without spreads. */
export function assignedFrom(sources: readonly Expression[], target: Target): Writes {
  const at = unreplacedAt(target, target.keys);
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
