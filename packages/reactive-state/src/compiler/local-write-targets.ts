import {
  type ArrayLiteralExpression,
  type Expression,
  isArrayLiteralExpression,
  isCallExpression,
  isConditionalExpression,
  isNewExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPath } from './global-answers.ts';
import { COMPUTING, isIndex, isShrunkAt, type Target, unreplacedAt } from './local-write-paths.ts';
import { constantNumber } from './numbers.ts';

/**
 * Target slot classification, deletions, `Object.assign` sources, and assignments on local
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

/** Array methods whose return value is another `Array` instance. */
const ARRAY_ANSWER_METHODS: ReadonlySet<string> = new Set([
  'concat',
  'copyWithin',
  'fill',
  'filter',
  'flat',
  'flatMap',
  'map',
  'reverse',
  'slice',
  'sort',
  'splice',
  'toReversed',
  'toSorted',
  'toSpliced',
  'with',
]);

/** The operators of `COMPUTING` that make no finite number of a zero on their right: `ratio /= 0`. */
const BY_ZERO: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.PercentEqualsToken,
  SyntaxKind.SlashEqualsToken,
]);

/** Whether `key` parses as a number or `NaN` that is not a valid array index (`-1`, `1.5`, `-0`, `4294967295`). */
function isNumericNonIndex(key: string): boolean {
  if (key === '' || isIndex(key)) {
    return false;
  }
  return key === 'NaN' || !Number.isNaN(Number(key));
}

/** Count of guaranteed dense leading elements in `array` before any spread or hole. */
function densePrefixOf(array: ArrayLiteralExpression): number {
  let count = 0;
  for (const element of array.elements) {
    if (isOmittedExpression(element) || isSpreadElement(element)) {
      break;
    }
    count += 1;
  }
  return count;
}

/** Whether `node` constructs a sparse `Array(len)` or `new Array(len)` with holes. */
function isSparseArrayCall(node: Expression): boolean {
  const value = unwrapped(node);
  if (!isCallExpression(value) && !isNewExpression(value)) {
    return false;
  }
  if (globalPath(unwrapped(value.expression))?.join('.') !== 'Array') {
    return false;
  }
  const given = value.arguments ?? [];
  return given.length === 1 || given.some((each) => isSpreadElement(each));
}

/** Whether `node` is syntactically an `Array` value (`[…]`, `Array.of(…)`, `items.slice()`, etc.). */
function isArrayExpression(node: Expression): boolean {
  const value = unwrapped(node);
  if (isArrayLiteralExpression(value)) {
    return true;
  }
  if (isConditionalExpression(value)) {
    return isArrayExpression(value.whenTrue) || isArrayExpression(value.whenFalse);
  }
  if (!isCallExpression(value) && !isNewExpression(value)) {
    return false;
  }
  const callee = unwrapped(value.expression);
  const path = globalPath(callee);
  if (path !== undefined) {
    return path[0] === 'Array' && path[1] !== 'isArray';
  }
  return isPropertyAccessExpression(callee) && ARRAY_ANSWER_METHODS.has(callee.name.text);
}

type SlotKind = 'changed' | 'element' | 'entry';

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
  if (container !== undefined && isObjectLiteralExpression(container)) {
    return 'entry';
  }
  if (container !== undefined && isArrayLiteralExpression(container)) {
    return arraySlotKind(container, last, target);
  }
  if (container !== undefined && isSparseArrayCall(container)) {
    return 'changed';
  }
  if (isIndex(last)) {
    return Number(last) === 0 ? 'element' : 'changed';
  }
  if (isNumericNonIndex(last) || (container !== undefined && isArrayExpression(container))) {
    return 'changed';
  }
  return 'entry';
}

/**
 * `delete target.prop`: safe only when the container at `keys.slice(0, -1)` is an unreplaced
 * plain object literal; deleting from an array or unproven container may leave a sparse hole.
 */
export function deletedAt(target: Target): Writes {
  if (target.keys.length === 0) {
    return NONE;
  }
  const container = unreplacedAt(target, target.keys.slice(0, -1));
  return container !== undefined && isObjectLiteralExpression(container) ? NONE : CHANGED;
}

/** `Reflect.deleteProperty(target, key)`: safe only on an unreplaced plain object literal. */
export function deletedByReflect(target: Target): Writes {
  const container = unreplacedAt(target, target.keys);
  return container !== undefined && isObjectLiteralExpression(container) ? NONE : CHANGED;
}

/** `Object.assign(target, ...sources)`: safe only on an unreplaced plain object literal without spreads. */
export function assignedFrom(sources: readonly Expression[], target: Target): Writes {
  const at = unreplacedAt(target, target.keys);
  const isSpread = sources.some((each) => isSpreadElement(each));
  if (isSpread || at === undefined || !isObjectLiteralExpression(at)) {
    return CHANGED;
  }
  return {
    changes: false,
    values: sources.map((value) => ({ entry: true, inside: target.inside, value })),
  };
}

/**
 * What an assignment of `operator` writes of `value` into the member `target.keys` reads of a
 * constant: refuses `.length`, `__proto__`, dynamic keys, non-index array properties, and indexed
 * writes that may leave sparse array holes.
 */
export function assigned(operator: SyntaxKind, value: Expression, target: Target): Writes {
  const { keys } = target;
  const last = keys.at(-1);
  if (keys.length === 0) {
    return NONE;
  }
  if (last === undefined || last === 'length' || keys.includes('__proto__')) {
    return CHANGED;
  }
  const container = unreplacedAt(target, keys.slice(0, -1));
  const slot = slotEntryKind(container, last, target);
  if (slot === 'changed') {
    return CHANGED;
  }
  if (COMPUTING.has(operator)) {
    const byZero = BY_ZERO.has(operator) && constantNumber(value, target.resolve) === 0;
    return byZero
      ? CHANGED
      : { changes: false, values: [{ entry: false, inside: target.inside, value }] };
  }
  return {
    changes: false,
    values: [{ entry: slot === 'entry', inside: target.inside, value }],
  };
}
