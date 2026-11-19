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
    id: 'object-getter-returns-a-function-that-reads-this',
    source: `const regular = ({
      get run() { return function () { return this.read(); }; },
      read() { return useEstimate(0); },
    }).run();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'class-getter-returns-a-function-that-reads-this',
    source: `const regular = (() => {
      class Holder {
        get run() { return function () { return this.read(); }; }
        read() { return useEstimate(0); }
      }
      return new Holder().run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'inherited-getter-returns-a-function-that-reads-the-subclass-override',
    source: `const regular = (() => {
      class Base {
        get run() { return function () { return this.read(); }; }
        read() { return 0; }
      }
      class Child extends Base { read() { return useEstimate(0); } }
      return new Child().run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'static-getter-returns-a-function-that-reads-this',
    source: `const regular = (() => {
      class Holder {
        static get run() { return function () { return this.read(); }; }
        static read() { return useEstimate(0); }
      }
      return Holder.run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'getter-returns-a-function-found-through-a-variable',
    source: `const regular = (() => {
      const make = function () { return this.read(); };
      const holder = { get run() { return make; }, read() { return useEstimate(0); } };
      return holder.run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'getter-returns-an-arrow-that-reads-this-pin',
    source: `const regular = ({
      get run() { return () => this.read(); },
      read() { return useEstimate(0); },
    }).run();`,
  },
  {
    expected: 'constant',
    id: 'getter-returns-a-bound-function-that-keeps-its-receiver',
    source: `const regular = (() => {
      const target = { read() { return 0; } };
      function run() { return this.read(); }
      const holder = { get bound() { return run.bind(target); }, read() { return useEstimate(0); } };
      return holder.bound();
    })();`,
  },
  {
    expected: 'constant',
    id: 'getter-returns-a-function-that-reads-a-safe-this-allowed',
    source: `const regular = ({
      get run() { return function () { return this.read(); }; },
      read() { return 0; },
    }).run();`,
  },
];

describe('a function a getter returns runs against the object the getter was read from', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Classifies the single statement in `entry.source` via `constantOf`. */
  function classify(entry: Case): string {
    using parsed = parseModule(api, 'accessor-result-receivers.ts', entry.source);
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
