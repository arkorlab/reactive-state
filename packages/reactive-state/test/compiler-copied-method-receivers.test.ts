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
    id: 'spread-copied-method-calls-destination-override',
    source: `const regular = (() => {
      const base = { run() { return this.read(); }, read() { return 0; } };
      const child = { ...base, read() { return useEstimate(0); } };
      return child.run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'spread-of-a-spread-calls-destination-override',
    source: `const regular = (() => {
      const base = { run() { return this.read(); }, read() { return 0; } };
      const middle = { ...base };
      const child = { ...middle, read() { return useEstimate(0); } };
      return child.run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'property-copied-method-calls-destination-override',
    source: `const regular = (() => {
      const base = { run() { return this.read(); }, read() { return 0; } };
      const child = { run: base.run, read() { return useEstimate(0); } };
      return child.run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'shorthand-copied-method-calls-destination-override',
    source: `const regular = (() => {
      const base = { run() { return this.read(); }, read() { return 0; } };
      const { run } = base;
      const child = { run, read() { return useEstimate(0); } };
      return child.run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'class-field-copied-method-calls-instance-override',
    source: `const regular = (() => {
      const base = { run() { return this.read(); }, read() { return 0; } };
      class Copy { run = base.run; read() { return useEstimate(0); } }
      return new Copy().run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'static-field-copied-method-calls-class-override',
    source: `const regular = (() => {
      const base = { run() { return this.read(); }, read() { return 0; } };
      class Copy { static run = base.run; static read() { return useEstimate(0); } }
      return Copy.run();
    })();`,
  },
  {
    expected: 'constant',
    id: 'spread-copied-method-skips-source-hook-when-destination-overrides',
    source: `const regular = (() => {
      const base = { run() { return this.read(); }, read() { return useEstimate(0); } };
      const child = { ...base, read() { return 0; } };
      return child.run();
    })();`,
  },
  {
    expected: 'constant',
    id: 'property-copied-method-skips-source-hook-when-destination-overrides',
    source: `const regular = (() => {
      const base = { run() { return this.read(); }, read() { return useEstimate(0); } };
      const child = { run: base.run, read() { return 0; } };
      return child.run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'spread-copied-bound-function-keeps-its-receiver-hook-pin',
    source: `const regular = (() => {
      const target = { read() { return useEstimate(0); } };
      function run() { return this.read(); }
      const base = { run: run.bind(target) };
      const child = { ...base, read() { return 0; } };
      return child.run();
    })();`,
  },
  {
    expected: 'constant',
    id: 'spread-copied-bound-function-keeps-its-receiver-safe-pin',
    source: `const regular = (() => {
      const target = { read() { return 0; } };
      function run() { return this.read(); }
      const base = { run: run.bind(target) };
      const child = { ...base, read() { return useEstimate(0); } };
      return child.run();
    })();`,
  },
  {
    expected: 'constant',
    id: 'property-copied-bound-function-keeps-its-receiver-safe-pin',
    source: `const regular = (() => {
      const target = { read() { return 0; } };
      function run() { return this.read(); }
      const bound = run.bind(target);
      const child = { run: bound, read() { return useEstimate(0); } };
      return child.run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'own-method-calls-own-override-hook-pin',
    source: `const regular = (() => {
      const own = { run() { return this.read(); }, read() { return useEstimate(0); } };
      return own.run();
    })();`,
  },
  {
    expected: 'constant',
    id: 'uncalled-spread-copy-hook-override-allowed-pin',
    source: `const regular = (() => {
      const base = { run() { return this.read(); }, read() { return 0; } };
      const child = { ...base, read() { return useEstimate(0); } };
      return base.run();
    })();`,
  },
];

describe('a method copied to another object runs against its new receiver', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Classifies the single statement in `entry.source` via `constantOf`. */
  function classify(entry: Case): string {
    using parsed = parseModule(api, 'copied-method-receivers.ts', entry.source);
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
