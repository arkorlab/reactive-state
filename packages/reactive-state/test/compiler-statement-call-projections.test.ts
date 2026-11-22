import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { constantOf, type Reading, stateStatementOf } from '../src/compiler/statements.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const HOOKS = new Set(['useEstimate', 'useState']);

interface Case {
  readonly expected: string;
  readonly id: string;
  readonly mode: 'constant' | 'state';
  readonly source: string;
}

const HOOK_IN_CONST =
  'refused:`useEstimate` is called on its own, with `const`, as state is declared';

const CASES: readonly Case[] = [
  {
    expected: HOOK_IN_CONST,
    id: 'factory-return-local-callee-refused',
    mode: 'constant',
    source: 'const regular = (() => { const run = () => useEstimate(0); return run; })()();',
  },
  {
    expected: 'constant',
    id: 'factory-return-shadowed-safe-local-allowed',
    mode: 'constant',
    source: `const regular = (() => {
      const run = () => useEstimate(0);
      const makeHelper = () => {
        const run = () => 0;
        return run;
      };
      return makeHelper()();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'super-instance-method-hook-refused',
    mode: 'constant',
    source: `const regular = (() => {
      class Base {
        run() {
          return useEstimate(0);
        }
      }
      class Child extends Base {
        other() {
          return super.run();
        }
      }
      return new Child().other();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'super-static-method-hook-refused',
    mode: 'constant',
    source: `const regular = (() => {
      class Base {
        static run() {
          return useEstimate(0);
        }
      }
      class Child extends Base {
        static other() {
          return super.run();
        }
      }
      return Child.other();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'object-proto-inherited-method-refused',
    mode: 'constant',
    source: 'const regular = ({ __proto__: { run() { return useEstimate(0); } } }).run();',
  },
  {
    expected: 'constant',
    id: 'object-proto-overridden-method-allowed',
    mode: 'constant',
    source:
      'const regular = ({ __proto__: { run() { return useEstimate(0); } }, run() { return 1; } }).run();',
  },
  {
    expected: 'constant',
    id: 'class-override-skips-base-hook-allowed',
    mode: 'constant',
    source: `const regular = (() => {
      class Base {
        run() {
          return useEstimate(0);
        }
      }
      class Child extends Base {
        run() {
          return 1;
        }
      }
      return new Child().run();
    })();`,
  },
  {
    expected: 'constant',
    id: 'object-spread-overridden-by-later-method-allowed',
    mode: 'constant',
    source:
      'const regular = ({ ...{ run() { return useEstimate(0); } }, run() { return 1; } }).run();',
  },
  {
    expected: 'constant',
    id: 'object-later-safe-spread-overrides-earlier-method-allowed',
    mode: 'constant',
    source:
      'const regular = ({ run() { return useEstimate(0); }, ...{ run() { return 1; } } }).run();',
  },
  {
    expected: HOOK_IN_CONST,
    id: 'inherited-method-this-override-on-child-refused',
    mode: 'constant',
    source: `const regular = (() => {
      class Base {
        run() {
          return this.read();
        }
        read() {
          return 0;
        }
      }
      class Child extends Base {
        read() {
          return useEstimate(0);
        }
      }
      return new Child().run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'inherited-method-safe-base-then-hook-child-refused',
    mode: 'constant',
    source: `const regular = (() => {
      class Base {
        run() {
          return this.read();
        }
        read() {
          return 0;
        }
      }
      class Child extends Base {
        read() {
          return useEstimate(0);
        }
      }
      new Base().run();
      return new Child().run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'class-prototype-method-call-refused',
    mode: 'constant',
    source: `const regular = (() => {
      class C {
        run() {
          return useEstimate(0);
        }
      }
      return C.prototype.run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'unary-increment-invalidates-static-index-refused',
    mode: 'constant',
    source: `const regular = (() => {
      let index = 0;
      index++;
      const callbacks = [() => 0, () => useEstimate(0)];
      return callbacks[index]();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'compound-assignment-invalidates-static-key-refused',
    mode: 'constant',
    source: `const regular = (() => {
      let key = 'safe';
      key += 'r';
      const obj = { safe: () => 0, safer: () => useEstimate(0) };
      return obj[key]();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'destructuring-assignment-member-setter-refused',
    mode: 'constant',
    source: `const regular = (() => {
      const box = {
        set value(v: number) {
          useEstimate(v);
        },
      };
      ({ value: box.value } = { value: 1 });
      return 0;
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'for-of-member-target-setter-refused',
    mode: 'constant',
    source: `const regular = (() => {
      const box = {
        set value(v: number) {
          useEstimate(v);
        },
      };
      for (box.value of [1]) {
        void box;
      }
      return 0;
    })();`,
  },
  {
    expected: 'constant',
    id: 'object-rest-excludes-extracted-method-on-escape-allowed',
    mode: 'constant',
    source: `const regular = (() => {
      const { run, ...rest } = {
        run() {
          return useEstimate(0);
        },
        value: 0,
      };
      void run;
      return consume(rest);
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'object-rest-retains-unextracted-method-pin',
    mode: 'constant',
    source: `const regular = (() => {
      const { safe, ...rest } = {
        safe: 1,
        run() {
          return useEstimate(0);
        },
      };
      void safe;
      return rest.run();
    })();`,
  },
  {
    expected: 'constant',
    id: 'array-length-read-skips-element-callables-allowed',
    mode: 'constant',
    source: 'const regular = Number((() => [() => useEstimate(0)])().length);',
  },
  {
    expected: HOOK_IN_CONST,
    id: 'conditional-shared-receiver-branch-hook-refused',
    mode: 'constant',
    source: `const regular = (() => {
      const handlers = { safe: () => 0, bad: () => useEstimate(0) };
      return (flag ? handlers.safe : handlers.bad)();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'receiver-reassignment-replays-member-call-refused',
    mode: 'constant',
    source: `const regular = (() => {
      let box = {
        run() {
          return 0;
        },
      };
      const read = () => box.run();
      const replace = () => {
        box = {
          run() {
            return useEstimate(0);
          },
        };
      };
      read();
      replace();
      return read();
    })();`,
  },
  {
    expected: 'constant',
    id: 'self-referential-object-spread-projection-terminates',
    mode: 'constant',
    source: `const regular = (() => {
      let obj = { count: 1 };
      obj = { ...obj };
      return obj.count;
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'for-of-destructured-binding-call-refused',
    mode: 'constant',
    source: `const regular = (() => {
      for (const { run } of [{ run() { return useEstimate(0); } }]) {
        run();
      }
      return 0;
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'array-rest-binding-indexed-call-refused',
    mode: 'constant',
    source: `const regular = (() => {
      const [...runs] = [() => useEstimate(0)];
      return runs[0]();
    })();`,
  },
  {
    expected: 'constant',
    id: 'array-rest-offset-skips-consumed-prefix-allowed',
    mode: 'constant',
    source: `const regular = (() => {
      const [first, ...runs] = [() => useEstimate(0), () => 0];
      void first;
      return runs[0]();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'nested-object-binding-pattern-call-refused',
    mode: 'constant',
    source: `const regular = (() => {
      const obj = {
        a: {
          run() {
            return useEstimate(0);
          },
        },
      };
      const {
        a: { run },
      } = obj;
      return run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'object-rest-assignment-method-call-refused',
    mode: 'constant',
    source: `const regular = (() => {
      let rest;
      ({ ...rest } = {
        run() {
          return useEstimate(0);
        },
      });
      return rest.run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'nested-object-assignment-pattern-call-refused',
    mode: 'constant',
    source: `const regular = (() => {
      let run;
      const obj = {
        a: {
          run() {
            return useEstimate(0);
          },
        },
      };
      ({
        a: { run },
      } = obj);
      return run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'whole-instance-escape-activates-callable-field-refused',
    mode: 'constant',
    source: 'const regular = consume(new class { run = () => useEstimate(0); }());',
  },
  {
    expected: 'constant',
    id: 'non-escaped-instance-keeps-callable-field-passive-allowed',
    mode: 'constant',
    source: 'const regular = (() => { new class { run = () => useEstimate(0); }(); return 0; })();',
  },
];

describe('scoped synchronous statement call projections and write propagation', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Classifies the single statement in `entry.source` via `stateStatementOf` or `constantOf`. */
  function classify(entry: Case): string {
    using parsed = parseModule(api, 'statement-call-projections.ts', entry.source);
    const statement = parsed.sourceFile.statements[0];
    if (statement === undefined) {
      throw new Error('Missing statement.');
    }
    const reading: Reading = {
      isHook: (identifier) => HOOKS.has(identifier.text),
      sourceFile: parsed.sourceFile,
    };
    try {
      if (entry.mode === 'constant') {
        constantOf(statement, reading, (reason) => {
          throw new Error(reason);
        });
        return 'constant';
      }
      const state = stateStatementOf(statement, reading, (reason) => {
        throw new Error(reason);
      });
      if (state === null) {
        return 'null';
      }
      return state.kind === 'state'
        ? `state:${state.value.text}:${state.setter?.text ?? ''}`
        : `hook:${state.callee.text}`;
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
