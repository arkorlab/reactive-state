import {
  type CallExpression,
  type Identifier,
  isCallExpression,
  isFunctionDeclaration,
  isIdentifier,
  isPrefixUnaryExpression,
  type Node,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { isKept, rootOf } from '../src/compiler/kept.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { writtenBy } from '../src/compiler/written.ts';

const LIMITS = {
  largeCount: 80,
  linearGrowthCeiling: 6,
  maxRootWalks: 8,
  smallCount: 16,
} as const;

/** Builds `count` bracketed calls on `pattern[key](text, '')`. */
function repeatedBracketCalls(count: number): string {
  return Array.from({ length: count }, () => "void pattern[key](text, '');").join(' ');
}

const SCALING_CASES = [
  {
    buildFactory: (count: number): string =>
      `const key = Symbol.replace; const pattern = /a/y; ${repeatedBracketCalls(count)} store.next = () => ++count;`,
    expectedKept: true,
    expectedWrittenRoot: 'pattern',
    id: 'repeated-const-symbol-key-in-startup-factory',
  },
  {
    buildFactory: (count: number): string =>
      `const { replace: key } = { replace: Symbol.replace }; const pattern = /a/y; ${repeatedBracketCalls(count)} store.next = () => ++count;`,
    expectedKept: true,
    expectedWrittenRoot: 'pattern',
    id: 'repeated-destructured-const-symbol-key-in-startup-factory',
  },
  {
    buildFactory: (count: number): string =>
      `let key: symbol = Symbol.search; key = Symbol.replace; const pattern = /a/y; ${repeatedBracketCalls(count)} store.next = () => ++count;`,
    expectedKept: true,
    expectedWrittenRoot: 'pattern',
    id: 'repeated-let-reassigned-symbol-key-in-startup-factory',
  },
  {
    buildFactory: (count: number): string =>
      `const plain = 'plain'; let key: unknown = Symbol.replace; key = plain; const pattern = /a/y; ${Array.from({ length: count }, () => 'void (pattern as unknown as Record<string, (input: string) => unknown>)[key as string](text);').join(' ')} store.next = () => ++count;`,
    expectedKept: true,
    expectedWrittenRoot: undefined,
    id: 'repeated-closed-const-alias-overwrite-let-symbol-key',
  },
  {
    buildFactory: (count: number): string =>
      `let key: symbol = Symbol.search; for (key of [Symbol.replace]) {} const pattern = /a/y; ${repeatedBracketCalls(count)} store.next = () => ++count;`,
    expectedKept: true,
    expectedWrittenRoot: 'pattern',
    id: 'repeated-for-of-assigned-symbol-key-in-startup-factory',
  },
  {
    buildFactory: (count: number): string => {
      const unrelatedWrites = Array.from(
        { length: count },
        (_, index) => `scratch.s${String(index)} = ${String(index)};`,
      ).join(' ');
      return `const scratch: Record<string, number> = {}; ${unrelatedWrites} const key = Symbol.replace; const pattern = /a/y; ${repeatedBracketCalls(count)} store.next = () => ++count;`;
    },
    expectedKept: true,
    expectedWrittenRoot: 'pattern',
    id: 'repeated-symbol-key-beside-many-unrelated-member-writes',
  },
] as const;

const SEMANTIC_PINS = [
  {
    body: [
      'const pattern = /a/y;',
      'let { first, second }: { first: symbol; second: symbol } = { first: Symbol.search, second: Symbol.search };',
      '({ first, second } = { first: Symbol.replace, second: Symbol.search });',
      'void (pattern as unknown as Record<symbol, (input: string) => unknown>)[second](text);',
      'return (pattern as unknown as Record<symbol, (input: string) => unknown>)[first](text);',
    ].join(' '),
    expectedFirstRoot: undefined,
    expectedLastRoot: 'pattern',
    id: 'destructured-pair-separates-sibling-bindings-pin',
  },
  {
    body: [
      'const pattern = /a/y;',
      'let key: symbol = Symbol.replace;',
      'key = Symbol.search;',
      'return (pattern as unknown as Record<symbol, (input: string) => unknown>)[key](text);',
    ].join(' '),
    expectedFirstRoot: undefined,
    expectedLastRoot: undefined,
    id: 'definite-overwrite-cuts-earlier-symbol-replace-pin',
  },
  {
    body: [
      'const pattern = /a/y;',
      'let key: symbol = Symbol.search;',
      'if (false) { key = Symbol.replace; }',
      'return (pattern as unknown as Record<symbol, (input: string) => unknown>)[key](text);',
    ].join(' '),
    expectedFirstRoot: undefined,
    expectedLastRoot: undefined,
    id: 'unselected-false-branch-write-ignored-pin',
  },
  {
    body: [
      'const pattern = /a/y;',
      'let key: symbol = Symbol.search;',
      'for (let index = 0; index < 2; index += 1) {',
      '  void (pattern as unknown as Record<symbol, (input: string) => unknown>)[key](text);',
      '  key = Symbol.replace;',
      '}',
      'return text;',
    ].join(' '),
    expectedFirstRoot: 'pattern',
    expectedLastRoot: 'pattern',
    id: 'loop-backedge-reassignment-reaches-earlier-read-pin',
  },
  {
    body: [
      'const pattern = /a/y;',
      'let key: symbol = Symbol.search;',
      'const flip = () => { key = Symbol.replace; };',
      'flip();',
      'return (pattern as unknown as Record<symbol, (input: string) => unknown>)[key](text);',
    ].join(' '),
    expectedFirstRoot: undefined,
    expectedLastRoot: 'pattern',
    id: 'referenced-closure-write-reaches-outer-read-pin',
  },
  {
    body: [
      'const pattern = /a/y;',
      'let key: symbol = Symbol.search;',
      'function unused() { key = Symbol.replace; }',
      'return (pattern as unknown as Record<symbol, (input: string) => unknown>)[key](text);',
    ].join(' '),
    expectedFirstRoot: undefined,
    expectedLastRoot: undefined,
    id: 'unreferenced-closure-write-ignored-pin',
  },
] as const;

describe('indexed per-file assignment sources across repeated symbol-key pattern writes', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(SCALING_CASES)('$id', ({ buildFactory, expectedKept, expectedWrittenRoot }) => {
    const small = measureFactoryAnalysis(api, buildFactory(LIMITS.smallCount));
    const large = measureFactoryAnalysis(api, buildFactory(LIMITS.largeCount));

    expect(small.kept).toBe(expectedKept);
    expect(large.kept).toBe(expectedKept);
    expect(small.writtenRoot).toBe(expectedWrittenRoot);
    expect(large.writtenRoot).toBe(expectedWrittenRoot);
    expect(large.rootWalks).toBeLessThanOrEqual(LIMITS.maxRootWalks);
    expect(large.childWalks / small.childWalks).toBeLessThanOrEqual(LIMITS.linearGrowthCeiling);
  });

  it.each(SEMANTIC_PINS)('$id', ({ body, expectedFirstRoot, expectedLastRoot }) => {
    const measured = evaluateCallRoots(api, body);

    expect(measured.firstRoot).toBe(expectedFirstRoot);
    expect(measured.lastRoot).toBe(expectedLastRoot);
  });
});

