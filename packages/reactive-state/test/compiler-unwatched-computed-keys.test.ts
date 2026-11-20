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
    id: 'escaped-object-keeps-a-method-when-the-computed-key-is-reassigned-later',
    source: `const regular = (() => {
      let key = 'x';
      const retarget = () => { key = 'y'; };
      for (let index = 0; index < 2; index += 1) {
        consume({ x() { return useEstimate(0); }, [key]() { return 0; } });
        retarget();
      }
      return 0;
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'object-assignment-pattern-takes-the-member-whose-key-is-reassigned-later',
    source: `const regular = (() => {
      let key = 'safe';
      let picked;
      const source = { safe: () => 0, risky: () => useEstimate(0) };
      const retarget = () => { key = 'risky'; };
      for (let index = 0; index < 2; index += 1) {
        ({ [key]: picked } = source);
        picked();
        retarget();
      }
      return 0;
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'declaration-pattern-takes-the-member-whose-key-is-reassigned-later',
    source: `const regular = (() => {
      let key = 'safe';
      const source = { safe: () => 0, risky: () => useEstimate(0) };
      const retarget = () => { key = 'risky'; };
      for (let index = 0; index < 2; index += 1) {
        const { [key]: picked } = source;
        picked();
        retarget();
      }
      return 0;
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'escaped-object-with-a-reassigned-computed-key-before-it-is-built-pin',
    source: `const regular = (() => {
      let key = 'x';
      const retarget = () => { key = 'y'; };
      retarget();
      consume({ x() { return useEstimate(0); }, [key]() { return 0; } });
      return 0;
    })();`,
  },
  {
    expected: 'constant',
    id: 'escaped-object-with-a-literal-computed-key-shadows-the-earlier-method',
    source: `const regular = (() => {
      consume({ x() { return useEstimate(0); }, ['x']() { return 0; } });
      return 0;
    })();`,
  },
  {
    expected: 'constant',
    id: 'escaped-object-with-a-literal-key-shadows-the-earlier-method-pin',
    source: `const regular = (() => {
      consume({ x() { return useEstimate(0); }, x() { return 0; } });
      return 0;
    })();`,
  },
];

describe('a computed key is read from a binding only where a later write replays the answer', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Classifies the single statement in `entry.source` via `constantOf`. */
  function classify(entry: Case): string {
    using parsed = parseModule(api, 'unwatched-computed-keys.ts', entry.source);
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
