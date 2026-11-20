import {
  type Expression,
  isArrayLiteralExpression,
  isOmittedExpression,
  isSpreadElement,
} from 'typescript/ast';

import type { TopLevel } from './analyze.ts';
import {
  isArrayIndex,
  keyValue,
  missingValue,
  type Reading,
  type Selection,
  type Step,
} from './writer-bindings.ts';

/** The elements a writer alias selects from an array, through rest offsets and source spreads. */

interface Cursor {
  readonly at: number | undefined;
  readonly least: number;
}

/** The selected array element, keeping literal spread lengths and rest exclusions precise. */
export function arrayValues(
  written: readonly Expression[],
  selection: Selection,
  names: ReadonlyMap<string, TopLevel>,
): readonly Reading[] {
  const { key, rest } = selection;
  if (key !== undefined && !isArrayIndex(key)) {
    return missingValue(rest);
  }
  const found: Reading[] = [];
  let cursor: Cursor = { at: 0, least: 0 };
  for (const each of written) {
    if (isSpreadElement(each)) {
      const size = arraySize(each.expression, names);
      found.push(...spreadValues(each.expression, selection, cursor, size));
      cursor = advanced(cursor, size);
    } else {
      if (selectedElement(cursor, selection)) {
        found.push(
          ...(isOmittedExpression(each) ? missingValue(rest) : [{ keys: rest, value: each }]),
        );
      }
      cursor = advanced(cursor, 1);
    }
  }
  const missing = key === undefined || cursor.at === undefined || Number(key) >= cursor.at;
  return missing ? [...found, ...missingValue(rest)] : found;
}

/** Whether a non-spread element may stand at the selected index. */
function selectedElement({ at, least }: Cursor, { key, from, excluded }: Selection): boolean {
  if (key !== undefined) {
    return at === undefined ? Number(key) >= least : Number(key) === at;
  }
  return at === undefined || (at >= from && !excluded.has(String(at)));
}

/** What a source spread may put at the index selected from the outer array. */
function spreadValues(
  value: Expression,
  selection: Selection,
  cursor: Cursor,
  size: number | undefined,
): readonly Reading[] {
  const { key, rest } = selection;
  if (key === undefined) {
    return [{ keys: spreadSelection(selection, cursor), value }];
  }
  const asked = Number(key);
  if (
    asked < cursor.least ||
    (size !== undefined && cursor.at !== undefined && asked >= cursor.at + size)
  ) {
    return [];
  }
  const index = cursor.at === undefined ? undefined : String(asked - cursor.at);
  return [{ keys: [index, ...rest], value }];
}

/** An unknown element selection moved into a spread, with exclusions relative to that spread's rest. */
function spreadSelection(
  { excluded, from, rest, shape }: Selection,
  { at }: Cursor,
): readonly Step[] {
  const start = at === undefined ? 0 : Math.max(0, from - at);
  const omitted =
    at === undefined
      ? []
      : [...excluded].flatMap((key) => {
          const index = Number(key) - at - start;
          return isArrayIndex(key) && index >= 0 ? [String(index)] : [];
        });
  const projected: Step[] = [];
  if (start > 0) {
    projected.push({ from: start, kind: 'array-rest' });
  }
  if (shape === 'object-rest' || omitted.length > 0) {
    projected.push({ excluded: omitted, kind: 'object-rest' });
  }
  return [...projected, undefined, ...rest];
}

/** The next source position: exact until a spread's size is unknown, then at least the written prefix. */
function advanced({ at, least }: Cursor, size: number | undefined): Cursor {
  return {
    at: at === undefined || size === undefined ? undefined : at + size,
    least: least + (size ?? 0),
  };
}

/** A literal array's length through constant aliases and literal spreads; none of an unknown or cyclic source. */
function arraySize(
  node: Expression,
  names: ReadonlyMap<string, TopLevel>,
  seen: ReadonlySet<Expression> = new Set(),
): number | undefined {
  const value = keyValue(node, names);
  if (!isArrayLiteralExpression(value) || seen.has(value)) {
    return undefined;
  }
  const followed = new Set([...seen, value]);
  let length = 0;
  for (const each of value.elements) {
    const size = isSpreadElement(each) ? arraySize(each.expression, names, followed) : 1;
    if (size === undefined) {
      return undefined;
    }
    length += size;
  }
  return length;
}
