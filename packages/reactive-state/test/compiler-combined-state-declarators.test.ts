import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { constantOf, type Reading, stateStatementOf } from '../src/compiler/statements.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

interface Case {
  readonly id: string;
  readonly mode: 'constant' | 'state';
  readonly source: string;
  readonly expected: string;
}

const HOOKS = new Set(['useEstimate', 'useFilter']);

/**
 * `stateStatementOf` inspects every declarator and synchronous sub-expression of a variable
 * statement so combined, wrapped, projected, or nested state and custom-hook calls are refused.
 */
const CASES: readonly Case[] = [
  {
    expected: 'refused:State is declared on its own, with `const`',
    id: 'state-in-second-declarator-state-check',
    mode: 'state',
    source: 'const regular = 0, [value, setValue] = useReactiveState(initial);',
  },
  {
    expected: 'refused:State is declared on its own, with `const`',
    id: 'state-in-second-declarator-constant-check',
    mode: 'constant',
    source: 'const regular = 0, [value, setValue] = useReactiveState(initial);',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'custom-hook-in-second-declarator-constant-check',
    mode: 'constant',
    source: 'const regular = 0, [estimate, increase] = useEstimate(initial);',
  },
  {
    expected: 'refused:State is declared on its own, with `const`',
    id: 'let-combined-declarator-with-state',
    mode: 'state',
    source: 'let regular = 0, [value, setValue] = useReactiveState(initial);',
  },
  {
    expected: 'refused:State is declared on its own, with `const`',
    id: 'parenthesized-intrinsic-call',
    mode: 'constant',
    source: 'const [value, setValue] = (useReactiveState(initial));',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'parenthesized-custom-hook-call',
    mode: 'constant',
    source: 'const [estimate, increase] = (useEstimate(initial));',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'projected-custom-hook-result-in-constant',
    mode: 'constant',
    source: 'const estimate = useEstimate(initial)[0];',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'binding-default-custom-hook-call',
    mode: 'constant',
    source: 'const [estimate = useEstimate(initial)[0]] = list;',
  },
  {
    expected: 'refused:`useFilter` is called on its own, with `const`, as state is declared',
    id: 'nested-hook-inside-hook-argument',
    mode: 'state',
    source: 'const [estimate, increase] = useEstimate(useFilter(initial));',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'optional-chaining-hook-call',
    mode: 'state',
    source: 'const [estimate, increase] = useEstimate?.(initial);',
  },
  {
    expected: 'state:value:setValue',
    id: 'valid-state-declaration-pin',
    mode: 'state',
    source: 'const [value, setValue] = useReactiveState(initial);',
  },
  {
    expected: 'hook:useEstimate',
    id: 'valid-custom-hook-declaration-pin',
    mode: 'state',
    source: 'const [estimate, increase] = useEstimate(initial);',
  },
  {
    expected: 'refused:State is declared on its own, with `const`',
    id: 'first-declarator-combined-state-pin',
    mode: 'state',
    source: 'const [first, setFirst] = useReactiveState(a), regular = 0;',
  },
  {
    expected: 'constant',
    id: 'plain-multi-declarator-and-type-query-constant-pin',
    mode: 'constant',
    source:
      'const regular: ReturnType<typeof useEstimate> = fallback, next = () => useEstimate(0);',
  },
  {
    expected: 'refused:State is declared in one run',
    id: 'valid-state-after-constants-refused-in-one-run-pin',
    mode: 'constant',
    source: 'const [value, setValue] = useReactiveState(initial);',
  },
];

describe('combined and non-canonical state declarators', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Classifies the single statement in `entry.source` via `stateStatementOf` or `constantOf`. */
  function classify(entry: Case): string {
    using parsed = parseModule(api, 'combined-state.ts', entry.source);
    const statement = parsed.sourceFile.statements[0];
    if (statement === undefined) {
      throw new Error('Missing statement.');
    }
    const reading: Reading = {
      isHook: (identifier) => HOOKS.has(identifier.text),
      sourceFile: parsed.sourceFile,
    };
    try {
      if (entry.mode === 'constant') {
        constantOf(statement, reading, (reason) => {
          throw new Error(reason);
        });
        return 'constant';
      }
      const state = stateStatementOf(statement, reading, (reason) => {
        throw new Error(reason);
      });
      if (state === null) {
        return 'null';
      }
      return state.kind === 'state'
        ? `state:${state.value.text}:${state.setter?.text ?? ''}`
        : `hook:${state.callee.text}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const [prefix = message] = message.split(':');
      const [clause = prefix] = prefix.split(', after ');
      return `refused:${clause}`;
    }
  }

  it.each(CASES)('$id', (entry) => {
    expect(classify(entry)).toBe(entry.expected);
  });
});
