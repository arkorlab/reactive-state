import {
  type Identifier,
  isIdentifier,
  isPrefixUnaryExpression,
  type Node,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';
import { describe, expect, it, vi } from 'vitest';

import { isKept } from '../src/compiler/kept.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { writtenBy } from '../src/compiler/written.ts';

const LIMITS = {
  largeCount: 120,
  linearGrowthCeiling: 7,
  smallCount: 20,
} as const;

/** Builds `count` reverse-ordered `v_i.next = v_{i+1}` links ending at `result`. */
function reverseMemberChain(count: number): string {
  const declarations = Array.from(
    { length: count },
    (_, index) => `const v${index}: Record<string, unknown> = {};`,
  );
  const links = Array.from({ length: count }, (_, index) => {
    const target = index + 1 === count ? 'result' : `v${index + 1}`;
    return `v${index}.next = ${target};`;
  });
  return [...declarations, ...links].join(' ');
}

const SCALING_CASES = [
  {
    buildBody: (count: number): string => `${reverseMemberChain(count)} v0.fn = () => ++count;`,
    id: 'linear-reverse-member-links',
    kept: true,
  },
  {
    buildBody: (count: number): string => {
      const declarations = Array.from(
        { length: count },
        (_, index) => `const v${index}: object[] = [{}];`,
      );
      const links = Array.from({ length: count }, (_, index) => {
        const target = index + 1 === count ? 'result' : `v${index + 1}`;
        return `v${index}[0] = ${target};`;
      });
      return `${declarations.join(' ')} ${links.join(' ')} Object.assign(...v0, { fn: () => ++count });`;
    },
    id: 'linear-reverse-mutated-spread-containers',
    kept: true,
  },
  {
    buildBody: (count: number): string => {
      const links = Array.from({ length: count }, (_, index) => {
        const keyword = index === 0 ? 'const' : 'var';
        const target = index + 1 === count ? 'result' : `c${index + 1}`;
        return `${keyword} c${index}: unknown[] = [${target}];`;
      });
      return `${links.join(' ')} c0.push(() => ++count);`;
    },
    id: 'linear-reverse-variable-initializer-containers',
    kept: true,
  },
  {
    buildBody: (count: number): string => {
      const aliases = Array.from({ length: count }, (_, index) => {
        const origin = index === 0 ? 'base' : `a${index - 1}`;
        return `const a${index} = ${origin};`;
      });
      const writes = Array.from(
        { length: count },
        (_, index) => `a${count - 1 - index}.step = result;`,
      );
      return `const base: object[] = [{}]; ${aliases.join(' ')} ${writes.join(' ')} Object.assign(...base, { fn: () => ++count });`;
    },
    id: 'linear-reverse-direct-alias-member-writes',
    kept: true,
  },
  {
    buildBody: (count: number): string =>
      `const localOnly: Record<string, unknown> = {}; ${reverseMemberChain(count)} localOnly.fn = () => ++count;`,
    id: 'linear-reverse-chain-beside-unreturned-writer',
    kept: false,
  },
];

const FUNCTIONAL_CASES = [
  {
    body: 'const a: Record<string, unknown> = {}; const b: Record<string, unknown> = {}; const c: Record<string, unknown> = {}; a.next = b; b.next = c; c.next = result; a.fn = () => ++count;',
    id: 'reverse-three-hop-member-chain-kept',
    kept: true,
  },
  {
    body: 'const a: unknown[] = [{}]; const b: unknown[] = [{}]; a[0] = b; b[0] = result; a.push(() => ++count);',
    id: 'reverse-mutated-array-container-chain-kept',
    kept: true,
  },
  {
    body: 'const a: Record<string, unknown> = {}; const b: Record<string, unknown> = {}; a.next = b; b.next = a; b.tail = result; a.fn = () => ++count;',
    id: 'cyclic-two-node-links-reaching-result-kept',
    kept: true,
  },
  {
    body: 'const a: Record<string, unknown> = {}; const b: Record<string, unknown> = {}; a.next = b; b.next = a; a.fn = () => ++count;',
    id: 'cyclic-disconnected-island-not-kept',
    kept: false,
  },
  {
    body: 'const top: Record<string, unknown> = {}; const leftBranch: Record<string, unknown> = {}; const rightBranch: Record<string, unknown> = {}; top.left = leftBranch; top.right = rightBranch; leftBranch.next = result; rightBranch.next = result; top.fn = () => ++count;',
    id: 'branching-diamond-reverse-links-kept',
    kept: true,
  },
  {
    body: 'const flag = Boolean(1); const fallback: Record<string, unknown> = {}; const maybe: Record<string, unknown> | undefined = undefined; const a: Record<string, unknown> = {}; const b: Record<string, unknown> = {}; a.next = flag ? b : fallback; b.next = maybe ?? result; a.fn = () => ++count;',
    id: 'conditional-and-nullish-carrier-reverse-links-kept',
    kept: true,
  },
  {
    body: 'const args: object[] = [{}]; const alias1 = args; const alias2 = alias1; alias2[0] = result; Object.assign(...args, { fn: () => ++count });',
    id: 'reverse-aliased-spread-holder-mutation-kept',
    kept: true,
  },
  {
    body: 'const localOnly: Record<string, unknown> = { fn: () => ++count }; let alias: Record<string, unknown> = localOnly; alias = result; const other: Record<string, unknown> = {}; alias.extra = other;',
    id: 'rebind-only-after-unreturned-init-not-kept',
    kept: false,
  },
  {
    body: `${reverseMemberChain(LIMITS.largeCount)} v0.fn = () => ++count;`,
    id: 'deep-120-link-reverse-chain-functional-propagation',
    kept: true,
  },
];

/** The `count` identifier incremented by `++count` in `file`. */
function incrementedCounter(file: SourceFile): Identifier | undefined {
  let found: Identifier | undefined;
  const visit = (node: Node): void => {
    if (
      found === undefined &&
      isPrefixUnaryExpression(node) &&
      node.operator === SyntaxKind.PlusPlusToken &&
      isIdentifier(node.operand)
    ) {
      found = node.operand;
      return;
    }
    if (found === undefined) {
      node.forEachChild(visit);
    }
  };
  visit(file);
  return found;
}

/** Measures deterministic AST child walks and Set membership checks during `isKept`. */
function measureKeptAnalysis(body: string): {
  readonly kept: boolean | undefined;
  readonly lookups: number;
  readonly walks: number;
} {
  const source = [
    'function makeStore() {',
    '  let count = 0;',
    '  const result: Record<string, unknown> = {};',
    `  ${body}`,
    '  return result;',
    '}',
    'export const active = makeStore();',
  ].join('\n');
  using api = openTypeScript();
  using parsed = parseModule(api, 'kept-reverse-holder-worklist.ts', source);
  const counter = incrementedCounter(parsed.sourceFile);
  const sampleStatement = parsed.sourceFile.statements[0];
  const prototype = Object.getPrototypeOf(sampleStatement) as {
    forEachChild: (cbNode: (node: Node) => unknown) => unknown;
  };
  const walkSpy = vi.spyOn(prototype, 'forEachChild');
  const setSpy = vi.spyOn(Set.prototype, 'has');
  try {
    const kept = counter === undefined ? undefined : isKept(counter, writtenBy);
    return { kept, lookups: setSpy.mock.calls.length, walks: walkSpy.mock.calls.length };
  } finally {
    setSpy.mockRestore();
    walkSpy.mockRestore();
  }
}

describe('worklist propagation of reverse-ordered watched holders in kept analysis', () => {
  it.each(SCALING_CASES)('$id', ({ buildBody, kept }) => {
    const small = measureKeptAnalysis(buildBody(LIMITS.smallCount));
    const large = measureKeptAnalysis(buildBody(LIMITS.largeCount));

    expect(small.kept).toBe(kept);
    expect(large.kept).toBe(kept);
    expect(large.walks / small.walks).toBeLessThanOrEqual(LIMITS.linearGrowthCeiling);
    expect(large.lookups / small.lookups).toBeLessThanOrEqual(LIMITS.linearGrowthCeiling);
  });

  it.each(FUNCTIONAL_CASES)('$id', ({ body, kept }) => {
    const measured = measureKeptAnalysis(body);

    expect(measured.kept).toBe(kept);
  });
});
