import { isVariableStatement } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { proxyOrigin } from '../src/compiler/proxy-origins.ts';
import { sharedProxyOrigin } from '../src/compiler/shared-proxies.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Depth parameter for shared constant DAGs (`2^13 = 8192` duplicate paths without memoization). */
const DAG = {
  depth: 13,
} as const;

/** Builds a shared constant DAG of `DAG.depth` levels from `step(prev, current)`. */
function buildDag(seed: string, step: (prev: string, next: string) => string): string {
  const lines = ["import { leaf } from './external';", 'declare const flag: boolean;', seed];
  for (let index = 1; index <= DAG.depth; index++) {
    lines.push(step(`n${index - 1}`, `n${index}`));
  }
  lines.push(`export const root = n${DAG.depth};`);
  return lines.join('\n');
}

describe('memoized proxy origin traversal on shared constant subgraphs', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Counts leaf constant resolutions performed while scanning `root`'s initializer. */
  function countLeafVisits(source: string): { readonly found: boolean; readonly visits: number } {
    using parsed = parseModule(api, 'proxy-dag.ts', source);
    const exported = parsed.sourceFile.statements.findLast(isVariableStatement);
    const root = exported?.declarationList.declarations[0]?.initializer;
    if (root === undefined) {
      throw new Error('Missing exported root initializer.');
    }
    let visits = 0;
    const origin = proxyOrigin([root], {
      follow: (name): undefined => {
        if (name.text === 'leaf') {
          visits += 1;
        }
      },
    });
    return { found: origin !== undefined, visits };
  }

  it('visits a shared object-literal DAG linearly instead of re-expanding sibling paths', () => {
    const source = buildDag(
      'const n0 = { value: leaf };',
      (prev, next) => `const ${next} = { left: ${prev}, right: ${prev} };`,
    );

    expect(countLeafVisits(source)).toStrictEqual({ found: false, visits: 1 });
  });

  it('visits a shared array-literal DAG linearly across duplicate element references', () => {
    const source = buildDag(
      'const n0 = [leaf];',
      (prev, next) => `const ${next} = [${prev}, ${prev}];`,
    );

    expect(countLeafVisits(source)).toStrictEqual({ found: false, visits: 1 });
  });

  it('visits a shared conditional-branch DAG linearly across unknown conditions', () => {
    const source = buildDag(
      'const n0 = { value: leaf };',
      (prev, next) => `const ${next} = flag ? ${prev} : ${prev};`,
    );

    expect(countLeafVisits(source)).toStrictEqual({ found: false, visits: 1 });
  });

  it('visits repeated member projections of the same key on a shared subgraph once', () => {
    const source = buildDag(
      'const n0 = { nested: { value: leaf } };',
      (prev, next) => `const ${next} = { nested: flag ? ${prev}.nested : ${prev}.nested };`,
    );

    expect(countLeafVisits(source)).toStrictEqual({ found: false, visits: 1 });
  });

  it('still finds a Proxy at the shared leaf of a DAG (pin)', () => {
    const source = buildDag(
      'const n0 = { first: leaf, second: new Proxy({}, {}) };',
      (prev, next) => `const ${next} = { left: ${prev}, right: ${prev} };`,
    );

    expect(countLeafVisits(source).found).toBe(true);
  });

  it('keeps distinct member-key projections separate on a shared constant (pin)', () => {
    const source = [
      'const shared = { safe: 1, trapped: new Proxy({}, {}) };',
      'export const out = { first: shared.safe, second: shared.trapped };',
    ].join('\n');
    using parsed = parseModule(api, 'proxy-distinct-keys.ts', source);

    expect(sharedProxyOrigin(parsed.sourceFile)).toBeDefined();
  });

  it('terminates cleanly on cyclic constant member projections (pin)', () => {
    const source = 'const cycle: any = cycle.next; export const out = cycle;';
    using parsed = parseModule(api, 'proxy-cycle.ts', source);

    expect(sharedProxyOrigin(parsed.sourceFile)).toBeUndefined();
  });
});
