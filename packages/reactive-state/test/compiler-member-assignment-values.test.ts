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
    id: 'function-assigned-to-a-property-is-called',
    source: `const regular = (() => {
      const box = {};
      box.run = () => useEstimate(0);
      return box.run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'function-expression-assigned-to-a-property-is-called',
    source: `const regular = (() => {
      const box = {};
      box.run = function () { return useEstimate(0); };
      return box.run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'function-assigned-to-an-element-is-called',
    source: `const regular = (() => {
      const list = [];
      list[0] = () => useEstimate(0);
      return list[0]();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'instance-assigned-to-a-property-has-its-method-called',
    source: `const regular = (() => {
      const box = {};
      class Item { go() { return useEstimate(0); } }
      box.item = new Item();
      return box.item.go();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'constructor-assigns-a-method-to-this',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      class Item { constructor() { this.run = actions.run; } }
      return new Item().run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'function-constructor-assigns-a-method-to-this',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      function Item() { this.run = actions.run; }
      return new Item().run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'logical-assignment-stores-a-function',
    source: `const regular = (() => {
      const box = {};
      box.run ??= () => useEstimate(0);
      return box.run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'array-destructuring-assignment-stores-a-function-in-a-property',
    source: `const regular = (() => {
      const box = {};
      [box.run] = [() => useEstimate(0)];
      return box.run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'object-destructuring-assignment-stores-a-function-in-a-property',
    source: `const regular = (() => {
      const box = {};
      ({ item: box.run } = { item: () => useEstimate(0) });
      return box.run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'for-of-stores-a-function-in-a-property',
    source: `const regular = (() => {
      const box = {};
      for (box.run of [() => useEstimate(0)]) {
        box.run();
      }
      return 0;
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'this-stored-on-an-object-reaches-the-subclass-override',
    source: `const regular = (() => {
      const box = {};
      class Base { init() { box.self = this; } helper() { return 0; } }
      class Child extends Base { helper() { return useEstimate(0); } }
      new Child().init();
      return box.self.helper();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'function-assigned-to-a-variable-is-called-pin',
    source: `const regular = (() => {
      let run;
      run = () => useEstimate(0);
      return run();
    })();`,
  },
  {
    expected: 'constant',
    id: 'properties-assigned-plain-values-and-a-safe-function-allowed',
    source: `const regular = (() => {
      const box = {};
      box.count = 1;
      box.name = 'box';
      box.run = () => 0;
      return box.run();
    })();`,
  },
  {
    expected: 'constant',
    id: 'constructor-assigns-plain-values-to-this-allowed',
    source: `const regular = (() => {
      class Item { constructor() { this.count = 1; } }
      return new Item().count;
    })();`,
  },
];

describe('a value assigned to a member of an object escapes, as an argument of a call does', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Classifies the single statement in `entry.source` via `constantOf`. */
  function classify(entry: Case): string {
    using parsed = parseModule(api, 'member-assignment-values.ts', entry.source);
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
