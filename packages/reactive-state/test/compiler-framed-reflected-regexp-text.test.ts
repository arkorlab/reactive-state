import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { isErased } from '../src/compiler/code-globals.ts';
import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * `Reflect.construct(RegExp, args)` converts the pattern and flag arguments just like `new RegExp`
 * does, including direct `Error` values, array-valued patterns/flags, typed `Error[]` argument
 * lists, and aliased or borrowed `Reflect.construct` wrappers, while leaving ignored extra slots,
 * locally written error words, and overridden RegExp-like flags unflagged.
 */

const CASES = [
  {
    framed: true,
    id: 'reflect-construct-pattern-error',
    source: `function pattern(error: Error) { return Reflect.construct(RegExp, [error]).source; }`,
  },
  {
    framed: true,
    id: 'reflect-construct-flags-error',
    source: `function pattern(error: Error) { return Reflect.construct(RegExp, ['a', error]); }`,
  },
  {
    framed: true,
    id: 'reflect-construct-pattern-error-array',
    source: `function pattern(error: Error) { return Reflect.construct(RegExp, [[error]]); }`,
  },
  {
    framed: true,
    id: 'reflect-construct-const-args-tuple',
    source: `function pattern(error: Error) { const args = [error]; return Reflect.construct(RegExp, args); }`,
  },
  {
    framed: true,
    id: 'reflect-construct-typed-error-array-args',
    source: `function pattern(errors: Error[]) { return Reflect.construct(RegExp, errors); }`,
  },
  {
    framed: true,
    id: 'aliased-reflect-construct-regexp',
    source: `function pattern(error: Error) { const construct = Reflect.construct; return construct(RegExp, [error]); }`,
  },
  {
    framed: true,
    id: 'borrowed-reflect-construct-call-regexp',
    source: `function pattern(error: Error) { return Reflect.construct.call(Reflect, RegExp, [error]); }`,
  },
  {
    framed: true,
    id: 'reflected-apply-of-reflect-construct-regexp',
    source: `function pattern(error: Error) { return Reflect.apply(Reflect.construct, Reflect, [RegExp, [error]]); }`,
  },
  {
    framed: false,
    id: 'reflect-construct-ignored-third-slot',
    source: `function pattern(error: Error) { return Reflect.construct(RegExp, ['a', 'i', error]); }`,
  },
  {
    framed: false,
    id: 'reflect-construct-locally-made-error',
    source: `function pattern() { return Reflect.construct(RegExp, [new Error('ours')]); }`,
  },
  {
    framed: false,
    id: 'reflect-construct-regexp-like-overridden-flags',
    source: `function pattern(error: Error) { return Reflect.construct(RegExp, [{ [Symbol.match]: true, source: 'fixed', flags: error }, 'i']); }`,
  },
  {
    framed: true,
    id: 'reflect-construct-regexp-like-source-error',
    source: `function pattern(error: Error) { return Reflect.construct(RegExp, [{ [Symbol.match]: true, source: error }]); }`,
  },
  {
    framed: false,
    id: 'shadowed-reflect-construct',
    source: `function pattern(error: Error) { const Reflect = { construct(..._args: unknown[]) { return /a/; } }; return Reflect.construct(RegExp, [error]); }`,
  },
] as const;

describe('reflected RegExp error text conversions', () => {
  it.each(CASES)('$id', ({ framed, source }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'reflected-regexp-text.ts', source);

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
