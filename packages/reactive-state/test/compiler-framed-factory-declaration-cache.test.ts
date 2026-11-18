import {
  isCallExpression,
  isFunctionDeclaration,
  isIdentifier,
  isPropertyAccessExpression,
  type Node,
} from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { isErased } from '../src/compiler/code-globals.ts';
import { framedWrittenErrorVariable } from '../src/compiler/framed-written-error-bindings.ts';
import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const SCALE = {
  count: 80,
  maxRenderBodyWalks: 6,
} as const;

function buildRepeatedFactorySource(count: number, bodyText: string): string {
  const bindings: string[] = [];
  for (let index = 0; index < count; index++) {
    bindings.push(`const e${index}: Error = make(); void String(e${index});`);
  }
  return `function make() { ${bodyText} } function render() { ${bindings.join(' ')} }`;
}

function buildDistinctFactoriesSource(count: number): string {
  const factories: string[] = [];
  const bindings: string[] = [];
  for (let index = 0; index < count; index++) {
    factories.push(`function make${index}() { return new Error('fixed-${index}'); }`);
    bindings.push(`const e${index}: Error = make${index}(); void String(e${index});`);
  }
  return `${factories.join(' ')} function render() { ${bindings.join(' ')} }`;
}

const SCALING_CASES = [
  {
    expectedCount: SCALE.count,
    id: 'repeated-80-safe-factory-calls-cached',
    source: buildRepeatedFactorySource(SCALE.count, "return new Error('fixed');"),
  },
  {
    expectedCount: SCALE.count,
    id: 'distinct-80-safe-factories-single-file-index',
    source: buildDistinctFactoriesSource(SCALE.count),
  },
  {
    expectedCount: 40,
    id: 'repeated-factory-with-nested-helper-cached',
    source: buildRepeatedFactorySource(
      40,
      "function label() { return 'fixed'; } return new Error(label());",
    ),
  },
] as const;

const SEMANTIC_CASES = [
  {
    id: 'reassigned-factory-still-refused-across-repeated-calls',
    source: `function make() { return new Error('fixed'); } function swap(external: Error) { make = () => external; } function render() { const e0: Error = make(); const e1: Error = make(); return String(e0) + String(e1); }`,
    framed: true,
  },
  {
    id: 'destructured-reassignment-of-factory-refused',
    source: `function make() { return new Error('fixed'); } function swap(external: Error) { [make] = [() => external]; } function render() { const local: Error = make(); return String(local); }`,
    framed: true,
  },
  {
    id: 'overloaded-factory-with-single-body-accepted',
    source: `function make(): Error; function make(tag?: string): Error { return new Error(tag ?? 'fixed'); } function render() { const e0: Error = make(); const e1: Error = make('ok'); return String(e0) + String(e1); }`,
    framed: false,
  },
  {
    id: 'overloaded-factory-reassigned-refused',
    source: `function make(): Error; function make(): Error { return new Error('fixed'); } function swap(external: Error) { ({ make } = { make: () => external }); } function render() { const local: Error = make(); return local.message; }`,
    framed: true,
  },
  {
    id: 'duplicate-function-bodies-in-same-scope-refused',
    source: `function make() { return new Error('fixed'); } function make() { return new Error('other'); } function render() { const local: Error = make(); return String(local); }`,
    framed: true,
  },
  {
    id: 'shadowed-sibling-reassignment-keeps-outer-factory-unchanged',
    source: `function make() { return new Error('fixed'); } function unrelated() { let make = 0; make = 1; return make; } function render() { const e0: Error = make(); const e1: Error = make(); return String(e0) + String(e1); }`,
    framed: false,
  },
  {
    id: 'unquiet-call-among-cached-safe-calls-still-refused',
    source: `function make(value?: unknown) { return new Error(value === undefined ? 'fixed' : String(value)); } function render(external: Error) { const e0: Error = make(); const e1: Error = make([external]); return String(e0) + String(e1); }`,
    framed: true,
  },
] as const;

describe('cached function declaration immutability in error factory proofs', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(SCALING_CASES)('$id', ({ expectedCount, source }) => {
    const result = measureWrittenProofWalks(api, source);

    expect(result.provenCount).toBe(expectedCount);
    expect(result.renderBodyWalks).toBeLessThanOrEqual(SCALE.maxRenderBodyWalks);
  });

  it.each(SEMANTIC_CASES)('$id', ({ framed, source }) => {
    expect(readsFrames(api, source)).toBe(framed);
  });
});

function measureWrittenProofWalks(
  api: API,
  source: string,
): { readonly provenCount: number; readonly renderBodyWalks: number } {
  using parsed = parseModule(api, 'factory-declaration-cache.ts', source);
  const targets: Node[] = [];
  let renderBody: Node = parsed.sourceFile;
  const collect: Node[] = [parsed.sourceFile];
  for (let node = collect.pop(); node !== undefined; node = collect.pop()) {
    if (isFunctionDeclaration(node) && node.name?.text === 'render' && node.body !== undefined) {
      renderBody = node.body;
    }
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === 'String' &&
      node.arguments[0] !== undefined
    ) {
      targets.push(node.arguments[0]);
    }
    node.forEachChild((child) => {
      collect.push(child);
    });
  }
  const spy = vi.spyOn(renderBody, 'forEachChild');
  let provenCount = 0;
  for (const target of targets) {
    if (
      isIdentifier(target) &&
      framedWrittenErrorVariable(target, { keys: [], made: false }, (_value, made) => made)
    ) {
      provenCount += 1;
    }
  }
  const renderBodyWalks = spy.mock.calls.length;
  spy.mockRestore();
  return { provenCount, renderBodyWalks };
}

function readsFrames(api: API, source: string): boolean {
  using parsed = parseModule(api, 'factory-declaration-semantics.ts', source);
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isErased(node)) continue;
    if (
      (isCallExpression(node) || isPropertyAccessExpression(node)) &&
      framedRead(node) !== undefined
    ) {
      return true;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
