import {
  isObjectLiteralExpression,
  isVariableDeclaration,
  type Node,
  type ObjectLiteralExpression,
} from 'typescript/ast';
import { type API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { functionRead } from '../src/compiler/function-reads.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const NAME_REASON = "reads `name` of a function, which each side's bundle writes otherwise";
const DIAMOND_DEPTH = 10;

function buildSpreadDiamond(depth: number, rootBody: string, tailSuffix: string): string {
  const parts = [`const m0 = ${rootBody};`];
  for (let index = 1; index < depth; index += 1) {
    parts.push(`const m${index} = { ...m${index - 1}, ...m${index - 1} };`);
  }
  parts.push(`const m${depth} = { ...m${depth - 1}, ...m${depth - 1}${tailSuffix} };`);
  return parts.join(' ');
}

function buildProtoSpreadDiamond(): string {
  const depth = DIAMOND_DEPTH;
  const parts = ['function named() {} const m0 = { swap() { this.pick = named; } };'];
  for (let index = 1; index < depth; index += 1) {
    parts.push(`const m${index} = { __proto__: m${index - 1}, ...m${index - 1} };`);
  }
  parts.push(
    `const m${depth} = { __proto__: m${depth - 1}, ...m${depth - 1}, pick() {} }; (m${depth} as { swap?: () => void }).swap?.(); export const out = m${depth}.pick.name;`,
  );
  return parts.join(' ');
}

function buildMemberCallableDiamond(): string {
  const depth = DIAMOND_DEPTH;
  const parts = [
    'function named() {} export function out(flag: boolean) { const m0 = { swap() { this.pick = named; } };',
  ];
  for (let index = 1; index < depth; index += 1) {
    parts.push(`const m${index} = { swap: flag ? m${index - 1}.swap : m${index - 1}.swap };`);
  }
  parts.push(
    `const m${depth} = { swap: flag ? m${depth - 1}.swap : m${depth - 1}.swap, pick() {} }; m${depth}.swap(); return m${depth}.pick.name; }`,
  );
  return parts.join(' ');
}

function buildAssignDiamond(): string {
  const depth = DIAMOND_DEPTH;
  const parts = ['function named() {} const m0 = { swap() { this.pick = named; } };'];
  for (let index = 1; index <= depth; index += 1) {
    const extra = index === depth ? 'pick() {}' : '';
    parts.push(
      `const m${index} = { ${extra} }; Object.assign(m${index}, m${index - 1}, m${index - 1});`,
    );
  }
  parts.push(
    `(m${depth} as { swap?: () => void }).swap?.(); export const out = m${depth}.pick.name;`,
  );
  return parts.join(' ');
}

/**
 * Nested `objectCallables` lookups consult and populate `OBJECT_CALLABLES` whenever a subtree does
 * not truncate an active cycle back-edge, keeping diamond spread/prototype/`Object.assign` graphs
 * linear in object count while leaving cyclic subgraphs uncached.
 */
const CASES = [
  {
    id: 'repeated-spread-diamond-safe-method-linear-walks',
    maxRootReads: 4,
    reason: undefined,
    source: `${buildSpreadDiamond(22, '{ pick() {} }', '')} export const out = m22.pick.name;`,
  },
  {
    id: 'repeated-spread-diamond-this-writer-linear-walks',
    maxRootReads: 4,
    reason: NAME_REASON,
    source: `function named() {} ${buildSpreadDiamond(11, '{ swap() { this.pick = named; } }', ', pick() {}')} m11.swap(); export const out = m11.pick.name;`,
  },
  {
    id: 'repeated-prototype-and-spread-diamond-linear-walks',
    maxRootReads: 4,
    reason: NAME_REASON,
    source: buildProtoSpreadDiamond(),
  },
  {
    id: 'repeated-member-callable-diamond-linear-walks',
    maxRootReads: 4,
    reason: NAME_REASON,
    source: buildMemberCallableDiamond(),
  },
  {
    id: 'repeated-object-assign-diamond-linear-walks',
    maxRootReads: 4,
    reason: NAME_REASON,
    source: buildAssignDiamond(),
  },
  {
    id: 'mutual-let-spread-cycle-terminates-and-retains-writer-pin',
    maxRootReads: 12,
    reason: NAME_REASON,
    source:
      'function named() {} const m0 = { swap() { (this as { pick?: () => void }).pick = named; } }; let loop: Record<string, unknown> = {}; const a: Record<string, unknown> = { ...m0, ...loop }; loop = a; const helpers = { ...a, pick() {} }; (helpers as { swap?: () => void }).swap?.(); export const out = helpers.pick.name;',
  },
  {
    id: 'acyclic-root-shared-with-cycle-still-propagates-writer-pin',
    maxRootReads: 12,
    reason: NAME_REASON,
    source:
      'function named() {} const m0 = { swap() { (this as { pick?: () => void }).pick = named; } }; let cycle: Record<string, unknown> = {}; const ring: Record<string, unknown> = { ...cycle, ...m0 }; cycle = ring; void ring; const helpers = { ...m0, pick() {} }; helpers.swap(); export const out = helpers.pick.name;',
  },
  {
    id: 'single-parent-spread-chain-safe-method-pin',
    maxRootReads: 8,
    reason: undefined,
    source:
      'const m0 = { pick() {} }; const m1 = { ...m0 }; const m2 = { ...m1 }; const m3 = { ...m2 }; export const out = m3.pick.name;',
  },
] as const;

/** Finds the `ObjectLiteralExpression` initializer of `const m0 = { ... }`. */
function findRootLiteral(root: Node): ObjectLiteralExpression | undefined {
  let target: ObjectLiteralExpression | undefined;
  const visit = (node: Node): void => {
    if (target !== undefined) {
      return;
    }
    if (
      isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      isObjectLiteralExpression(node.initializer)
    ) {
      target = node.initializer;
      return;
    }
    node.forEachChild(visit);
  };
  visit(root);
  return target;
}

/** Measures `m0.properties` getter invocations while running `functionRead` over `root`. */
function measureRootReads(root: Node): {
  readonly found: string | undefined;
  readonly rootReads: number;
} {
  const m0 = findRootLiteral(root);
  if (m0 === undefined) {
    return { found: undefined, rootReads: 0 };
  }
  const initial = m0.properties;
  let rootReads = 0;
  Object.defineProperty(m0, 'properties', {
    configurable: true,
    get(): ObjectLiteralExpression['properties'] {
      rootReads += 1;
      return initial;
    },
  });
  let found: string | undefined;
  const visit = (node: Node): void => {
    if (found !== undefined) {
      return;
    }
    found = functionRead(node);
    if (found === undefined) {
      node.forEachChild(visit);
    }
  };
  visit(root);
  return { found, rootReads };
}

describe('memoized acyclic object callable lookups across spread graphs', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ maxRootReads, reason, source }) => {
    using parsed = parseModule(api, 'function-spread-memoization.ts', source);
    const { found, rootReads } = measureRootReads(parsed.sourceFile);

    expect(found).toBe(reason);
    expect(rootReads).toBeLessThanOrEqual(maxRootReads);
  });
});
