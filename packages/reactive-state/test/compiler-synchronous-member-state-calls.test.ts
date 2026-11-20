import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { constantOf, type Reading, stateStatementOf } from '../src/compiler/statements.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

interface Case {
  readonly expected: string;
  readonly id: string;
  readonly mode: 'constant' | 'state';
  readonly source: string;
}

const HOOKS = new Set(['useEstimate', 'useFilter']);

/**
 * `nestedStateCall` inspects synchronous sub-expressions of object methods, accessors, and classes
 * (computed names, heritage expressions, decorators, static field initializers, and static blocks)
 * while skipping deferred bodies, parameter defaults, instance initializers, and erased types.
 */
const CASES: readonly Case[] = [
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'computed-object-method-hook',
    mode: 'constant',
    source: 'const regular = { [useEstimate(initial)[0]]() {} };',
  },
  {
    expected: 'refused:State is declared on its own, with `const`',
    id: 'computed-object-getter-state',
    mode: 'constant',
    source: 'const regular = { get [useReactiveState(initial)[0]]() { return 1; } };',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'computed-object-setter-hook',
    mode: 'state',
    source: 'const regular = { set [useEstimate(initial)[0]](next: number) {} };',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'class-static-field-hook',
    mode: 'constant',
    source: 'const regular = class { static value = useEstimate(initial); };',
  },
  {
    expected: 'refused:State is declared on its own, with `const`',
    id: 'class-static-accessor-state',
    mode: 'constant',
    source: 'const regular = class { static accessor value = useReactiveState(initial); };',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'class-static-block-hook',
    mode: 'constant',
    source: 'const regular = class { static { useEstimate(initial); } };',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'class-extends-heritage-hook',
    mode: 'constant',
    source: 'const regular = class extends Base(useEstimate(initial)) {};',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'class-instance-computed-key-hook',
    mode: 'constant',
    source: 'const regular = class { [useEstimate(initial)[0]] = 1; };',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'class-member-decorator-hook',
    mode: 'constant',
    source: 'const regular = class { @decorate(useEstimate(initial)) method() {} };',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'class-param-decorator-hook',
    mode: 'constant',
    source:
      'const regular = class { constructor(@decorate(useEstimate(initial)) item: number) {} };',
  },
  {
    expected: 'refused:`useEstimate` is called on its own, with `const`, as state is declared',
    id: 'static-block-nested-class-hook',
    mode: 'constant',
    source: 'const regular = class { static { @decorate(useEstimate(initial)) class Inner {} } };',
  },
  {
    expected: 'constant',
    id: 'deferred-object-methods-pin',
    mode: 'constant',
    source: [
      'const regular = {',
      '  run(x = useEstimate(0)) { return useEstimate(x); },',
      '  get item() { return useReactiveState(0); },',
      '  set item(v = useEstimate(0)) { useEstimate(v); },',
      '};',
    ].join('\n'),
  },
  {
    expected: 'constant',
    id: 'deferred-class-members-pin',
    mode: 'constant',
    source: [
      'const regular = class {',
      '  item = useEstimate(0);',
      '  accessor other = useReactiveState(0);',
      '  constructor(x = useEstimate(0)) { useEstimate(x); }',
      '  static read() { return useEstimate(0); }',
      '};',
    ].join('\n'),
  },
  {
    expected: 'constant',
    id: 'deferred-inside-static-block-pin',
    mode: 'constant',
    source: [
      'const regular = class {',
      '  static {',
      '    function later() { return useEstimate(0); }',
      '    const arrow = () => useReactiveState(0);',
      '    class Inner { item = useEstimate(0); }',
      '  }',
      '};',
    ].join('\n'),
  },
  {
    expected: 'constant',
    id: 'erased-class-types-and-implements-pin',
    mode: 'constant',
    source: [
      'const regular = class<T = ReturnType<typeof useEstimate>>',
      '  implements Shape<ReturnType<typeof useEstimate>> {',
      '  declare [key]: ReturnType<typeof useEstimate>;',
      '  method(x: typeof useEstimate): void;',
      '  method() {}',
      '};',
    ].join('\n'),
  },
];

describe('synchronous member and class state calls', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Classifies the single statement in `entry.source` via `stateStatementOf` or `constantOf`. */
  function classify(entry: Case): string {
    using parsed = parseModule(api, 'synchronous-members.ts', entry.source);
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
