import {
  type Expression,
  isArrayLiteralExpression,
  isOmittedExpression,
  isSpreadElement,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { framedMapKey } from './framed-map-keys.ts';

/** New native Map iterator origins retain only source-proven first-entry value replacement. */

interface Entry {
  readonly key: Expression;
  readonly value: Expression | undefined;
}

/** The first key never moves; multiple value candidates require proven primitive key equality. */
export function framedDefaultMapSlots(
  input: Expression,
  path: readonly string[],
): { readonly values: readonly Expression[]; readonly keys: readonly string[] } | undefined {
  const entries = literalEntries(input);
  if (entries === undefined) return undefined;
  const first = entries[0];
  if (first === undefined) return undefined;
  const keys = path.slice(1);
  if (path[0] === '0') return { values: [first.key], keys };
  if (path[0] !== '1') return undefined;
  const selected = firstValue(entries);
  return selected === undefined ? undefined : { values: selected.values, keys };
}

/** The caller separately proves literal input freshness, quiet creation and iterator identity. */
function literalEntries(input: Expression): readonly Entry[] | undefined {
  const value = unwrapped(input);
  if (!isArrayLiteralExpression(value)) return undefined;
  const entries: Entry[] = [];
  for (const element of value.elements) {
    const pair = unwrapped(element);
    if (
      !isArrayLiteralExpression(pair) ||
      pair.elements.some((each) => isSpreadElement(each) || isOmittedExpression(each))
    )
      return undefined;
    const key = pair.elements[0];
    if (key === undefined) return undefined;
    entries.push({ key, value: pair.elements[1] });
  }
  return entries;
}

/** Unknown multi-entry equality keeps the new projection opaque rather than retaining overwritten values. */
function firstValue(
  entries: readonly Entry[],
): { readonly values: readonly Expression[] } | undefined {
  const first = entries[0];
  if (first === undefined) return undefined;
  let value = first.value;
  if (entries.length > 1) {
    const wanted = framedMapKey(first.key);
    if (wanted === undefined) return undefined;
    for (const entry of entries) {
      const key = framedMapKey(entry.key);
      if (key === undefined) return undefined;
      if (key === wanted) value = entry.value;
    }
  }
  return { values: value === undefined ? [] : [value] };
}
