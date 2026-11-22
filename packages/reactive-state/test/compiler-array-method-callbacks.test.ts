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
    id: 'for-each-callback-calls-an-element',
    source: 'const regular = [() => useEstimate(0)].forEach((run) => run());',
  },
  {
    expected: HOOK_IN_CONST,
    id: 'map-callback-calls-an-element',
    source: 'const regular = [() => useEstimate(0)].map((run) => run());',
  },
  {
    expected: HOOK_IN_CONST,
    id: 'reduce-callback-calls-an-element',
    source: 'const regular = [() => useEstimate(0)].reduce((total, run) => run(), 0);',
  },
  {
    expected: HOOK_IN_CONST,
    id: 'kept-array-for-each-callback-calls-an-element',
    source: `const regular = (() => {
      const steps = [() => useEstimate(0)];
      return steps.forEach((run) => run());
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'at-returns-an-element-that-is-called',
    source: 'const regular = [() => useEstimate(0)].at(0)();',
  },
  {
    expected: HOOK_IN_CONST,
    id: 'pop-returns-an-element-that-is-called',
    source: 'const regular = [() => useEstimate(0)].pop()();',
  },
  {
    expected: HOOK_IN_CONST,
    id: 'find-returns-an-element-that-is-called',
    source: 'const regular = [() => useEstimate(0)].find((each) => each)();',
  },
  {
    expected: HOOK_IN_CONST,
    id: 'slice-copy-for-each-calls-an-element',
    source: `const regular = (() => {
      const steps = [() => useEstimate(0)];
      return steps.slice().forEach((run) => run());
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'spread-copy-for-each-calls-an-element',
    source: `const regular = (() => {
      const steps = [() => useEstimate(0)];
      return [...steps].forEach((run) => run());
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'array-rest-for-each-calls-an-element',
    source: `const regular = (() => {
      const [first, ...rest] = [() => 0, () => useEstimate(0)];
      return rest.forEach((run) => run());
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'nested-array-for-each-calls-an-element',
    source: 'const regular = [[() => useEstimate(0)]].forEach(([run]) => run());',
  },
  {
    expected: HOOK_IN_CONST,
    id: 'computed-method-name-for-each-calls-an-element',
    source: "const regular = [() => useEstimate(0)]['forEach']((run) => run());",
  },
  {
    expected: HOOK_IN_CONST,
    id: 'indexed-element-call-pin',
    source: 'const regular = [() => useEstimate(0)][0]();',
  },
  {
    expected: HOOK_IN_CONST,
    id: 'for-of-element-call-pin',
    source: `const regular = (() => {
      for (const run of [() => useEstimate(0)]) {
        run();
      }
    })();`,
  },
  {
    expected: 'constant',
    id: 'length-read-leaves-the-elements-alone-pin',
    source: 'const regular = [() => useEstimate(0)].length;',
  },
  {
    expected: 'constant',
    id: 'indexed-call-selects-one-element-pin',
    source: 'const regular = [() => useEstimate(0), () => 0][1]();',
  },
  {
    expected: 'constant',
    id: 'for-each-over-elements-without-a-hook-allowed',
    source: 'const regular = [() => 0].forEach((run) => run());',
  },
  {
    expected: 'constant',
    id: 'map-over-plain-values-allowed',
    source: 'const regular = [1, 2].map((value) => value * 2);',
  },
  {
    expected: 'constant',
    id: 'array-of-hook-calling-functions-never-called-allowed',
    source: `const regular = (() => {
      const steps = [() => useEstimate(0)];
      return steps.length;
    })();`,
  },
];

describe('a method called on an array may run the functions the array holds', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Classifies the single statement in `entry.source` via `constantOf`. */
  function classify(entry: Case): string {
    using parsed = parseModule(api, 'array-method-callbacks.ts', entry.source);
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
