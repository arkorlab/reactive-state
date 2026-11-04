import {
  type CallExpression,
  type Expression,
  isObjectLiteralExpression,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import type { ArrayElementView } from './framed-array-rest.ts';
import { concatCarriedUnexposed } from './framed-concat-carried.ts';
import {
  concatMetadata,
  concatQuietSource,
  concatFields,
  concatKey,
  concatLength,
  concatSource,
  concatSpreadSymbol,
  concatSymbol,
  concatTruth,
  concatValues,
  type ConcatStable,
} from './framed-concat-properties.ts';

/** Native concat retains source-known spreadable array-like slots without materializing a runtime length. */

interface SpreadMetadata {
  found: boolean;
  spread: boolean | undefined;
  length: number | undefined;
  readonly keys: Set<string>;
}

interface ConcatSegment {
  readonly length: number | undefined;
  readonly views: readonly ArrayElementView[];
}

/** A known native symbol hook adds possible numeric slot values before a later selected array read. */
export function framedConcatSegment(
  value: Expression,
  index: number | undefined,
  stable: ConcatStable,
  capture: CallExpression,
): ConcatSegment | undefined {
  const root = concatSource(value, stable);
  if (root === undefined || !isObjectLiteralExpression(root) || !concatQuietSource(root, stable))
    return undefined;
  const metadata = spreadMetadata(root, stable);
  if (!metadata.found) return undefined;
  if (metadata.spread === false)
    return {
      length: 1,
      views: index === undefined || index === 0 ? [{ value, index: undefined, element: true }] : [],
    };
  const views: ArrayElementView[] = [];
  if (metadata.spread === undefined && (index === undefined || index === 0))
    views.push({ value, index: undefined, element: true });
  const selected = selectedKeys(metadata, index).flatMap((key) => concatValues(root, key, stable));
  if (!concatCarriedUnexposed(root, selected, capture)) return undefined;
  views.push(
    ...selected.map((source) => {
      return {
        ...source,
        index: undefined,
        element: true,
      };
    }),
  );
  return { length: metadata.spread === true ? metadata.length : undefined, views };
}

/** Only ordered literal data fields prove hook truthiness and length; opaque metadata stays possible. */
function spreadMetadata(root: ObjectLiteralExpression, stable: ConcatStable): SpreadMetadata {
  const state: SpreadMetadata = { found: false, spread: false, length: 0, keys: new Set() };
  for (const field of concatFields(root, stable)) {
    if (field === undefined) {
      state.spread = undefined;
      state.length = undefined;
      continue;
    }
    if (concatSpreadSymbol(field.name)) {
      state.found = true;
      state.spread = concatTruth(concatMetadata(field, stable), stable);
      continue;
    }
    if (concatSymbol(field.name)) continue;
    const key = concatKey(field.name, stable);
    if (key === undefined) {
      state.spread = undefined;
      state.length = undefined;
    } else if (key === 'length') state.length = concatLength(concatMetadata(field, stable), stable);
    else if (numericKey(key)) state.keys.add(key);
  }
  return state;
}

/** Unknown positions visit only written numeric keys and one unwritten representative for opaque fields. */
function selectedKeys(metadata: SpreadMetadata, index: number | undefined): readonly string[] {
  const limit = metadata.length ?? Infinity;
  if (limit === 0) return [];
  if (index !== undefined) return index < limit ? [String(index)] : [];
  const keys = [...metadata.keys].filter((key) => Number(key) < limit);
  let gap = 0;
  while (metadata.keys.has(String(gap))) gap += 1;
  if (gap < limit) keys.push(String(gap));
  return keys;
}

/** Native array-like positions use canonical nonnegative integer names below the maximum length. */
function numericKey(key: string): boolean {
  const value = Number(key);
  return Number.isSafeInteger(value) && value >= 0 && String(value) === key;
}
