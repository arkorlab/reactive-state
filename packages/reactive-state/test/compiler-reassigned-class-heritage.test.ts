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
    expected: 'constant',
    id: 'reassigned-class-extends-previous-value-escape-terminates',
    source: `const regular = (() => {
      let Base = class {};
      Base = class extends Base {};
      return consume(Base);
    })();`,
  },
  {
    expected: 'constant',
    id: 'reassigned-declaration-extends-previous-value-escape-terminates',
    source: `const regular = (() => {
      class First {}
      let Current = First;
      Current = class extends Current {};
      return consume(Current);
    })();`,
  },
  {
    expected: 'constant',
    id: 'reassigned-class-prototype-escape-terminates',
    source: `const regular = (() => {
      let Base = class {};
      Base = class extends Base {};
      return consume(Base.prototype);
    })();`,
  },
  {
    expected: 'constant',
    id: 'mutual-heritage-through-reassignment-escape-terminates',
    source: `const regular = (() => {
      let First = class {};
      const Second = class extends First {};
      First = class extends Second {};
      return consume(First);
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'reassigned-class-base-hook-method-escape-refused-pin',
    source: `const regular = (() => {
      let Base = class { run() { return useEstimate(0); } };
      Base = class extends Base {};
      return consume(Base);
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'reassigned-class-subclass-hook-method-escape-refused',
    source: `const regular = (() => {
      let Base = class {};
      Base = class extends Base { run() { return useEstimate(0); } };
      return consume(Base);
    })();`,
  },
  {
    expected: 'constant',
    id: 'reassigned-class-construction-terminates-pin',
    source: `const regular = (() => {
      let Base = class {};
      Base = class extends Base {};
      return new Base();
    })();`,
  },
  {
    expected: 'constant',
    id: 'reassigned-class-super-call-terminates-pin',
    source: `const regular = (() => {
      let Base = class { run() { return 0; } };
      Base = class extends Base { other() { return super.run(); } };
      return new Base().other();
    })();`,
  },
  {
    expected: 'constant',
    id: 'reassigned-class-instance-escape-terminates',
    source: `const regular = (() => {
      let Base = class {};
      Base = class extends Base {};
      return consume(new Base());
    })();`,
  },
  {
    expected: 'constant',
    id: 'reassigned-object-prototype-escape-terminates-pin',
    source: `const regular = (() => {
      let target = {};
      target = { __proto__: target, run() { return 0; } };
      return consume(target);
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'class-chain-escape-base-hook-method-refused-pin',
    source: `const regular = (() => {
      class First { run() { return useEstimate(0); } }
      class Second extends First {}
      return consume(Second);
    })();`,
  },
  {
    expected: 'constant',
    id: 'class-chain-escape-without-hook-allowed-pin',
    source: `const regular = (() => {
      class First { run() { return 0; } }
      class Second extends First {}
      return consume(Second);
    })();`,
  },
];

describe('escaping a class whose heritage is a reassigned binding', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Classifies the single statement in `entry.source` via `constantOf`. */
  function classify(entry: Case): string {
    using parsed = parseModule(api, 'reassigned-class-heritage.ts', entry.source);
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
