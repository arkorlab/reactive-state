import {
  type Expression,
  type Identifier,
  isExpressionStatement,
  isIdentifier,
  isVariableStatement,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Constant, constantValue } from '../src/compiler/numbers.ts';

/** How long the constants of a chain are: each reads the one before it twice. */
const LENGTH = 18;

/** Computing a chain's last constant takes less than this, as long as the chain is. */
const BUDGET_MS = 1000;

/**
 * A constant that several others read is computed once, not once for each read: a chain of
 * constants that each read the one before twice (`const a2 = a1 + a1`) is as long to compute as it
 * is long, not twice as long for each constant. The rows marked a pin answer the same before the
 * change as after it.
 */

/** The constants `a1` … `aN`, each of `make` of the one before, after `first`. */
function chainOf(first: string, make: (before: string) => string): string {
  const declarations = Array.from({ length: LENGTH }, (_, at) => {
    const before = `a${String(at)}`;
    return `const a${String(at + 1)} = ${make(before)};`;
  });
  return [first, ...declarations].join('\n');
}

const SHAPES = [
  {
    answer: 2 ** LENGTH,
    chain: chainOf('const a0 = 1;', (before) => `${before} + ${before}`),
    what: 'sums of numbers',
  },
  {
    answer: undefined,
    chain: chainOf('declare const a0: number;', (before) => `Math.max(${before}, ${before})`),
    what: 'calls of a name the code does not show',
  },
  {
    answer: 2 ** LENGTH,
    chain: chainOf("const a0 = '1';", (before) => `${before} * 1 + ${before} * 1`),
    what: 'sums of text made numbers',
  },
] as const;

const PINS = [
  {
    answer: 6,
    module: 'const a = 1; const b = a + 2; const c = a + 3; const last = b + c - 1;',
    what: 'a name two others read (pin)',
  },
  {
    answer: undefined,
    module: 'const a = b + 1; const b = a + 1; const last = a;',
    what: 'a cycle (pin)',
  },
  {
    answer: undefined,
    module: 'const a = b + 1; const b = a + 1; const last = Math.max(a, b);',
    what: 'a cycle read twice (pin)',
  },
  { answer: undefined, module: 'const last = last + 1;', what: 'a name that reads itself (pin)' },
  {
    answer: 4,
    module: "const a = '2'; const b = a; const c = b; const last = c * c;",
    what: 'aliases of text (pin)',
  },
] as const;

describe('the constant a chain of constants ends in', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** What `last`, the module's last constant, computes to, and how long it took to tell. */
  function computed(module: string): {
    readonly answer: Constant | undefined;
    readonly took: number;
  } {
    using parsed = api.createSourceFile('numbers.ts', `${module}\nlast;\n`);
    const constants = new Map<string, Expression>();
    for (const statement of parsed.sourceFile.statements) {
      if (!isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (isIdentifier(declaration.name) && declaration.initializer !== undefined) {
          constants.set(declaration.name.text, declaration.initializer);
        }
      }
    }
    const read = parsed.sourceFile.statements.at(-1);
    if (read === undefined || !isExpressionStatement(read)) throw new Error('No read ends it.');
    const started = performance.now();
    const answer = constantValue(read.expression, (name: Identifier) => constants.get(name.text));
    return { answer, took: performance.now() - started };
  }

  it.each(SHAPES)('computes a chain of $what in time', ({ answer, chain }) => {
    const done = computed(`${chain}\nconst last = a${String(LENGTH)};`);

    expect(done.answer).toBe(answer);
    // Each constant was computed for every read of it: seconds, as long as the chain.
    expect(done.took).toBeLessThan(BUDGET_MS);
  });

  it.each(PINS)('$what', ({ answer, module }) => {
    expect(computed(module).answer).toBe(answer);
  });
});