/** Measures `SourceFile` root walks and total AST child walks during `isKept` and `writtenBy`. */
function measureFactoryAnalysis(
  api: API,
  factoryBody: string,
): {
  readonly childWalks: number;
  readonly kept: boolean | undefined;
  readonly rootWalks: number;
  readonly writtenRoot: string | undefined;
} {
  const source = [
    'function makeStore(text: string) {',
    '  let count = 0;',
    '  const store: Record<string, () => number> = {};',
    `  ${factoryBody}`,
    '  return store;',
    '}',
    "export const active = makeStore('a');",
  ].join('\n');
  using parsed = parseModule(api, 'framed-assigned-source-index.ts', source);
  const counter = incrementedCounter(parsed.sourceFile);
  const calls = callsInFunction(parsed.sourceFile, 'makeStore');
  const lastCall = calls.at(-1);
  const sampleStatement = parsed.sourceFile.statements[0];
  const prototype = Object.getPrototypeOf(sampleStatement) as {
    forEachChild: (cbNode: (node: Node) => unknown) => unknown;
  };
  let rootWalks = 0;
  const originalForEachChild = prototype.forEachChild;
  const spy = vi.spyOn(prototype, 'forEachChild').mockImplementation(function spyWalk(
    this: Node,
    cbNode: (node: Node) => unknown,
  ) {
    if (this === parsed.sourceFile) {
      rootWalks += 1;
    }
    return originalForEachChild.call(this, cbNode);
  });
  try {
    const kept = counter === undefined ? undefined : isKept(counter, writtenBy);
    const primary = lastCall === undefined ? undefined : writtenBy(lastCall);
    const writtenRoot = primary === undefined ? undefined : rootOf(primary)?.text;
    return { childWalks: spy.mock.calls.length, kept, rootWalks, writtenRoot };
  } finally {
    spy.mockRestore();
  }
}

/** Evaluates `writtenBy` on the first and final call expressions inside `check`. */
function evaluateCallRoots(
  api: API,
  body: string,
): { readonly firstRoot: string | undefined; readonly lastRoot: string | undefined } {
  using parsed = parseModule(
    api,
    'framed-assigned-source-semantics.ts',
    `export function check(text: string) { ${body} }\n`,
  );
  const calls = callsInFunction(parsed.sourceFile, 'check');
  const firstCall = calls[0];
  const lastCall = calls.at(-1);
  const firstPrimary = firstCall === undefined ? undefined : writtenBy(firstCall);
  const lastPrimary = lastCall === undefined ? undefined : writtenBy(lastCall);
  return {
    firstRoot: firstPrimary === undefined ? undefined : rootOf(firstPrimary)?.text,
    lastRoot: lastPrimary === undefined ? undefined : rootOf(lastPrimary)?.text,
  };
}

/** Finds the `count` identifier inside `++count`. */
function incrementedCounter(file: SourceFile): Identifier | undefined {
  let found: Identifier | undefined;
  const pending: Node[] = [file];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (
      isPrefixUnaryExpression(current) &&
      current.operator === SyntaxKind.PlusPlusToken &&
      isIdentifier(current.operand)
    ) {
      found = current.operand;
      break;
    }
    current.forEachChild((child) => {
      pending.push(child);
    });
  }
  return found;
}

/** Collects call expressions in source order within the named function declaration. */
function callsInFunction(file: SourceFile, fnName: string): readonly CallExpression[] {
  const fn = file.statements.find(
    (statement) => isFunctionDeclaration(statement) && statement.name?.text === fnName,
  );
  if (fn === undefined) {
    return [];
  }
  const calls: CallExpression[] = [];
  const visit = (node: Node): void => {
    if (isCallExpression(node)) {
      calls.push(node);
    }
    node.forEachChild(visit);
  };
  visit(fn);
  return calls;
}
