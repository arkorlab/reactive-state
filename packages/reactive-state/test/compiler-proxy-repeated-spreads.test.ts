import { isObjectLiteralExpression, isVariableStatement } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { proxyOrigin } from '../src/compiler/proxy-origins.ts';
import { sharedProxyOrigin } from '../src/compiler/shared-proxies.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Parameters for repeated sibling-spread chains (`2^25` paths without spread-key memoization). */
const CHAIN = {
  baselineDepth: 2,
  depth: 25,
  maxElapsedMs: 100,
  maxLeafVisits: 5,
  visitBudget: 64,
} as const;

/** Builds a `depth`-level sibling-spread chain from `n0` to `export const root = ...`. */
function buildSpreadChain(
  n0Initializer: string,
  rootOf: (last: string) => string,
  depth: number = CHAIN.depth,
): string {
  const lines = [
    "import { seed } from './external';",
    'const empty = {};',
    `const n0 = ${n0Initializer};`,
  ];
  for (let index = 1; index <= depth; index++) {
    const previous = `n${index - 1}`;
    lines.push(`const n${index} = { ...${previous}, ...${previous} };`);
  }
  const lastName = `n${depth}`;
  lines.push(`export const root = ${rootOf(lastName)};`);
  return lines.join('\n');
}

describe('memoized spread-key resolution across repeated sibling spreads', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Runs `proxyOrigin` on `root`, bounding `seed` resolutions so exponential walks fail fast. */
  function measureChain(
    source: string,
    resolveSeed: 'empty-literal' | 'unknown' = 'empty-literal',
  ): { readonly elapsedMs: number; readonly found: boolean; readonly visits: number } {
    using parsed = parseModule(api, 'proxy-repeated-spreads.ts', source);
    const statements = parsed.sourceFile.statements.filter((statement) =>
      isVariableStatement(statement),
    );
    const emptyInitializer = statements[0]?.declarationList.declarations[0]?.initializer;
    const rootInitializer = statements.at(-1)?.declarationList.declarations[0]?.initializer;
    if (
      emptyInitializer === undefined ||
      rootInitializer === undefined ||
      !isObjectLiteralExpression(emptyInitializer)
    ) {
      throw new Error('Missing expected chain declarations.');
    }
    let visits = 0;
    const startedAt = performance.now();
    const origin = proxyOrigin([rootInitializer], {
      follow: (name) => {
        if (name.text !== 'seed') {
          return;
        }
        visits += 1;
        if (visits > CHAIN.visitBudget) {
          throw new Error(`Exceeded linear spread-key visit budget (${visits}).`);
        }
        return resolveSeed === 'empty-literal' ? emptyInitializer : undefined;
      },
    });
    return {
      elapsedMs: performance.now() - startedAt,
      found: origin !== undefined,
      visits,
    };
  }

  it('completes a 25-level sibling-spread chain linearly under 100ms', () => {
    const baseline = measureChain(
      buildSpreadChain('{ p: 1, ...seed }', (last) => last, CHAIN.baselineDepth),
    );
    const measured = measureChain(buildSpreadChain('{ p: 1, ...seed }', (last) => last));

    expect(measured.found).toBe(false);
    expect(measured.visits).toBe(baseline.visits);
    expect(measured.visits).toBeLessThanOrEqual(CHAIN.maxLeafVisits);
    expect(measured.elapsedMs).toBeLessThan(CHAIN.maxElapsedMs);
  });

  it('projects a present member across a 25-level sibling-spread chain under 100ms', () => {
    const measured = measureChain(buildSpreadChain('{ p: 1, ...seed }', (last) => `${last}.p`));

    expect(measured.found).toBe(false);
    expect(measured.visits).toBeLessThanOrEqual(CHAIN.maxLeafVisits);
    expect(measured.elapsedMs).toBeLessThan(CHAIN.maxElapsedMs);
  });

  it('projects a missing member across a 25-level sibling-spread chain under 100ms', () => {
    const measured = measureChain(
      buildSpreadChain(
        '{ p: 1, ...seed }',
        (last) => `(${last} as Record<string, unknown>).missing`,
      ),
    );

    expect(measured.found).toBe(false);
    expect(measured.visits).toBeLessThanOrEqual(CHAIN.maxLeafVisits);
    expect(measured.elapsedMs).toBeLessThan(CHAIN.maxElapsedMs);
  });

  it('recognizes keys guaranteed overwritten by a 25-level sibling-spread chain under 100ms', () => {
    const measured = measureChain(
      buildSpreadChain('{ p: 1, ...seed }', (last) => `{ p: new Proxy({}, {}), ...${last} }`),
    );

    expect(measured.found).toBe(false);
    expect(measured.visits).toBeLessThanOrEqual(CHAIN.maxLeafVisits);
    expect(measured.elapsedMs).toBeLessThan(CHAIN.maxElapsedMs);
  });

  it('memoizes empty spread-key sets across a 25-level chain over an unknown base under 100ms', () => {
    const measured = measureChain(
      buildSpreadChain('{ ...seed }', (last) => `{ p: 1, ...${last} }`),
      'unknown',
    );

    expect(measured.found).toBe(false);
    expect(measured.visits).toBeLessThanOrEqual(CHAIN.maxLeafVisits);
    expect(measured.elapsedMs).toBeLessThan(CHAIN.maxElapsedMs);
  });

  it('detects a Proxy at the base of a 25-level sibling-spread chain under 100ms', () => {
    const measured = measureChain(
      buildSpreadChain('{ p: new Proxy({}, {}), ...seed }', (last) => last),
    );

    expect(measured.found).toBe(true);
    expect(measured.elapsedMs).toBeLessThan(CHAIN.maxElapsedMs);
  });

  it('does not treat a deleted property on a later spread as guaranteed overwritten (pin)', () => {
    const source = [
      'const base: Record<string, unknown> = { p: 1 };',
      'const beforeDelete = { p: new Proxy({}, {}), ...base };',
      'delete base.p;',
      'export const result = { beforeDelete, afterDelete: { p: new Proxy({}, {}), ...base } };',
    ].join('\n');
    using parsed = parseModule(api, 'proxy-mutated-spread.ts', source);

    expect(sharedProxyOrigin(parsed.sourceFile)).toBeDefined();
  });

  it('keeps guaranteed keys distinct across independent spread literals (pin)', () => {
    const overwritten = [
      'const first = { a: 1 };',
      'const second = { b: 1 };',
      'export const result = { a: new Proxy({}, {}), ...second, ...first };',
    ].join('\n');
    const surviving = [
      'const first = { a: 1 };',
      'const second = { b: 1 };',
      'export const result = { c: new Proxy({}, {}), ...second, ...first };',
    ].join('\n');
    using cleanParsed = parseModule(api, 'proxy-independent-clean.ts', overwritten);
    using proxyParsed = parseModule(api, 'proxy-independent-proxy.ts', surviving);

    expect(sharedProxyOrigin(cleanParsed.sourceFile)).toBeUndefined();
    expect(sharedProxyOrigin(proxyParsed.sourceFile)).toBeDefined();
  });
});
