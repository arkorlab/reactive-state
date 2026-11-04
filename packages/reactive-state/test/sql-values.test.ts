import { describe, expect, it } from 'vitest';

import type { KeyKind } from '../src/sql/keys.ts';
import { constantText, valueText } from '../src/sql/values.ts';

/**
 * A key's value as the change log keeps it, of a value a statement ran with or a constant its plan
 * names: the text PostgreSQL writes of the value, or none where it might be another.
 */

describe("a key's value as text", () => {
  it.each<readonly [KeyKind, unknown, string | undefined]>([
    ['text', 'launch', 'launch'],
    ['text', '', ''],
    ['text', 5, undefined],
    ['text', '\u{D800}', undefined],
    ['text', 'a\0b', undefined],
    ['integer', 5, '5'],
    ['integer', -0, '0'],
    ['integer', 9_007_199_254_740_993n, '9007199254740993'],
    ['integer', '0005', '5'],
    ['integer', '-12', '-12'],
    ['integer', Number.MAX_SAFE_INTEGER + 2, undefined],
    ['integer', 1.5, undefined],
    ['integer', ' 5', undefined],
    ['integer', '+5', undefined],
    ['integer', '0x1F', undefined],
    ['integer', '1_000', undefined],
    ['boolean', true, 'true'],
    ['boolean', false, 'false'],
    ['boolean', 'true', undefined],
    ['boolean', 1, undefined],
    ['uuid', '6F1F7D3E-0000-4000-8000-000000000001', '6f1f7d3e-0000-4000-8000-000000000001'],
    ['uuid', '{6f1f7d3e-0000-4000-8000-000000000001}', undefined],
    ['uuid', '6f1f7d3e000040008000000000000001', undefined],
  ])('of a %s key, %s is %s', (kind, value, text) => {
    expect(valueText(kind, value)).toBe(text);
  });

  it.each<readonly [KeyKind, string, string | undefined]>([
    ['boolean', 'true', 'true'],
    ['boolean', 'f', undefined],
    ['integer', '5', '5'],
    ['integer', '-5', '-5'],
    ['text', 'open', 'open'],
    ['uuid', '6f1f7d3e-0000-4000-8000-000000000001', '6f1f7d3e-0000-4000-8000-000000000001'],
  ])('of a %s key, the constant %j is %j', (kind, written, text) => {
    expect(constantText(kind, written)).toBe(text);
  });
});
