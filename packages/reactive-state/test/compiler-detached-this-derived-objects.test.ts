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
    id: 'arrow-returned-by-a-spread-copy-calls-the-copys-override',
    source: `const regular = (() => {
      const base = { make() { return () => this.read(); }, read() { return 0; } };
      const child = { ...base, read() { return useEstimate(0); } };
      return child.make()();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'arrow-returned-through-a-prototype-calls-the-heirs-override',
    source: `const regular = (() => {
      const base = { make() { return () => this.read(); }, read() { return 0; } };
      const child = { __proto__: base, read() { return useEstimate(0); } };
      return child.make()();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'arrow-returned-by-an-object-rest-copy-calls-the-copys-override',
    source: `const regular = (() => {
      const base = { make() { return () => this.read(); }, read() { return 0; }, size: 1 };
      const { size, ...rest } = base;
      const child = { ...rest, read() { return useEstimate(0); } };
      return child.make()();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'copy-of-a-copy-calls-the-last-copys-override',
    source: `const regular = (() => {
      const base = { make() { return () => this.read(); }, read() { return 0; } };
      const middle = { ...base };
      const child = { ...middle, read() { return useEstimate(0); } };
      return child.make()();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'method-read-off-this-and-stored-calls-the-copys-override',
    source: `const regular = (() => {
      let stored;
      const base = { init() { stored = this.helper; }, helper() { return 0; } };
      const child = { ...base, helper() { return useEstimate(0); } };
      child.init();
      return stored();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'this-returned-inside-an-object-calls-the-copys-override',
    source: `const regular = (() => {
      const base = { wrap() { return { me: this }; }, helper() { return 0; } };
      const child = { ...base, helper() { return useEstimate(0); } };
      return child.wrap().me.helper();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'function-property-arrow-calls-the-copys-override',
    source: `const regular = (() => {
      const base = { make: function () { return () => this.read(); }, read() { return 0; } };
      const child = { ...base, read() { return useEstimate(0); } };
      return child.make()();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'arrow-returned-by-the-object-itself-calls-its-own-hook-pin',
    source: `const regular = (() => {
      const own = { make() { return () => this.read(); }, read() { return useEstimate(0); } };
      return own.make()();
    })();`,
  },
  {
    expected: 'constant',
    id: 'arrow-returned-by-an-object-ignores-an-unrelated-object',
    source: `const regular = (() => {
      const base = { make() { return () => this.read(); }, read() { return 0; } };
      const other = { read() { return useEstimate(0); } };
      return base.make()();
    })();`,
  },
  {
    expected: 'constant',
    id: 'copy-is-not-reached-while-the-arrow-is-never-called-pin',
    source: `const regular = (() => {
      const base = { make() { return () => this.read(); }, read() { return 0; } };
      const child = { ...base, read() { return useEstimate(0); } };
      return base.make;
    })();`,
  },
  {
    expected: 'constant',
    id: 'copy-heritage-cycle-through-reassignment-terminates',
    source: `const regular = (() => {
      let base = { make() { return () => this.read(); }, read() { return 0; } };
      base = { ...base, read() { return 0; } };
      return base.make()();
    })();`,
  },
];

describe('a this the analysis cannot place is the object it is written in, and every object copied from it', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Classifies the single statement in `entry.source` via `constantOf`. */
  function classify(entry: Case): string {
    using parsed = parseModule(api, 'detached-this-derived-objects.ts', entry.source);
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
