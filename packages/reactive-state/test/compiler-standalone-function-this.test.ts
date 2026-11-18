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
    id: 'function-installed-as-a-method-returns-an-arrow-over-this',
    source: `const regular = (() => {
      function make() { return () => this.read(); }
      const box = { make, read() { return useEstimate(0); } };
      return box.make()();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'function-expression-kept-in-a-variable-and-installed-returns-an-arrow-over-this',
    source: `const regular = (() => {
      const make = function () { return () => this.read(); };
      const box = { run: make, read() { return useEstimate(0); } };
      return box.run()();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'function-installed-in-a-class-field-returns-an-arrow-over-this',
    source: `const regular = (() => {
      function make() { return () => this.read(); }
      class Box { run = make; read() { return useEstimate(0); } }
      return new Box().run()();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'function-installed-as-a-method-returns-a-function-over-a-captured-this',
    source: `const regular = (() => {
      function make() { const self = this; return function () { return self.read(); }; }
      const box = { make, read() { return useEstimate(0); } };
      return box.make()();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'function-installed-as-a-method-calls-the-hook-through-this-directly-pin',
    source: `const regular = (() => {
      function run() { return this.read(); }
      const box = { run, read() { return useEstimate(0); } };
      return box.run();
    })();`,
  },
  {
    expected: 'constant',
    id: 'function-installed-as-a-method-reads-a-member-that-is-safe',
    source: `const regular = (() => {
      function make() { return () => this.read(); }
      const box = { make, read() { return 0; } };
      return box.make()();
    })();`,
  },
  {
    expected: 'constant',
    id: 'function-over-this-ignores-a-hook-under-another-name',
    source: `const regular = (() => {
      function make() { return () => this.read(); }
      const box = { make, read() { return 0; }, other() { return useEstimate(0); } };
      return box.make()();
    })();`,
  },
  {
    expected: 'constant',
    id: 'function-without-this-allowed',
    source: `const regular = (() => {
      function make() { return () => 0; }
      const box = { make, other() { return useEstimate(0); } };
      return box.make()();
    })();`,
  },
];

describe('a this in a function no object or class declares may be any object or class of the statement', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Classifies the single statement in `entry.source` via `constantOf`. */
  function classify(entry: Case): string {
    using parsed = parseModule(api, 'standalone-function-this.ts', entry.source);
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
