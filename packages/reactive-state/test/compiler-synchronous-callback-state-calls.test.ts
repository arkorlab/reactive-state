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
 * `nestedStateCall` inspects arrow and function expressions, inline object methods/accessors,
 * inline constructed classes, and locally invoked helpers when they stand in an invocation or
 * member read, while still skipping uninvoked functions, methods, and instance initializers.
 */
const CASES: readonly Case[] = [
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'arrow-iife-custom-hook',
    mode: 'constant',
    source: 'const regular = (() => useEstimate(initial))();',
  },
  {
    expected: 'refused:State is declared on its own, with `const`',
    id: 'function-expression-iife-intrinsic',
    mode: 'constant',
    source: 'const regular = (function () { return useReactiveState(initial); })();',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'async-arrow-iife-custom-hook',
    mode: 'constant',
    source: 'const regular = (async () => useEstimate(initial))();',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'conditional-iife-custom-hook',
    mode: 'state',
    source: 'const regular = (ready ? () => useEstimate(initial) : () => 0)();',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'function-call-method-iife-hook',
    mode: 'constant',
    source: 'const regular = (() => useEstimate(initial)).call(null);',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'array-map-callback-custom-hook',
    mode: 'constant',
    source: 'const regular = items.map(() => useEstimate(initial));',
  },
  {
    expected: 'refused:State is declared on its own, with `const`',
    id: 'array-flatmap-callback-intrinsic',
    mode: 'constant',
    source: 'const regular = items.flatMap(() => useReactiveState(initial));',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'callback-default-parameter-hook',
    mode: 'constant',
    source: 'const regular = items.map((item = useEstimate(initial)) => item);',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'promise-executor-callback-hook',
    mode: 'constant',
    source: 'const regular = new Promise((resolve) => resolve(useEstimate(initial)));',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'tagged-template-iife-hook',
    mode: 'constant',
    source: 'const regular = ((strings: TemplateStringsArray) => useEstimate(initial))`item`;',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'same-statement-local-helper-call-hook',
    mode: 'constant',
    source: 'const run = (() => useEstimate(initial)), regular = run();',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'local-object-property-arrow-call-hook',
    mode: 'constant',
    source: 'const box = { run: () => useEstimate(initial) }, regular = box.run();',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'iife-local-helper-call-hook',
    mode: 'constant',
    source: 'const regular = (() => { const run = () => useEstimate(initial); return run(); })();',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'inline-object-getter-read-hook',
    mode: 'constant',
    source: 'const regular = ({ get item() { return useEstimate(initial); } }).item;',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'constructed-class-expression-field-hook',
    mode: 'constant',
    source: 'const regular = new (class { item = useEstimate(initial); })();',
  },
  {
    expected: 'constant',
    id: 'synchronous-non-hook-callbacks-pin',
    mode: 'constant',
    source: 'const regular = (() => items.map((item) => format(item)))();',
  },
  {
    expected: 'constant',
    id: 'curried-uninvoked-inner-arrow-pin',
    mode: 'constant',
    source: 'const regular = () => useEstimate(0), next = (() => () => useReactiveState(0))();',
  },
  {
    expected: 'constant',
    id: 'uninvoked-object-and-class-pin',
    mode: 'constant',
    source:
      'const regular = { run() { return useEstimate(0); } }, cls = class { item = useReactiveState(0); };',
  },
];

describe('synchronous function and callback state calls', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Classifies the single statement in `entry.source` via `stateStatementOf` or `constantOf`. */
  function classify(entry: Case): string {
    using parsed = parseModule(api, 'synchronous-callbacks.ts', entry.source);
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
