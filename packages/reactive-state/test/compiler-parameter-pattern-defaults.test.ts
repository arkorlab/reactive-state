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
    id: 'arrow-parameter-pattern-reads-a-getter-of-its-default',
    source:
      'const regular = (({ value } = { get value() { return useEstimate(0); } }) => value)();',
  },
  {
    expected: HOOK_IN_CONST,
    id: 'function-parameter-pattern-reads-a-getter-of-its-default',
    source:
      'const regular = (function ({ value } = { get value() { return useEstimate(0); } }) { return value; })();',
  },
  {
    expected: HOOK_IN_CONST,
    id: 'nested-parameter-pattern-reads-a-getter-of-its-default',
    source: `const regular = (({ inner: { value } } = { inner: { get value() { return useEstimate(0); } } }) => value)();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'method-parameter-pattern-reads-a-getter-of-its-default',
    source: `const regular = ({
      run({ value } = { get value() { return useEstimate(0); } }) { return value; },
    }).run();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'constructor-parameter-pattern-reads-a-getter-of-its-default',
    source: `const regular = new (class {
      constructor({ value } = { get value() { return useEstimate(0); } }) {}
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'callback-parameter-pattern-reads-a-getter-of-its-default',
    source: `const regular = [undefined].map(
      ({ value } = { get value() { return useEstimate(0); } }) => value,
    );`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'variable-pattern-reads-a-getter-of-its-initializer-pin',
    source: `const regular = (() => {
      const { value } = { get value() { return useEstimate(0); } };
      return value;
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'parameter-default-calls-a-hook-pin',
    source: 'const regular = ((value = useEstimate(0)) => value)();',
  },
  {
    expected: HOOK_IN_CONST,
    id: 'parameter-pattern-reads-a-getter-of-its-argument-pin',
    source: `const regular = (({ value }) => value)({ get value() { return useEstimate(0); } });`,
  },
  {
    expected: 'constant',
    id: 'parameter-pattern-with-a-plain-default-allowed',
    source: 'const regular = (({ value } = { value: 1 }) => value)();',
  },
  {
    expected: 'constant',
    id: 'function-with-a-getter-default-is-never-called-allowed',
    source: `const regular = (() => {
      const read = ({ value } = { get value() { return useEstimate(0); } }) => value;
      return read;
    })();`,
  },
];

describe('a parameter pattern reads its default value when the function is called', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Classifies the single statement in `entry.source` via `constantOf`. */
  function classify(entry: Case): string {
    using parsed = parseModule(api, 'parameter-pattern-defaults.ts', entry.source);
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
