import { type Expression, isCallExpression, isIdentifier, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedArrayString, framedArrayText } from '../src/compiler/framed-arrays.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * An assignment through a key the compile cannot read may replace the custom text method an earlier
 * write proved, with the native one — as a deletion through such a key may remove it. A key whose
 * written names are known, and none of them a method's, leaves the proof as it was.
 */
const CASES = [
  {
    id: 'reviewed-string-conversion',
    source:
      "function frames(error: Error, key: string) { const values = [error]; values.join = () => 'safe'; values[key] = Array.prototype.join; return String(values); }",
    converts: true,
  },
  {
    id: 'reviewed-join-call',
    source:
      "function frames(error: Error, key: string) { const values = [error]; values.join = () => 'safe'; values[key] = Array.prototype.join; return values.join(','); }",
    converts: true,
  },
  {
    id: 'restored-to-string',
    source:
      "function frames(error: Error, key: string) { const values = [error]; values.toString = () => 'safe'; values[key] = Array.prototype.toString; return values.toString(); }",
    converts: true,
  },
  {
    id: 'alias-receiver',
    source:
      "function frames(error: Error, key: string) { const values = [error]; const alias = values; values.join = () => 'safe'; alias[key] = Array.prototype.join; return String(values); }",
    converts: true,
  },
  {
    id: 'written-names-include-join',
    source:
      "function frames(error: Error, key: 'join' | 'label') { const values = [error]; values.join = () => 'safe'; values[key] = Array.prototype.join; return String(values); }",
    converts: true,
  },
  {
    id: 'custom-join-refused',
    source:
      "function frames(error: Error) { const values = [error]; values.join = () => 'safe'; return String(values); }",
    converts: true,
  },
  {
    id: 'constant-index-refused',
    source:
      "function frames(error: Error) { const values = [error]; values.join = () => 'safe'; values[0] = error; return values.join(','); }",
    converts: true,
  },
  {
    id: 'written-index-alternatives',
    source:
      "function frames(error: Error, flag: boolean) { const values = [error]; values.join = () => 'safe'; values[flag ? 0 : 1] = error; return values.join(','); }",
    converts: true,
  },
  {
    id: 'written-names-without-methods',
    source:
      "function frames(error: Error, key: 'label' | 'name') { const values = [error]; values.join = () => 'safe'; values[key] = Array.prototype.join; return String(values); }",
    converts: true,
  },
  {
    id: 'other-array-refused',
    source:
      "function frames(error: Error, key: string) { const values = [error]; const other = [1]; values.join = () => 'safe'; other[key] = Array.prototype.join; return String(values); }",
    converts: true,
  },
  {
    id: 'written-after-read-refused',
    source:
      "function frames(error: Error, key: string) { const values = [error]; values.join = () => 'safe'; const text = String(values); values[key] = Array.prototype.join; return text; }",
    converts: true,
  },
] as const;

describe('array text methods replaced through an opaque key', () => {
  it.each(CASES)('$id', ({ source, converts }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'opaque-method-writes.ts', source);

    expect(convertsError(parsed.sourceFile)).toBe(converts);
  });
});

/** Whether a native join, toString or String call in the source converts the `error` element. */
function convertsError(root: Node): boolean {
  const words = {
    error: (value: Expression, keys?: readonly string[]) => {
      const each = unwrapped(value);
      return (
        (keys === undefined || keys.length === 0) && isIdentifier(each) && each.text === 'error'
      );
    },
    typed: () => false,
  };
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedArrayText(node, words)) return true;
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === 'String' &&
      framedArrayString(node.arguments[0], words, node)
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
