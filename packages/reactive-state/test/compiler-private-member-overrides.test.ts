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
    id: 'subclass-private-method-of-the-same-name-is-not-an-override',
    source: `const regular = (() => {
      class Base { run() { return this.#read(); } #read() { return useEstimate(0); } }
      class Child extends Base { #read() { return 0; } }
      return new Child().run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'subclass-private-field-of-the-same-name-is-not-an-override',
    source: `const regular = (() => {
      class Base { #read = () => useEstimate(0); run() { return this.#read(); } }
      class Child extends Base { #read = () => 0; }
      return new Child().run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'subclass-private-getter-of-the-same-name-is-not-an-override',
    source: `const regular = (() => {
      class Base { get #value() { return useEstimate(0); } run() { return this.#value; } }
      class Child extends Base { get #value() { return 0; } }
      return new Child().run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'private-method-two-levels-up-is-not-hidden-by-a-middle-class',
    source: `const regular = (() => {
      class Base { run() { return this.#read(); } #read() { return useEstimate(0); } }
      class Middle extends Base { #read() { return 0; } }
      class Leaf extends Middle {}
      return new Leaf().run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'private-method-reached-through-super-is-not-hidden',
    source: `const regular = (() => {
      class Base { run() { return this.#read(); } #read() { return useEstimate(0); } }
      class Child extends Base { #read() { return 0; } again() { return super.run(); } }
      return new Child().again();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'private-method-with-no-override-pin',
    source: `const regular = (() => {
      class Base { run() { return this.#read(); } #read() { return useEstimate(0); } }
      class Child extends Base {}
      return new Child().run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'private-method-called-in-its-own-class-pin',
    source: `const regular = (() => {
      class Base { #read() { return 0; } }
      class Child extends Base { run() { return this.#read(); } #read() { return useEstimate(0); } }
      return new Child().run();
    })();`,
  },
  {
    expected: 'constant',
    id: 'private-methods-of-the-same-name-without-a-hook-allowed',
    source: `const regular = (() => {
      class Base { run() { return this.#read(); } #read() { return 0; } }
      class Child extends Base { #read() { return 1; } }
      return new Child().run();
    })();`,
  },
  {
    expected: 'constant',
    id: 'public-override-still-hides-the-base-method-pin',
    source: `const regular = (() => {
      class Base { run() { return this.read(); } read() { return useEstimate(0); } }
      class Child extends Base { read() { return 0; } }
      return new Child().run();
    })();`,
  },
];

describe('a private name belongs to the class that declares it, whatever the receiver', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Classifies the single statement in `entry.source` via `constantOf`. */
  function classify(entry: Case): string {
    using parsed = parseModule(api, 'private-member-overrides.ts', entry.source);
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
