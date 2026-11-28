import { type CallExpression, isCallExpression, type Node, type SourceFile } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedArgumentPrefix, framedPossibleArguments } from '../src/compiler/framed-keys.ts';
import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * What is written past a spread the compile cannot read is collected once for each array, however
 * many spreads reach it: `const a1 = [...a0, ...a0]; const a2 = [...a1, ...a1];` and so on write a0's
 * elements 2ⁿ times at run time but name them once, and the compile's work follows the arrays written.
 */
const doubled = (layers: number, first: string): string => {
  const lines = [`const a0 = ${first};`];
  for (let at = 1; at <= layers; at++) lines.push(`const a${at} = [...a${at - 1}, ...a${at - 1}];`);
  return lines.join(' ');
};

const BOX = 'const box: { inner?: { stack?: string } } = {};';

/** The first `Object.assign` call of a source. */
function assignCall(sourceFile: SourceFile): CallExpression {
  const pending: Node[] = [sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isCallExpression(node) && node.expression.getText(sourceFile) === 'Object.assign')
      return node;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no Object.assign call');
}

describe('what is written past an unread spread, counted once for each array', () => {
  it.each([4, 10])('names the elements of a list doubled %i times once', (layers) => {
    const source = `function frames(error: Error, ...sources: object[]) { ${BOX} ${doubled(layers, '[{ inner: error }]')} Object.assign(box, ...sources, ...a${layers}); }`;
    using api = openTypeScript();
    using parsed = parseModule(api, 'past-spread-expansion.ts', source);
    const call = assignCall(parsed.sourceFile);
    const prefix = framedArgumentPrefix(call, call.arguments, Infinity);

    expect(
      framedPossibleArguments(prefix).map((each) => each.getText(parsed.sourceFile)),
    ).toStrictEqual(['{ inner: error }']);
  });

  it('keeps each distinct element of lists that share another', () => {
    const source = `function frames(error: Error, ...sources: object[]) { ${BOX} const shared = [{ first: error }]; const left = [...shared, { left: 1 }]; const right = [{ right: 2 }, ...shared]; Object.assign(box, ...sources, ...left, ...right, ...shared); }`;
    using api = openTypeScript();
    using parsed = parseModule(api, 'past-spread-shared.ts', source);
    const call = assignCall(parsed.sourceFile);
    const prefix = framedArgumentPrefix(call, call.arguments, Infinity);

    expect(
      framedPossibleArguments(prefix)
        .map((each) => each.getText(parsed.sourceFile))
        .toSorted((left, right) => left.localeCompare(right)),
    ).toStrictEqual(['{ first: error }', '{ left: 1 }', '{ right: 2 }']);
  });

  const CASES = [
    {
      id: 'doubled-list-past-parameter-spread',
      source: `function frames(error: Error, ...sources: object[]) { ${BOX} ${doubled(10, '[{ inner: error }]')} Object.assign(box, ...sources, ...a10); return box.inner!.stack; }`,
      refused: true,
    },
    {
      id: 'doubled-empty-list-then-source',
      source: `function frames(error: Error, ...sources: object[]) { ${BOX} ${doubled(10, '[]')} Object.assign(box, ...sources, ...a10, { inner: error }); return box.inner!.stack; }`,
      refused: true,
    },
    {
      id: 'doubled-empty-list-past-written-list',
      source: `function frames(error: Error) { ${BOX} ${doubled(10, '[]')} Object.assign(box, ...a10, { inner: error }); return box.inner!.stack; }`,
      refused: true,
    },
    {
      id: 'doubled-list-of-data-past-parameter-spread',
      source: `function frames(error: Error, ...sources: object[]) { ${BOX} ${doubled(10, "[{ inner: { stack: 'fixed' } }]")} Object.assign(box, ...sources, ...a10); return box.inner!.stack; }`,
      refused: false,
    },
    {
      id: 'doubled-empty-list-of-data',
      source: `function frames(error: Error, ...sources: object[]) { ${BOX} ${doubled(10, '[]')} Object.assign(box, ...sources, ...a10, { inner: { stack: 'fixed' } }); return box.inner!.stack; }`,
      refused: false,
    },
  ];

  it.each(CASES)('reads $id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'past-spread-doubled.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(refused);
  });
});

describe('shared lists written past an unread spread, counted once for each array', () => {
  const { apps, compile } = compilerApplications();
  const CASES = [
    {
      id: 'doubled-list-past-parameter-spread',
      source: `function frames(error: Error, ...sources: object[]) { ${BOX} ${doubled(8, '[{ inner: error }]')} Object.assign(box, ...sources, ...a8); return box.inner!.stack; }`,
      refused: true,
    },
    {
      id: 'doubled-list-of-data-past-parameter-spread',
      source: `function frames(error: Error, ...sources: object[]) { ${BOX} ${doubled(8, "[{ inner: { stack: 'fixed' } }]")} Object.assign(box, ...sources, ...a8); return box.inner!.stack; }`,
      refused: false,
    },
  ];

  it.each(CASES)('$id', async ({ source, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error("ours"))).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const shared = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
