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
    id: 'helper-calls-the-result-of-an-arrow-callback',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      function invoke(make) { return make()(); }
      return invoke(() => actions.run);
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'helper-calls-the-result-of-a-block-bodied-callback',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      function invoke(make) { return make()(); }
      return invoke(() => { return actions.run; });
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'helper-calls-the-result-of-a-function-expression-callback',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      function invoke(make) { return make()(); }
      return invoke(function () { return actions.run; });
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'helper-calls-the-result-of-the-result-of-a-callback',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      function invoke(make) { return make()()(); }
      return invoke(() => () => actions.run);
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'helper-calls-a-method-of-the-object-a-callback-returns',
    source: `const regular = (() => {
      function use(make) { return make().run(); }
      return use(() => ({ run() { return useEstimate(0); } }));
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'helper-calls-a-method-of-the-instance-a-callback-returns',
    source: `const regular = (() => {
      class Item { go() { return useEstimate(0); } }
      function use(make) { return make().go(); }
      return use(() => new Item());
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'native-iteration-yields-the-result-of-a-callback-that-is-called',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      return [1].map(() => actions.run).forEach((run) => run());
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'direct-call-of-the-result-of-a-function-pin',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      const make = () => actions.run;
      return make()();
    })();`,
  },
  {
    expected: 'constant',
    id: 'helper-calls-the-result-of-a-callback-that-is-safe-allowed',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      function invoke(make) { return make()(); }
      return invoke(() => () => 0);
    })();`,
  },
  {
    expected: 'constant',
    id: 'callback-that-returns-a-plain-value-allowed',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      function invoke(make) { return make(); }
      return invoke(() => 1);
    })();`,
  },
  {
    expected: 'constant',
    id: 'function-that-returns-itself-terminates-pin',
    source: `const regular = (() => {
      const again = () => again;
      return consume(again);
    })();`,
  },
  {
    expected: 'constant',
    id: 'two-functions-that-return-each-other-terminate-pin',
    source: `const regular = (() => {
      const first = () => second;
      const second = () => first;
      return consume(first);
    })();`,
  },
];

describe('what a function that escapes returns escapes with it', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Classifies the single statement in `entry.source` via `constantOf`. */
  function classify(entry: Case): string {
    using parsed = parseModule(api, 'escaped-callback-results.ts', entry.source);
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
