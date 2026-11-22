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

/** `levels` aliases, each choosing between the two before it: the callees a call may reach double. */
function aliasGraph(levels: number, first: string): string {
  const lines = [`const f0 = () => ${first};`, 'const f1 = () => 0;'];
  for (let level = 2; level <= levels; level += 1) {
    lines.push(`const f${level} = choice${level} ? f${level - 1} : f${level - 2};`);
  }
  return `${lines.join('\n')}\nreturn f${levels}();`;
}

const CASES: readonly Case[] = [
  {
    expected: 'constant',
    id: 'deep-alias-graph-without-a-hook-finishes',
    source: `const regular = (() => { ${aliasGraph(34, '0')} })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'deep-alias-graph-with-a-hook-in-a-reachable-callee-is-refused',
    source: `const regular = (() => { ${aliasGraph(34, 'useEstimate(0)')} })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'deep-alias-graph-refuses-a-hook-no-callee-reaches',
    source: `const regular = (() => {
      const unused = () => useEstimate(0);
      ${aliasGraph(28, '0')}
    })();`,
  },
  {
    expected: 'constant',
    id: 'alias-graph-within-the-budget-skips-a-hook-no-callee-reaches-pin',
    source: `const regular = (() => {
      const unused = () => useEstimate(0);
      ${aliasGraph(12, '0')}
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'alias-graph-within-the-budget-follows-the-hook-pin',
    source: `const regular = (() => { ${aliasGraph(12, 'useEstimate(0)')} })();`,
  },
];

describe('a walk that outgrows its budget reads every call of the statement', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Classifies the single statement in `entry.source` via `constantOf`. */
  function classify(entry: Case): string {
    using parsed = parseModule(api, 'walk-budget.ts', entry.source);
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

  it.each(CASES)(
    '$id',
    (entry) => {
      expect(classify(entry)).toBe(entry.expected);
    },
    10_000,
  );
});
