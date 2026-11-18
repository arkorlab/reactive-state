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

const LIMITS = {
  fillerCount: 60,
  largeCount: 100,
  linearGrowthCeiling: 6,
  maxSpreadOverhead: 4,
  smallCount: 20,
} as const;

const SCALING_CASES = [
  {
    id: 'linear-shared-tuple-array-from',
    buildBody: (count: number): string => {
      const calls = Array.from({ length: count }, () => 'Array.from(...args);');
      return `const args = [[1], (value: number) => value + 1] as const; ${calls.join(' ')} return 0;`;
    },
    expression: 'helper()',
  },
  {
    id: 'linear-distinct-tuples-array-from',
    buildBody: (count: number): string => {
      const blocks = Array.from(
        { length: count },
        (_, index) =>
          `const a${index} = [[${index}], (value: number) => value + 1] as const; Array.from(...a${index});`,
      );
      return `${blocks.join(' ')} return 0;`;
    },
    expression: 'helper()',
  },
  {
    id: 'linear-callback-free-math-max-spreads',
    buildBody: (count: number): string => {
      const calls = Array.from({ length: count }, () => 'Math.max(...values);');
      return `const values = [1, 2] as const; ${calls.join(' ')} return 0;`;
    },
    expression: 'helper()',
  },
  {
    id: 'linear-json-stringify-tuple-spreads',
    buildBody: (count: number): string => {
      const calls = Array.from({ length: count }, () => 'JSON.stringify(...args);');
      return `const args = [{ ok: true }, ['ok']] as const; ${calls.join(' ')} return 0;`;
    },
    expression: 'helper()',
  },
  {
    id: 'cached-across-repeated-helper-calls',
    buildBody: (count: number): string => {
      const calls = Array.from({ length: count }, () => 'Array.from(...args);');
      return `const args = [[1], (value: number) => value + 1] as const; ${calls.join(' ')} return 0;`;
    },
    expression: '[helper(), helper(), helper()]',
  },
];

const CALLBACK_FREE_SKIP_CASES = [
  {
    baseline: 'Math.max(1, 2)',
    expression: 'Math.max(...sharedNumbers)',
    id: 'skip-expansion-math-max-const-tuple',
  },
  {
    baseline: 'Object.is(1, 1)',
    expression: 'Object.is(...sharedPair)',
    id: 'skip-expansion-object-is-const-tuple',
  },
];

const SOUNDNESS_PINS = [
  {
    id: 'shared-tuple-late-slot-mutation-pin',
    body: 'const args: unknown[] = [[1], (value: number) => value + 1]; Array.from(...(args as [[number]])); Array.from(...(args as [[number]])); args[1] = () => { selected.value = 0; };',
    changed: true,
  },
  {
    id: 'clean-tuple-beside-mutated-sibling-pin',
    body: 'const clean = [[1], (value: number) => value + 1] as const; const bad: unknown[] = [[1]]; bad.push(() => { selected.value = 0; }); void bad; return Array.from(...clean).length;',
    changed: false,
  },
  {
    id: 'mutating-callback-shared-tuple-pin',
    body: 'const args = [[1], () => { selected.value = 0; }] as const; Array.from(...args); Array.from(...args);',
    changed: true,
  },
  {
    id: 'type-query-and-property-name-preserve-tuple-pin',
    body: 'const args = [[1], (value: number) => value + 1] as const; type Shape = typeof args; const meta: Shape | { args: number } = { args: 1 }; void meta; return Array.from(...args).length;',
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

/** Counts AST child-walk invocations while analyzing `expression` against `preamble`. */
function countChildWalks(
  preamble: string,
  expression: string,
): {
  readonly changed: boolean | undefined;
  readonly walks: number;
} {
  const source = [
    'const selected = { value: 1 };',
    'const sharedNumbers = [1, 2] as const;',
    'const sharedPair = [1, 1] as const;',
    preamble,
    'function take(_value: unknown): void {}',
    `take(${expression});`,
  ].join('\n');
  using api = openTypeScript();
  using parsed = parseModule(api, 'argument-native-spread-cache.ts', source);
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

describe('cached tuple-spread proofs and callback-free short-circuits in native calls', () => {
  it.each(SCALING_CASES)('$id', ({ buildBody, expression }) => {
    const small = countChildWalks(
      `function helper() { ${buildBody(LIMITS.smallCount)} }`,
      expression,
    );
    const large = countChildWalks(
      `function helper() { ${buildBody(LIMITS.largeCount)} }`,
      expression,
    );

    expect(small.changed).toBe(false);
    expect(large.changed).toBe(false);
    expect(large.walks / small.walks).toBeLessThanOrEqual(LIMITS.linearGrowthCeiling);
  });

  it.each(CALLBACK_FREE_SKIP_CASES)('$id', ({ baseline, expression }) => {
    const filler = Array.from(
      { length: LIMITS.fillerCount },
      (_, index) => `const filler${index} = ${index}; void filler${index};`,
    ).join('\n');
    const direct = countChildWalks(filler, baseline);
    const spread = countChildWalks(filler, expression);

    expect(direct.changed).toBe(false);
    expect(spread.changed).toBe(false);
    expect(spread.walks - direct.walks).toBeLessThanOrEqual(LIMITS.maxSpreadOverhead);
  });

  it.each(SOUNDNESS_PINS)('$id', ({ body, changed }) => {
    const result = countChildWalks(`function helper() { ${body} }`, 'helper()');

    expect(result.changed).toBe(changed);
  });
});
