import {
  type CallExpression,
  isCallExpression,
  isPropertyAccessExpression,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedConcatSegment } from '../src/compiler/framed-concat-spreads.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Native concat reads the spreadable hook, the length and each slot with `Get`, which a literal's
 * written `__proto__` answers wherever the literal's own fields do not. The literal's own fields
 * still replace the prototype's.
 */
const HOOK = '[Symbol.isConcatSpreadable]';

const CASES = [
  {
    id: 'reviewed-inherited-slot-unknown-index',
    fields: `__proto__: { 1: error }, ${HOOK}: true, length: 2`,
    index: undefined,
    views: ['error'],
  },
  {
    id: 'reviewed-inherited-length',
    fields: `__proto__: { length: 1, 0: error }, ${HOOK}: true`,
    index: 0,
    views: ['error'],
  },
  {
    id: 'inherited-length-own-slot',
    fields: `__proto__: { length: 1 }, 0: error, ${HOOK}: true`,
    index: 0,
    views: ['error'],
  },
  {
    id: 'inherited-hook',
    fields: `__proto__: { ${HOOK}: true }, 0: error, length: 1`,
    index: 0,
    views: ['error'],
  },
  {
    id: 'aliased-prototype',
    prefix: 'const proto = { 1: error };',
    fields: `__proto__: proto, ${HOOK}: true, length: 2`,
    index: undefined,
    views: ['error'],
  },
  {
    id: 'prototype-chain',
    fields: `__proto__: { __proto__: { 1: error } }, ${HOOK}: true, length: 2`,
    index: undefined,
    views: ['error'],
  },
  {
    id: 'opaque-prototype-length',
    fields: `__proto__: base, 0: error, ${HOOK}: true`,
    index: 0,
    views: ['error'],
  },
  {
    id: 'own-length-shadows-pin',
    fields: `__proto__: { length: 2, 1: error }, length: 1, 0: 'fixed', ${HOOK}: true`,
    index: undefined,
    views: ["'fixed'"],
  },
  {
    id: 'own-hook-shadows-pin',
    fields: `__proto__: { ${HOOK}: true }, 0: error, length: 1, ${HOOK}: false`,
    index: 0,
    views: ['value'],
  },
  {
    id: 'null-prototype-pin',
    fields: `__proto__: null, 0: error, ${HOOK}: true`,
    index: 0,
    views: [],
  },
  {
    id: 'prototype-without-hook-pin',
    fields: '__proto__: { label: 1 }, 0: error, length: 1',
    index: 0,
    views: undefined,
  },
  {
    id: 'effectful-prototype-hook-pin',
    fields: `__proto__: { get ${HOOK}() { touch(); return true; } }, 0: error, length: 1`,
    index: 0,
    views: undefined,
  },
] as const;

describe('concat metadata a written prototype supplies', () => {
  it.each(CASES)('$id', (each) => {
    const prefix = 'prefix' in each ? each.prefix : '';
    const source = `declare function touch(): void; function frames(error: Error, base: object) { ${prefix} const value = { ${each.fields} }; return ([] as any[]).concat(value); }`;

    expect(segmentViews(source, each.index)).toStrictEqual(each.views);
  });
});

/** The values of the views the concat segment of the call's first argument keeps, if it reads one. */
function segmentViews(source: string, index: number | undefined): readonly string[] | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'concat-prototypes.ts', source);
  const call = concatCall(parsed.sourceFile);
  const argument = call.arguments[0];
  if (argument === undefined) throw new Error('no concat argument');
  return framedConcatSegment(argument, index, () => true, call)?.views.map((view) =>
    view.value.getText(),
  );
}

function concatCall(root: Node): CallExpression {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'concat'
    )
      return node;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no concat call');
}
