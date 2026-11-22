import { isObjectLiteralExpression, isVariableStatement, isVoidExpression } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { proxyOrigin } from '../src/compiler/proxy-origins.ts';
import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Expected refusal reason when an exported value or callable result can expose a `Proxy`. */
const PROXY_REFUSAL =
  'exports a Proxy result that cannot be measured without invoking application traps';

/** Depth and budget bounds (`2^25` visits without presence memoization). */
const SUBGRAPH = {
  depth: 25,
  maxElapsedMs: 100,
  maxVisits: 4,
  pinDepth: 2,
  visitBudget: 64,
} as const;

type SeedKind = 'defined' | 'undefined' | 'unknown';

interface SubgraphCase {
  readonly expectedFound: boolean;
  readonly id: string;
  readonly maxVisits?: number;
  readonly mode: 'budgeted' | 'module';
  readonly seed?: SeedKind;
  readonly source: string;
}

/** Builds a shared `depth`-level expression DAG rooted at `n${depth}` with `step`. */
function buildExpressionDag(
  step: (previous: string, current: string) => string,
  tail: (last: string) => string,
  options: { readonly depth?: number; readonly n0?: string } = {},
): string {
  const depth = options.depth ?? SUBGRAPH.depth;
  const n0 = options.n0 ?? 'seed';
  const lines = [
    "import { seed } from './external';",
    'declare const flag: boolean;',
    'declare const unknownInput: unknown;',
    'const empty = {};',
    'const missing = void 0;',
    `const n0: unknown = ${n0};`,
  ];
  for (let index = 1; index <= depth; index++) {
    lines.push(step(`n${index - 1}`, `n${index}`));
  }
  lines.push(tail(`n${depth}`));
  return lines.join('\n');
}

/** Builds a `depth`-level nested lexical parameter-default chain forwarding into `wrap`. */
function buildNestedUndefinedParameterDag(depth: number = SUBGRAPH.depth): string {
  const lines = [
    "import { seed } from './external';",
    'const empty = {};',
    'const missing = void 0;',
    'function wrap(v: unknown = new Proxy({}, {})) { return v; }',
    'const p0: unknown = seed;',
  ];
  for (let index = 1; index <= depth; index++) {
    lines.push(`function f${index}(p${index}: unknown = p${index - 1}): unknown {`);
    if (index === depth) {
      lines.push(`  return wrap(p${depth});`);
    }
  }
  for (let index = depth; index >= 1; index--) {
    if (index < depth) {
      lines.push(`  return f${index + 1}(p${index});`);
    }
    lines.push('}');
  }
  lines.push('export const root = f1(p0);');
  return lines.join('\n');
}

const CASES: readonly SubgraphCase[] = [
  {
    expectedFound: false,
    id: 'unused-conditional-default-subgraph-on-defined-call',
    maxVisits: 0,
    mode: 'budgeted',
    seed: 'defined',
    source: buildExpressionDag(
      (previous, current) => `const ${current} = flag ? ${previous} : ${previous};`,
      (last) =>
        `function identity(v: unknown) { return v; } function forward(v: unknown = ${last}) { return identity(v); } export const root = forward({});`,
    ),
  },
  {
    expectedFound: false,
    id: 'used-conditional-default-subgraph-on-omitted-argument',
    mode: 'budgeted',
    seed: 'defined',
    source: buildExpressionDag(
      (previous, current) => `const ${current} = flag ? ${previous} : ${previous};`,
      (last) =>
        `function wrap(v: unknown = new Proxy({}, {})) { return v; } function forward(v: unknown = ${last}) { return wrap(v); } export const root = forward();`,
    ),
  },
  {
    expectedFound: false,
    id: 'conditional-default-subgraph-on-unknown-forwarded-argument',
    mode: 'budgeted',
    seed: 'defined',
    source: buildExpressionDag(
      (previous, current) => `const ${current} = flag ? ${previous} : ${previous};`,
      (last) =>
        `function wrap(v: unknown = new Proxy({}, {})) { return v; } function forward(v: unknown = ${last}) { return wrap(v); } export const root = forward(unknownInput);`,
    ),
  },
  {
    expectedFound: false,
    id: 'direct-conditional-subgraph-argument-to-defaulted-callee',
    mode: 'budgeted',
    seed: 'defined',
    source: buildExpressionDag(
      (previous, current) => `const ${current} = flag ? ${previous} : ${previous};`,
      (last) =>
        `function wrap(v: unknown = new Proxy({}, {})) { return v; } export const root = wrap(${last});`,
    ),
  },
  {
    expectedFound: false,
    id: 'logical-and-subgraph-argument-to-defaulted-callee',
    mode: 'budgeted',
    seed: 'defined',
    source: buildExpressionDag(
      (previous, current) => `const ${current} = ${previous} && ${previous};`,
      (last) =>
        `function wrap(v: unknown = new Proxy({}, {})) { return v; } export const root = wrap(${last});`,
    ),
  },
  {
    expectedFound: true,
    id: 'nullish-coalescing-unknown-subgraph-argument',
    mode: 'budgeted',
    seed: 'unknown',
    source: buildExpressionDag(
      (previous, current) => `const ${current} = ${previous} ?? ${previous};`,
      (last) =>
        `function wrap(v: unknown = new Proxy({}, {})) { return v; } export const root = wrap(${last});`,
    ),
  },
  {
    expectedFound: true,
    id: 'nested-parameter-undefined-subgraph',
    mode: 'budgeted',
    seed: 'undefined',
    source: buildNestedUndefinedParameterDag(),
  },
  {
    expectedFound: true,
    id: 'cyclic-nullish-diamond-subgraph',
    mode: 'budgeted',
    seed: 'unknown',
    source: buildExpressionDag(
      (previous, current) => `const ${current}: unknown = ${previous} ?? ${previous};`,
      (last) =>
        `function wrap(v: unknown = new Proxy({}, {})) { return v; } export const root = wrap(${last});`,
      { n0: `seed ?? n${SUBGRAPH.depth}` },
    ),
  },
  {
    expectedFound: true,
    id: 'shared-subgraph-with-undefined-branch-triggers-proxy-default-pin',
    mode: 'module',
    source: buildExpressionDag(
      (previous, current) => `const ${current} = flag ? ${previous} : ${previous};`,
      (last) =>
        `function wrap(v: unknown = new Proxy({}, {})) { return v; } export const root = wrap(${last});`,
      { depth: SUBGRAPH.pinDepth, n0: 'flag ? {} : undefined' },
    ),
  },
  {
    expectedFound: true,
    id: 'shared-subgraph-with-null-through-coalescing-triggers-proxy-default-pin',
    mode: 'module',
    source: [
      'declare const flag: boolean;',
      'function wrap(v: unknown = new Proxy({}, {})) { return v; }',
      'const base = flag ? null : {};',
      'const merged = (flag ? base : base) ?? undefined;',
      'export const root = wrap(merged);',
    ].join('\n'),
  },
  {
    expectedFound: true,
    id: 'distinct-frames-of-same-helper-stay-isolated-pin',
    mode: 'module',
    source: [
      'function wrap(v: unknown = new Proxy({}, {})) { return v; }',
      'function relay(v: unknown) { return wrap(v); }',
      'export const ok = relay({});',
      'export const bad = relay(undefined);',
    ].join('\n'),
  },
  {
    expectedFound: false,
    id: 'distinct-defined-frames-of-same-helper-stay-accepted-pin',
    mode: 'module',
    source: [
      'function wrap(v: unknown = new Proxy({}, {})) { return v; }',
      'function relay(v: unknown) { return wrap(v); }',
      "export const first = relay({}); export const second = relay('ready');",
    ].join('\n'),
  },
];

