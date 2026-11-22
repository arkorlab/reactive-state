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
    id: 'helper-calls-the-result-of-a-method-of-an-object-it-receives',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      function invoke(factory) { return factory.make()(); }
      return invoke({ make() { return actions.run; } });
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'helper-calls-the-result-of-a-method-of-an-instance-it-receives',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      class Factory { make() { return actions.run; } }
      function invoke(factory) { return factory.make()(); }
      return invoke(new Factory());
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'helper-calls-the-result-of-a-static-method-of-a-class-it-receives',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      class Factory { static make() { return actions.run; } }
      function invoke(factory) { return factory.make()(); }
      return invoke(Factory);
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'helper-calls-a-method-of-the-object-a-method-it-receives-returns',
    source: `const regular = (() => {
      function invoke(factory) { return factory.make().run(); }
      return invoke({ make() { return { run() { return useEstimate(0); } }; } });
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'helper-calls-the-result-of-an-inherited-method-it-receives',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      class Base { make() { return actions.run; } }
      class Factory extends Base {}
      function invoke(factory) { return factory.make()(); }
      return invoke(new Factory());
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'helper-reads-the-result-of-a-getter-it-receives-pin',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      function invoke(factory) { return factory.make; }
      return invoke({ get make() { return actions.run; } })();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'helper-calls-the-result-of-an-arrow-property-it-receives-pin',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      function invoke(factory) { return factory.make()(); }
      return invoke({ make: () => actions.run });
    })();`,
  },
  {
    expected: 'constant',
    id: 'helper-calls-the-result-of-a-method-that-is-safe-allowed',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      function invoke(factory) { return factory.make()(); }
      return invoke({ make() { return () => 0; } });
    })();`,
  },
  {
    expected: 'constant',
    id: 'method-that-returns-this-terminates-pin',
    source: `const regular = (() => {
      const chain = { next() { return this; } };
      return consume(chain);
    })();`,
  },
];

describe('what a method of an escaped object or class returns escapes with it', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Classifies the single statement in `entry.source` via `constantOf`. */
  function classify(entry: Case): string {
    using parsed = parseModule(api, 'escaped-member-results.ts', entry.source);
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
