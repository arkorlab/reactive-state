import {
  type Expression,
  isCallExpression,
  isClassDeclaration,
  isExpressionStatement,
  isFunctionDeclaration,
  isIdentifier,
  type Node,
  type SourceFile,
} from 'typescript/ast';
import { describe, expect, it, vi } from 'vitest';

import { argumentChanges } from '../src/compiler/argument-effects.ts';
import { unwrapped } from '../src/compiler/bounded.ts';
import { declarationOf, initializerOf } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const SMALL_COUNT = 20;
const LARGE_COUNT = 100;
const LINEAR_GROWTH_CEILING = 6;

const SCALING_CASES = [
  {
    id: 'linear-indexed-slot-writes',
    buildBody: (count: number): string => {
      const writes = Array.from({ length: count }, (_, index) => `values[${index}] = ${index};`);
      return `const values: number[] = []; ${writes.join(' ')} return values.length;`;
    },
    expression: 'helper()',
  },
  {
    id: 'linear-push-and-length-writes',
    buildBody: (count: number): string => {
      const writes = Array.from({ length: count }, (_, index) =>
        index % 2 === 0 ? `values.push(${index});` : `values.length = ${index};`,
      );
      return `const values: number[] = []; ${writes.join(' ')} return values.length;`;
    },
    expression: 'helper()',
  },
  {
    id: 'linear-distinct-local-arrays',
    buildBody: (count: number): string => {
      const blocks = Array.from(
        { length: count },
        (_, index) => `const a${index}: number[] = []; a${index}[0] = ${index};`,
      );
      return `${blocks.join(' ')} return a0.length;`;
    },
    expression: 'helper()',
  },
  {
    id: 'cached-across-repeated-helper-calls',
    buildBody: (count: number): string => {
      const writes = Array.from({ length: count }, (_, index) => `values[${index}] = ${index};`);
      return `const values: number[] = []; ${writes.join(' ')} return values.length;`;
    },
    expression: '[helper(), helper(), helper(), helper()]',
  },
];

const SOUNDNESS_PINS = [
  {
    id: 'fresh-sibling-beside-reassigned-sibling-pin',
    body: 'const clean: number[] = []; clean[0] = 1; clean[1] = 2; let bad: number[] = []; bad = sharedItems; bad[0] = 3;',
    changed: true,
  },
  {
    id: 'many-slot-writes-then-late-reassignment-pin',
    body: 'let values: number[] = []; values[0] = 1; values[1] = 2; values[2] = 3; values = sharedItems;',
    changed: true,
  },
  {
    id: 'many-slot-writes-then-duplicate-var-pin',
    body: 'var values: number[] = []; values[0] = 1; values[1] = 2; var values = sharedItems;',
    changed: true,
  },
  {
    id: 'two-clean-local-arrays-pin',
    body: 'const first: number[] = []; first[0] = 1; first.push(2); const second: number[] = []; second[0] = 3; second.length = 1; return first.length + second.length;',
    changed: false,
  },
];

/** Constant and declaration resolution matching the caller's static callee lookup. */
function calleeOf(node: Expression): Node | undefined {
  let value = unwrapped(node);
  const seen = new Set<Expression>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const declared = declarationOf(value);
    if (
      declared !== undefined &&
      (isFunctionDeclaration(declared) || isClassDeclaration(declared))
    ) {
      return declared;
    }
    const initial = initializerOf(value);
    if (initial === undefined) {
      return value;
    }
    value = unwrapped(initial);
  }
  return value;
}

/** The argument passed to the trailing `take(...)` call in `file`. */
function testedArgument(file: SourceFile): Expression | undefined {
  const last = file.statements.at(-1);
  const call = last !== undefined && isExpressionStatement(last) ? last.expression : undefined;
  return call !== undefined && isCallExpression(call) ? call.arguments[0] : undefined;
}

/** Counts AST child-walk invocations while analyzing `expression` against `body`. */
function countChildWalks(
  body: string,
  expression: string,
): {
  readonly changed: boolean | undefined;
  readonly walks: number;
} {
  const source = [
    'const sharedItems = [1];',
    `function helper() { ${body} }`,
    'function take(_value: unknown): void {}',
    `take(${expression});`,
  ].join('\n');
  using api = openTypeScript();
  using parsed = parseModule(api, 'argument-local-array-cache.ts', source);
  const argument = testedArgument(parsed.sourceFile);
  const sampleStatement = parsed.sourceFile.statements[0];
  const prototype = Object.getPrototypeOf(sampleStatement) as {
    forEachChild: (cbNode: (node: Node) => unknown) => unknown;
  };
  const spy = vi.spyOn(prototype, 'forEachChild');
  try {
    const changed = argument === undefined ? undefined : argumentChanges(argument, calleeOf);
    return { changed, walks: spy.mock.calls.length };
  } finally {
    spy.mockRestore();
  }
}

describe('cached local-array proofs across helper storage writes', () => {
  it.each(SCALING_CASES)('$id', ({ buildBody, expression }) => {
    const small = countChildWalks(buildBody(SMALL_COUNT), expression);
    const large = countChildWalks(buildBody(LARGE_COUNT), expression);

    expect(small.changed).toBe(false);
    expect(large.changed).toBe(false);
    expect(large.walks / small.walks).toBeLessThanOrEqual(LINEAR_GROWTH_CEILING);
  });

  it.each(SOUNDNESS_PINS)('$id', ({ body, changed }) => {
    const result = countChildWalks(body, 'helper()');

    expect(result.changed).toBe(changed);
  });
});
