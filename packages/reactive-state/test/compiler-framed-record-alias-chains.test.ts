import { isIdentifier, isNewExpression, type Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedSearchParamsText } from '../src/compiler/framed-search-params-text.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const CHAIN = {
  depth: 25,
  maxElapsedMs: 100,
} as const;

function buildLinearChain(initial: string, constructorName: string): string {
  const statements = [`let a0 = ${initial};`];
  for (let index = 1; index <= CHAIN.depth; index++) {
    statements.push(`let a${index} = { x: 'ok' as never }; a${index} = a${index - 1};`);
  }
  statements.push(`return new ${constructorName}(a${CHAIN.depth});`);
  return statements.join(' ');
}

function buildDiamondChain(initial: string): string {
  const statements = [`let a0 = ${initial};`];
  for (let index = 1; index <= CHAIN.depth; index++) {
    statements.push(
      `let a${index} = { x: 'ok' as never }; a${index} = flag ? a${index - 1} : a${index - 1};`,
    );
  }
  statements.push(`return new URLSearchParams(a${CHAIN.depth});`);
  return statements.join(' ');
}

function buildCyclicOriginChain(): string {
  const statements = [
    "let a0: Record<string, string> = { x: error as never }; let a1: Record<string, string> = { y: 'ok' }; if (flag) a0 = a1; if (flag) a1 = a0;",
  ];
  for (let index = 2; index <= CHAIN.depth; index++) {
    statements.push(
      `let a${index}: Record<string, string> = { x: 'ok' }; a${index} = a${index - 1};`,
    );
  }
  statements.push(`return new URLSearchParams(a${CHAIN.depth});`);
  return statements.join(' ');
}

const SINGLE_CHECK_CHAINS = [
  {
    id: 'linear-25-alias-chain-error-at-origin',
    body: buildLinearChain('{ x: error as never }', 'URLSearchParams'),
    converts: true,
  },
  {
    id: 'linear-25-alias-chain-plain-data',
    body: buildLinearChain("{ x: 'ok' as never }", 'URLSearchParams'),
    converts: false,
  },
  {
    id: 'headers-25-alias-chain-error-at-origin',
    body: buildLinearChain('{ x: error as never }', 'Headers'),
    converts: true,
  },
  {
    id: 'diamond-25-alias-chain-error-at-origin',
    body: buildDiamondChain('{ x: error as never }'),
    converts: true,
  },
] as const;

const CYCLE_AND_PIN_CHAINS = [
  {
    id: 'chain-25-into-cycle-error-at-origin',
    body: buildCyclicOriginChain(),
    converts: true,
  },
  {
    id: 'branch-into-cycle-members-preserves-both-fields-pin',
    body: "let a: Record<string, string> = { w: error as never }; let b: Record<string, string> = { x: 'ok' }; if (flag) a = b; if (flag) b = a; let c: Record<string, string> = {}; c = flag ? a : b; return new URLSearchParams(c);",
    converts: true,
  },
  {
    id: 'short-chain-captured-mutation-preserved-pin',
    body: "let a0 = { x: 'ok' as never }; let a1 = { x: 'ok' as never }; a1 = a0; let a2 = { x: 'ok' as never }; a2 = a1; let a3 = { x: 'ok' as never }; a3 = a2; a0.x = error as never; a0 = { x: 'fixed' as never }; return new URLSearchParams(a3);",
    converts: true,
  },
  {
    id: 'short-chain-overwritten-at-tail-drops-error-pin',
    body: "let a0 = { x: error as never }; let a1 = { x: 'ok' as never }; a1 = a0; let a2 = { x: 'ok' as never }; a2 = a1; let a3 = { x: 'ok' as never }; a3 = a2; a3 = { x: 'fixed' as never }; return new URLSearchParams(a3);",
    converts: false,
  },
] as const;

describe('replacement record alias chains', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
    measureChain(api, "return new URLSearchParams({ x: 'warmup' });");
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(SINGLE_CHECK_CHAINS)('$id', ({ body, converts }) => {
    const result = measureChain(api, body);

    expect(result.converts).toBe(converts);
    expect(result.checks).toBe(1);
    expect(result.elapsedMs).toBeLessThan(CHAIN.maxElapsedMs);
  });

  it.each(CYCLE_AND_PIN_CHAINS)('$id', ({ body, converts }) => {
    const result = measureChain(api, body);

    expect(result.converts).toBe(converts);
    expect(result.elapsedMs).toBeLessThan(CHAIN.maxElapsedMs);
  });
});

function measureChain(
  api: API,
  body: string,
): { readonly converts: boolean; readonly checks: number; readonly elapsedMs: number } {
  const source = `function frames(error: Error, flag: boolean) { ${body} }`;
  using parsed = parseModule(api, 'record-alias-chains.ts', source);
  const counter = { checks: 0 };
  const words = {
    error: (value: Parameters<typeof unwrapped>[0]) => {
      counter.checks += 1;
      const unwrappedValue = unwrapped(value);
      return isIdentifier(unwrappedValue) && unwrappedValue.text === 'error';
    },
    typed: () => false,
  };
  let converts = false;
  const startedAt = performance.now();
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isNewExpression(node) && framedSearchParamsText(node, words)) converts = true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return { converts, checks: counter.checks, elapsedMs: performance.now() - startedAt };
}
