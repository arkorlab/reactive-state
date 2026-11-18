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
    id: 'static-block-constant-key-selects-one-member',
    source: `const regular = (() => {
      class Holder {
        static {
          const key = 'safe'; const o = { safe() { return 0; }, unsafe() { return useEstimate(0); } }; o[key]();
        }
      }
      return 0;
    })();`,
  },
  {
    expected: 'constant',
    id: 'method-body-constant-key-selects-one-member-pin',
    source: `const regular = (() => {
      const run = () => {
        const key = 'safe'; const o = { safe() { return 0; }, unsafe() { return useEstimate(0); } }; o[key]();
      };
      run();
      return 0;
    })();`,
  },
  {
    expected: 'constant',
    id: 'static-block-constant-index-selects-one-element',
    source: `const regular = (() => {
      class Holder {
        static {
          const i = 0; const a = [() => 0, () => useEstimate(0)]; a[i]();
        }
      }
      return 0;
    })();`,
  },
  {
    expected: 'constant',
    id: 'method-body-constant-index-selects-one-element-pin',
    source: `const regular = (() => {
      const run = () => {
        const i = 0; const a = [() => 0, () => useEstimate(0)]; a[i]();
      };
      run();
      return 0;
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'static-block-constant-key-reaches-the-called-member',
    source: `const regular = (() => {
      class Holder {
        static {
          const key = 'unsafe'; const o = { safe() { return 0; }, unsafe() { return useEstimate(0); } }; o[key]();
        }
      }
      return 0;
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'method-body-constant-key-reaches-the-called-member-pin',
    source: `const regular = (() => {
      const run = () => {
        const key = 'unsafe'; const o = { safe() { return 0; }, unsafe() { return useEstimate(0); } }; o[key]();
      };
      run();
      return 0;
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'static-block-kept-call-name-reaches-the-function',
    source: `const regular = (() => {
      class Holder {
        static {
          const name = 'call'; function target() { return useEstimate(0); } target[name](null);
        }
      }
      return 0;
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'method-body-kept-call-name-reaches-the-function-pin',
    source: `const regular = (() => {
      const run = () => {
        const name = 'call'; function target() { return useEstimate(0); } target[name](null);
      };
      run();
      return 0;
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'static-block-reassigned-callee-is-followed',
    source: `const regular = (() => {
      class Holder {
        static {
          let step = () => 0; step = () => useEstimate(0); step();
        }
      }
      return 0;
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'method-body-reassigned-callee-is-followed-pin',
    source: `const regular = (() => {
      const run = () => {
        let step = () => 0; step = () => useEstimate(0); step();
      };
      run();
      return 0;
    })();`,
  },
  {
    expected: 'constant',
    id: 'static-block-hook-free-block-is-allowed',
    source: `const regular = (() => {
      class Holder {
        static {
          const key = 'a'; const o = { a() { return 0; } }; o[key]();
        }
      }
      return 0;
    })();`,
  },
  {
    expected: 'constant',
    id: 'method-body-hook-free-block-is-allowed-pin',
    source: `const regular = (() => {
      const run = () => {
        const key = 'a'; const o = { a() { return 0; } }; o[key]();
      };
      run();
      return 0;
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'static-block-of-a-class-made-by-a-called-function-is-read-pin',
    source: `const regular = (() => {
      const make = () => class {
        static {
          const key = 'unsafe';
          const own = { safe() { return 0; }, unsafe() { return useEstimate(0); } };
          own[key]();
        }
      };
      make();
      return 0;
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'static-block-of-the-statements-own-class-expression-is-read-pin',
    source: `const regular = class {
      static {
        const key = 'unsafe';
        const own = { safe() { return 0; }, unsafe() { return useEstimate(0); } };
        own[key]();
      }
    };`,
  },
  {
    expected: 'constant',
    id: 'static-block-of-a-class-made-by-a-called-function-selects-one-member',
    source: `const regular = (() => {
      const make = () => class {
        static {
          const key = 'safe';
          const own = { safe() { return 0; }, unsafe() { return useEstimate(0); } };
          own[key]();
        }
      };
      make();
      return 0;
    })();`,
  },
];

describe('a class static block is read once, as the function bodies around it are', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Classifies the single statement in `entry.source` via `constantOf`. */
  function classify(entry: Case): string {
    using parsed = parseModule(api, 'class-static-blocks.ts', entry.source);
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
