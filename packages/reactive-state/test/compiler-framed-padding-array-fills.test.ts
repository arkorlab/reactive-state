import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { isErased } from '../src/compiler/code-globals.ts';
import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * `String.prototype.padStart` and `String.prototype.padEnd` convert an array-valued fill argument
 * to text whenever padding is required, including borrowed `.call`, `.apply`, and `Reflect.apply`
 * invocations, while keeping non-padding lengths, locally written error words, and own `toString`
 * overrides unflagged.
 */

const CASES = [
  {
    framed: true,
    id: 'pad-start-literal-error-array',
    source: `function text(error: Error) { return ''.padStart(30, [error] as unknown as string); }`,
  },
  {
    framed: true,
    id: 'pad-end-literal-error-array',
    source: `function text(error: Error) { return ''.padEnd(30, [error] as unknown as string); }`,
  },
  {
    framed: true,
    id: 'pad-start-typed-error-array',
    source: `function text(fills: Error[]) { return ''.padStart(30, fills as unknown as string); }`,
  },
  {
    framed: true,
    id: 'pad-start-const-alias-error-array',
    source: `function text(error: Error) { const fill = [error]; return 'a'.padStart(10, fill as unknown as string); }`,
  },
  {
    framed: true,
    id: 'borrowed-pad-start-call-error-array',
    source: `function text(error: Error) { return String.prototype.padStart.call('', 30, [error]); }`,
  },
  {
    framed: true,
    id: 'borrowed-pad-end-apply-error-array',
    source: `function text(error: Error) { return String.prototype.padEnd.apply('', [30, [error]]); }`,
  },
  {
    framed: true,
    id: 'reflected-pad-start-error-array',
    source: `function text(error: Error) { return Reflect.apply(String.prototype.padStart, '', [30, [error]]); }`,
  },
  {
    framed: true,
    id: 'reflected-pad-start-const-args-error-array',
    source: `function text(error: Error) { const args = [30, [error]]; return Reflect.apply(String.prototype.padStart, '', args); }`,
  },
  {
    framed: false,
    id: 'pad-start-zero-width-skips-array-fill',
    source: `function text(error: Error) { return ''.padStart(0, [error] as unknown as string); }`,
  },
  {
    framed: false,
    id: 'pad-start-already-long-enough-skips-array-fill',
    source: `function text(error: Error) { return 'abcdef'.padStart(3, [error] as unknown as string); }`,
  },
  {
    framed: false,
    id: 'reflected-pad-start-const-zero-width-skips-array-fill',
    source: `function text(error: Error) { const args = [0, [error]]; return Reflect.apply(String.prototype.padStart, '', args); }`,
  },
  {
    framed: false,
    id: 'pad-start-locally-made-error-array',
    source: `function text() { return ''.padStart(30, [new Error('ours')] as unknown as string); }`,
  },
  {
    framed: false,
    id: 'pad-start-array-own-tostring-override',
    source: `function text(error: Error) { const fill = [error]; fill.toString = () => 'fixed'; return ''.padStart(30, fill as unknown as string); }`,
  },
  {
    framed: false,
    id: 'pad-start-plain-string-array',
    source: `function text() { return ''.padStart(30, ['ok'] as unknown as string); }`,
  },
] as const;

describe('padding array fill error conversions', () => {
  it.each(CASES)('$id', ({ framed, source }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'padding-array-fills.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(framed);
  });
});

function readsFrames(root: Node): boolean {
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isErased(node)) continue;
    if (framedRead(node) !== undefined) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
