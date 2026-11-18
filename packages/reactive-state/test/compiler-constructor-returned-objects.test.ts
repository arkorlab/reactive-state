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
    id: 'class-constructor-returns-an-object-holding-a-hook-method',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      class Wrapper {
        run() { return 0; }
        constructor() { return { run: actions.run }; }
      }
      return new Wrapper().run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'class-constructor-returns-an-object-with-a-hook-arrow',
    source: `const regular = (() => {
      class Wrapper {
        constructor() { return { run: () => useEstimate(0) }; }
      }
      return new Wrapper().run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'function-constructor-returns-an-object-holding-a-hook-method',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      function Item() { return { run: actions.run }; }
      return new Item().run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'base-constructor-returns-an-object-for-a-subclass',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      class Base { constructor() { return { run: actions.run }; } }
      class Child extends Base { run() { return 0; } }
      return new Child().run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'constructor-that-calls-a-hook-itself-pin',
    source: `const regular = (() => {
      class Item { constructor() { useEstimate(0); } }
      return new Item();
    })();`,
  },
  {
    expected: 'constant',
    id: 'constructor-without-a-return-allowed',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      class Item { run() { return 0; } constructor() { this.count = 1; } }
      return new Item().run();
    })();`,
  },
  {
    expected: 'constant',
    id: 'constructor-with-an-empty-return-allowed',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      class Item { constructor() { return; } run() { return 0; } }
      return new Item().run();
    })();`,
  },
  {
    expected: 'constant',
    id: 'constructor-returns-a-safe-object-allowed',
    source: `const regular = (() => {
      class Wrapper { constructor() { return { run: () => 0 }; } }
      return new Wrapper().run();
    })();`,
  },
];

describe('what a constructor returns in place of the instance escapes', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Classifies the single statement in `entry.source` via `constantOf`. */
  function classify(entry: Case): string {
    using parsed = parseModule(api, 'constructor-returned-objects.ts', entry.source);
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
