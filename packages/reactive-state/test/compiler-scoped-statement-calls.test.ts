import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { constantOf, type Reading, stateStatementOf } from '../src/compiler/statements.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

interface Case {
  readonly expected: string;
  readonly id: string;
  readonly mode: 'constant' | 'state';
  readonly source: string;
}

const HOOKS = new Set(['useEstimate', 'useFilter']);

/**
 * `forEachSynchronousCall` resolves local callable and container bindings in their lexical scopes
 * and projects accessed object or class members without entering shadowed helpers or uncalled
 * sibling methods and getters.
 */
const CASES: readonly Case[] = [
  {
    expected: 'constant',
    id: 'shadowed-nested-arrow-helper',
    mode: 'constant',
    source:
      'const regular = (() => { const helper = () => useEstimate(0); return (() => { const helper = () => 0; return helper(); })(); })();',
  },
  {
    expected: 'constant',
    id: 'shadowed-parameter-same-statement',
    mode: 'constant',
    source:
      'const run = () => useReactiveState(0), regular = ((run: () => number) => run())(() => 0);',
  },
  {
    expected: 'constant',
    id: 'shadowed-nested-block-const',
    mode: 'constant',
    source:
      'const regular = (() => { const helper = () => useEstimate(0); { const helper = () => 0; return helper(); } })();',
  },
  {
    expected: 'constant',
    id: 'shadowed-hoisted-block-function',
    mode: 'constant',
    source:
      'const regular = (() => { function helper() { return useEstimate(0); } { const value = helper(); function helper() { return 0; } return value; } })();',
  },
  {
    expected: 'constant',
    id: 'shadowed-hoisted-inner-var',
    mode: 'constant',
    source:
      'const regular = (() => { const helper = () => useEstimate(0); return (function () { if (ready) { var helper = () => 0; } return helper ? helper() : 0; })(); })();',
  },
  {
    expected: 'constant',
    id: 'shadowed-loop-and-catch-bindings',
    mode: 'constant',
    source:
      'const regular = (() => { const helper = () => useEstimate(0); for (const helper of [() => 0]) { helper(); } try { check(); } catch (helper) { if (typeof helper === "function") { helper(); } } return 0; })();',
  },
  {
    expected: 'constant',
    id: 'outer-alias-ignores-inner-shadow',
    mode: 'constant',
    source:
      'const regular = (() => { const helper = () => 0; const alias = helper; return (() => { const helper = () => useEstimate(0); return alias(); })(); })();',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'reassigned-let-same-scope-refused',
    mode: 'constant',
    source:
      'const regular = (() => { let helper = () => 0; helper = () => useEstimate(0); return helper(); })();',
  },
  {
    expected: 'constant',
    id: 'reassigned-shadowed-let-isolated',
    mode: 'constant',
    source:
      'const regular = (() => { let helper = () => 0; { let helper = () => 1; helper = () => useEstimate(0); } return helper(); })();',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'multiple-var-same-scope-pin',
    mode: 'constant',
    source:
      'const regular = (() => { var helper = () => 0; if (ready) { var helper = () => useEstimate(0); } return helper(); })();',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'hoisted-overloaded-function-pin',
    mode: 'constant',
    source:
      'const regular = (() => { const value = helper(1); function helper(input: number): unknown; function helper(): unknown { return useEstimate(0); } return value; })();',
  },
  {
    expected: 'constant',
    id: 'object-count-read-skips-method',
    mode: 'constant',
    source: 'const regular = ({ run() { return useEstimate(0); }, count: 1 }).count;',
  },
  {
    expected: 'constant',
    id: 'local-object-count-skips-siblings',
    mode: 'constant',
    source:
      'const box = { other: () => useReactiveState(0), run() { return useEstimate(0); }, count: 1 }, regular = box.count;',
  },
  {
    expected: 'constant',
    id: 'object-other-call-skips-hook-siblings',
    mode: 'constant',
    source:
      'const regular = ({ bad: () => useReactiveState(0), run() { return useEstimate(0); }, other() { return 0; } }).other();',
  },
  {
    expected: 'constant',
    id: 'extracted-safe-method-call-allowed',
    mode: 'constant',
    source:
      'const fn = ({ run() { return useEstimate(0); }, other() { return 0; } }).other, regular = fn();',
  },
  {
    expected: 'constant',
    id: 'extracted-uncalled-hook-method-allowed',
    mode: 'constant',
    source: 'const fn = ({ run() { return useEstimate(0); }, count: 1 }).run;',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'extracted-called-hook-method-refused',
    mode: 'constant',
    source:
      'const fn = ({ run() { return useEstimate(0); }, other() { return 0; } }).run, regular = fn();',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'object-getter-read-hook-pin',
    mode: 'constant',
    source:
      'const regular = ({ get count() { return useEstimate(0); }, run() { return 0; } }).count;',
  },
  {
    expected: 'constant',
    id: 'object-unaccessed-getter-skipped',
    mode: 'constant',
    source: 'const regular = ({ get other() { return useEstimate(0); }, count: 1 }).count;',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'object-method-call-hook-pin',
    mode: 'constant',
    source: 'const regular = ({ run() { return useEstimate(0); }, count: 1 }).run();',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'object-computed-key-hook-pin',
    mode: 'constant',
    source: 'const regular = ({ [String(useEstimate(0))]: 1, count: 2 }).count;',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'object-value-initializer-hook-pin',
    mode: 'constant',
    source: 'const regular = ({ bad: useEstimate(0), count: 1 }).count;',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'object-dynamic-key-getter-pin',
    mode: 'constant',
    source: 'const regular = ({ get count() { return useEstimate(0); }, plain: 1 })[key];',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'object-dynamic-key-method-call-pin',
    mode: 'constant',
    source: 'const regular = ({ run() { return useEstimate(0); }, other() { return 0; } })[key]();',
  },
];

describe('scoped synchronous statement calls and member selection', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Classifies the single statement in `entry.source` via `stateStatementOf` or `constantOf`. */
  function classify(entry: Case): string {
    using parsed = parseModule(api, 'scoped-statement-calls.ts', entry.source);
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
      const [prefix = message] = message.split(':', 2);
      const [clause = prefix] = prefix.split(', after ', 2);
      return `refused:${clause}`;
    }
  }

  it.each(CASES)('$id', (entry) => {
    expect(classify(entry)).toBe(entry.expected);
  });
});
