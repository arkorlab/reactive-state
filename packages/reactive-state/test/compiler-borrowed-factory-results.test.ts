import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { constantOf, type Reading } from '../src/compiler/statements.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const HOOKS = new Set(['useEstimate']);

interface Case {
  readonly expected: string;
  readonly id: string;
  readonly source: string;
}

const HOOK_IN_CONST =
  'refused:`useEstimate` is called on its own, with `const`, as state is declared';

const CASES: readonly Case[] = [
  {
    expected: HOOK_IN_CONST,
    id: 'call-runs-a-factory-whose-result-is-called',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      function make() { return actions.run; }
      return make.call(null)();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'apply-runs-a-factory-whose-result-is-called',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      function make() { return actions.run; }
      return make.apply(null, [])();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'reflect-apply-runs-a-factory-whose-result-is-called',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      function make() { return actions.run; }
      return Reflect.apply(make, null, [])();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'call-runs-a-method-factory-whose-result-is-called',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      const holder = { make() { return actions.run; } };
      return holder.make.call(holder)();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'call-gives-the-factory-the-this-it-returns-a-method-of-pin',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      function make() { return this.run; }
      return make.call(actions)();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'call-of-the-result-of-call',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      function make() { return actions.run; }
      return make.call(null).call(null);
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'call-runs-a-factory-returning-an-arrow-over-a-kept-name',
    source: `const regular = (() => {
      const kind = 'call';
      const actions = { run() { return useEstimate(0); } };
      const make = function () { return () => actions.run(); };
      return make[kind](null)();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'direct-call-of-a-factory-result-pin',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      function make() { return actions.run; }
      return make()();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'bind-of-a-factory-result-pin',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      function make() { return actions.run; }
      return make.bind(null)()();
    })();`,
  },
  {
    expected: 'constant',
    id: 'call-of-a-factory-whose-result-is-never-called-allowed',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      function make() { return actions.run; }
      return make.call(null);
    })();`,
  },
  {
    expected: 'constant',
    id: 'call-of-a-factory-returning-a-safe-function-allowed',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      function make() { return () => 0; }
      return make.call(null)();
    })();`,
  },
];

describe('what a function returns is followed when it runs through call, apply or Reflect.apply', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Classifies the single statement in `entry.source` via `constantOf`. */
  function classify(entry: Case): string {
    using parsed = parseModule(api, 'borrowed-factory-results.ts', entry.source);
    const statement = parsed.sourceFile.statements[0];
    if (statement === undefined) {
      throw new Error('Missing statement.');
    }
    const reading: Reading = {
      isHook: (identifier) => HOOKS.has(identifier.text),
      sourceFile: parsed.sourceFile,
    };
    try {
      constantOf(statement, reading, (reason) => {
        throw new Error(reason);
      });
      return 'constant';
    } catch (error) {
      if (error instanceof RangeError) {
        return `crash:${error.name}`;
      }
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
