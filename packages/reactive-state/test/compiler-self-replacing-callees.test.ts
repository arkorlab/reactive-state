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
    id: 'callee-that-replaces-itself-is-called-again-in-a-loop',
    source: `const regular = (() => {
      let step = () => { step = () => useEstimate(0); };
      for (let index = 0; index < 2; index += 1) {
        step();
      }
      return 0;
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'callee-that-replaces-itself-is-called-twice-through-a-helper',
    source: `const regular = (() => {
      let step = () => { step = () => useEstimate(0); };
      const again = () => step();
      again();
      again();
      return 0;
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'lazy-getter-replaced-by-a-hook-calling-one-runs-for-each-item',
    source: `const regular = (() => {
      let read = () => {
        const value = 1;
        read = () => useEstimate(value);
        return value;
      };
      return [1, 2].map(() => read());
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'constructor-that-replaces-its-class-is-constructed-again',
    source: `const regular = (() => {
      let Item = class { constructor() { Item = class { constructor() { useEstimate(0); } }; } };
      for (let index = 0; index < 2; index += 1) {
        new Item();
      }
      return 0;
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'callee-that-replaces-itself-is-called-with-call-again',
    source: `const regular = (() => {
      let step = function () { step = function () { return useEstimate(0); }; };
      for (let index = 0; index < 2; index += 1) {
        step.call(null);
      }
      return 0;
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'callee-that-replaces-itself-is-called-twice-in-a-row-pin',
    source: `const regular = (() => {
      let step = () => { step = () => useEstimate(0); };
      step();
      step();
      return 0;
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'callee-replaced-by-another-function-before-the-call-pin',
    source: `const regular = (() => {
      let step = () => 0;
      const swap = () => { step = () => useEstimate(0); };
      swap();
      step();
      return 0;
    })();`,
  },
  {
    expected: 'constant',
    id: 'callee-that-replaces-itself-with-a-safe-one-in-a-loop-allowed',
    source: `const regular = (() => {
      let step = () => { step = () => 0; };
      for (let index = 0; index < 2; index += 1) {
        step();
      }
      return 0;
    })();`,
  },
  {
    expected: 'constant',
    id: 'callee-that-replaces-itself-is-never-called-allowed',
    source: `const regular = (() => {
      let step = () => { step = () => useEstimate(0); };
      return step;
    })();`,
  },
];

describe('a function that replaces itself while it runs is followed on its next call', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Classifies the single statement in `entry.source` via `constantOf`. */
  function classify(entry: Case): string {
    using parsed = parseModule(api, 'self-replacing-callees.ts', entry.source);
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