describe('memoized argument presence across shared default and conditional subgraphs', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Runs `proxyOrigin` on `root`, bounding `seed` visits so exponential traversals fail fast. */
  function evaluateBudgeted(
    source: string,
    seed: SeedKind,
  ): { readonly elapsedMs: number; readonly found: boolean; readonly visits: number } {
    using parsed = parseModule(api, 'proxy-default-subgraphs.ts', source);
    const variables = parsed.sourceFile.statements.filter((statement) =>
      isVariableStatement(statement),
    );
    const emptyNode = variables
      .flatMap((statement) => statement.declarationList.declarations)
      .find((declaration) => {
        return (
          declaration.initializer !== undefined &&
          isObjectLiteralExpression(declaration.initializer)
        );
      })?.initializer;
    const missingNode = variables
      .flatMap((statement) => statement.declarationList.declarations)
      .find(
        (declaration) =>
          declaration.initializer !== undefined && isVoidExpression(declaration.initializer),
      )?.initializer;
    const rootNode = variables.at(-1)?.declarationList.declarations[0]?.initializer;
    if (emptyNode === undefined || missingNode === undefined || rootNode === undefined) {
      throw new Error('Missing expected subgraph declarations.');
    }
    let visits = 0;
    const startedAt = performance.now();
    const origin = proxyOrigin([rootNode], {
      follow: (name) => {
        if (name.text !== 'seed') {
          return;
        }
        visits += 1;
        if (visits > SUBGRAPH.visitBudget) {
          throw new Error(`Exceeded linear presence visit budget (${visits}).`);
        }
        if (seed === 'defined') {
          return emptyNode;
        }
        return seed === 'undefined' ? missingNode : undefined;
      },
    });
    return {
      elapsedMs: performance.now() - startedAt,
      found: origin !== undefined,
      visits,
    };
  }

  /** Evaluates either a whole-module `unsettledIn` check or a visit-budgeted `proxyOrigin` walk. */
  function evaluateCase(entry: SubgraphCase): {
    readonly elapsedMs: number;
    readonly found: boolean;
    readonly visits: number;
  } {
    if (entry.mode === 'module') {
      const startedAt = performance.now();
      using parsed = parseModule(api, 'proxy-default-subgraphs-module.ts', entry.source);
      const refusal = unsettledIn(parsed.sourceFile);
      return {
        elapsedMs: performance.now() - startedAt,
        found: refusal === PROXY_REFUSAL,
        visits: 0,
      };
    }
    return evaluateBudgeted(entry.source, entry.seed ?? 'defined');
  }

  it.each(CASES)('$id', (entry) => {
    const measured = evaluateCase(entry);

    expect(measured.found).toBe(entry.expectedFound);
    expect(measured.visits).toBeLessThanOrEqual(entry.maxVisits ?? SUBGRAPH.maxVisits);
    expect(measured.elapsedMs).toBeLessThan(SUBGRAPH.maxElapsedMs);
  });
});
