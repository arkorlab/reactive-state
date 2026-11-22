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
    id: 'inherited-arrow-field-calls-subclass-override',
    source: `const regular = (() => {
      class Base { run = () => this.read(); read() { return 0; } }
      class Child extends Base { read() { return useEstimate(0); } }
      return new Child().run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'arrow-returned-by-method-calls-subclass-override',
    source: `const regular = (() => {
      class Base { make() { return () => this.read(); } read() { return 0; } }
      class Child extends Base { read() { return useEstimate(0); } }
      return new Child().make()();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'arrow-kept-in-a-variable-calls-subclass-override',
    source: `const regular = (() => {
      class Base { make() { return () => this.read(); } read() { return 0; } }
      class Child extends Base { read() { return useEstimate(0); } }
      const kept = new Child().make();
      return kept();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'method-read-off-this-and-stored-calls-subclass-override',
    source: `const regular = (() => {
      let stored;
      class Base { init() { stored = this.helper; } helper() { return 0; } }
      class Child extends Base { helper() { return useEstimate(0); } }
      new Child().init();
      return stored();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'this-returned-inside-an-object-calls-subclass-override',
    source: `const regular = (() => {
      class Base { wrap() { return { me: this }; } helper() { return 0; } }
      class Child extends Base { helper() { return useEstimate(0); } }
      return new Child().wrap().me.helper();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'grandchild-override-reached-through-an-inherited-arrow-field',
    source: `const regular = (() => {
      class Base { run = () => this.read(); read() { return 0; } }
      class Middle extends Base {}
      class Leaf extends Middle { read() { return useEstimate(0); } }
      return new Leaf().run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'class-expression-subclass-override-reached-through-an-arrow-field',
    source: `const regular = (() => {
      const Base = class { run = () => this.read(); read() { return 0; } };
      const Child = class extends Base { read() { return useEstimate(0); } };
      return new Child().run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'static-arrow-returned-by-method-calls-subclass-override',
    source: `const regular = (() => {
      class Base { static make() { return () => this.read(); } static read() { return 0; } }
      class Child extends Base { static read() { return useEstimate(0); } }
      return Child.make()();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'arrow-field-of-own-class-calls-own-hook-pin',
    source: `const regular = (() => {
      class Base { run = () => this.read(); read() { return useEstimate(0); } }
      return new Base().run();
    })();`,
  },
  {
    expected: 'constant',
    id: 'arrow-field-ignores-an-unrelated-class-with-the-same-method',
    source: `const regular = (() => {
      class Base { run = () => this.read(); read() { return 0; } }
      class Other { read() { return useEstimate(0); } }
      return new Base().run();
    })();`,
  },
  {
    expected: 'constant',
    id: 'subclass-override-is-not-reached-while-the-arrow-is-never-called-pin',
    source: `const regular = (() => {
      class Base { run = () => this.read(); read() { return 0; } }
      class Child extends Base { read() { return useEstimate(0); } }
      return new Child();
    })();`,
  },
  {
    expected: 'constant',
    id: 'static-field-arrow-stays-on-the-declaring-class',
    source: `const regular = (() => {
      class Base { static run = () => this.read(); static read() { return 0; } }
      class Child extends Base { static read() { return useEstimate(0); } }
      return Base.run();
    })();`,
  },
  {
    expected: 'constant',
    id: 'subclass-heritage-cycle-through-reassignment-terminates',
    source: `const regular = (() => {
      let Base = class { run = () => this.read(); read() { return 0; } };
      Base = class extends Base { read() { return 0; } };
      return new Base().run();
    })();`,
  },
];

describe('a this the analysis cannot place is the class it is written in, and every class extending it', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Classifies the single statement in `entry.source` via `constantOf`. */
  function classify(entry: Case): string {
    using parsed = parseModule(api, 'detached-this-subclasses.ts', entry.source);
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
