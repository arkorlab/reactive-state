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
    id: 'element-function-reads-a-sibling-through-this',
    source: `const regular = (() => {
      const actions = [function () { return this[1](); }, () => useEstimate(0)];
      return actions[0]();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'element-function-of-a-literal-reads-a-sibling-through-this',
    source: 'const regular = [function () { return this[1](); }, () => useEstimate(0)][0]();',
  },
  {
    expected: HOOK_IN_CONST,
    id: 'element-function-of-a-spread-copy-reads-a-sibling-through-this-pin',
    source: `const regular = (() => {
      const actions = [function () { return this[1](); }, () => useEstimate(0)];
      const copy = [...actions];
      return copy[0]();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'element-function-of-an-array-rest-reads-through-the-rest',
    source: `const regular = (() => {
      const [, ...rest] = [() => 0, function () { return this[1](); }, () => useEstimate(0)];
      return rest[0]();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'element-function-reads-a-sibling-through-this-and-a-computed-index',
    source: `const regular = (() => {
      const actions = [function () { return this[1](); }, () => useEstimate(0)];
      return actions['0']();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'element-function-calling-a-hook-itself-pin',
    source: 'const regular = [function () { return useEstimate(0); }][0]();',
  },
  {
    expected: 'constant',
    id: 'element-function-reading-a-safe-sibling-allowed',
    source: 'const regular = [function () { return this[1](); }, () => 0][0]();',
  },
  {
    expected: 'constant',
    id: 'element-function-reads-only-the-sibling-it-names-pin',
    source: `const regular = [
      function () { return this[1](); },
      () => 0,
      () => useEstimate(0),
    ][0]();`,
  },
  {
    expected: 'constant',
    id: 'element-function-of-an-array-rest-keeps-the-offset-pin',
    source: `const regular = (() => {
      const [, ...rest] = [() => useEstimate(0), function () { return this[0](); }, () => 0];
      return rest[0]();
    })();`,
  },
];

describe('a function read off an array runs against that array', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Classifies the single statement in `entry.source` via `constantOf`. */
  function classify(entry: Case): string {
    using parsed = parseModule(api, 'array-element-receivers.ts', entry.source);
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
