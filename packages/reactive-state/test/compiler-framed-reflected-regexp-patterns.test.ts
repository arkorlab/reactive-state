import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { isErased } from '../src/compiler/code-globals.ts';
import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Aliased, destructured, and borrowed `Reflect.construct(RegExp, ...)` and `RegExp` wrappers check
 * RegExp-like `[Symbol.match]` `source` and `flags` fields through `framedRegExpPattern`, while
 * keeping the `knownNewTarget` guard active for custom or unresolved `newTarget` arguments and
 * distinguishing constructed calls from plain `RegExp` calls.
 */

const CASES = [
  {
    framed: true,
    id: 'aliased-reflect-construct-regexp-like-source-error',
    source: `function pattern(error: Error) { const construct = Reflect.construct; return construct(RegExp, [{ [Symbol.match]: true, source: error }]); }`,
  },
  {
    framed: true,
    id: 'aliased-reflect-construct-regexp-like-flags-error',
    source: `function pattern(error: Error) { const construct = Reflect.construct; return construct(RegExp, [{ [Symbol.match]: true, source: 'fixed', flags: error }]); }`,
  },
  {
    framed: true,
    id: 'destructured-reflect-construct-regexp-like-source-error',
    source: `const { construct } = Reflect; function pattern(error: Error) { return construct(RegExp, [{ [Symbol.match]: true, source: error }]); }`,
  },
  {
    framed: true,
    id: 'borrowed-reflect-construct-call-regexp-like-source-error',
    source: `function pattern(error: Error) { return Reflect.construct.call(Reflect, RegExp, [{ [Symbol.match]: true, source: error }]); }`,
  },
  {
    framed: true,
    id: 'borrowed-reflect-construct-apply-regexp-like-source-error',
    source: `function pattern(error: Error) { return Reflect.construct.apply(Reflect, [RegExp, [{ [Symbol.match]: true, source: error }]]); }`,
  },
  {
    framed: true,
    id: 'reflected-apply-of-reflect-construct-regexp-like-source-error',
    source: `function pattern(error: Error) { return Reflect.apply(Reflect.construct, Reflect, [RegExp, [{ [Symbol.match]: true, source: error }]]); }`,
  },
  {
    framed: true,
    id: 'aliased-reflect-construct-native-regexp-new-target',
    source: `function pattern(error: Error) { const construct = Reflect.construct; return construct(RegExp, [{ [Symbol.match]: true, source: error }], RegExp); }`,
  },
  {
    framed: true,
    id: 'aliased-reflect-construct-matching-constructor-reads-source',
    source: `function pattern(error: Error) { const construct = Reflect.construct; return construct(RegExp, [{ [Symbol.match]: true, constructor: RegExp, source: error }]); }`,
  },
  {
    framed: true,
    id: 'aliased-reflect-apply-regexp-like-source-error',
    source: `function pattern(error: Error) { const apply = Reflect.apply; return apply(RegExp, null, [{ [Symbol.match]: true, source: error }]); }`,
  },
  {
    framed: false,
    id: 'aliased-reflect-construct-custom-new-target-keeps-guard',
    source: `function pattern(error: Error) { class Custom {} const construct = Reflect.construct; return construct(RegExp, [{ [Symbol.match]: true, source: error }], Custom); }`,
  },
  {
    framed: false,
    id: 'borrowed-reflect-construct-call-custom-new-target-keeps-guard',
    source: `function pattern(error: Error) { class Custom {} return Reflect.construct.call(Reflect, RegExp, [{ [Symbol.match]: true, source: error }], Custom); }`,
  },
  {
    framed: false,
    id: 'aliased-reflect-construct-spread-new-target-keeps-guard',
    source: `function pattern(error: Error, extra: readonly unknown[]) { const construct = Reflect.construct; return (construct as (...args: unknown[]) => unknown)(RegExp, [{ [Symbol.match]: true, source: error }], ...extra); }`,
  },
  {
    framed: false,
    id: 'aliased-reflect-construct-overridden-flags-pin',
    source: `function pattern(error: Error) { const construct = Reflect.construct; return construct(RegExp, [{ [Symbol.match]: true, source: 'fixed', flags: error }, 'i']); }`,
  },
  {
    framed: false,
    id: 'aliased-regexp-call-matching-constructor-returns-pattern',
    source: `function pattern(error: Error) { const make = RegExp; return make.call(null, { [Symbol.match]: true, constructor: RegExp, source: error }); }`,
  },
] as const;

describe('aliased and borrowed Reflect.construct RegExp-like pattern checks', () => {
  it.each(CASES)('$id', ({ framed, source }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'reflected-regexp-patterns.ts', source);

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
