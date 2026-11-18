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
    id: 'tag-returns-a-function-that-is-called',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      function tag() { return actions.run; }
      return tag\`\`();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'tag-returns-an-object-whose-method-is-called',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      function tag() { return actions; }
      return tag\`\`.run();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'method-tag-returns-a-function-that-is-called',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      const holder = { tag() { return actions.run; } };
      return holder.tag\`\`();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'tag-with-substitutions-returns-a-function-that-is-called',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      function tag(parts, value) { return actions.run; }
      return tag\`a\${1}b\`();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'tag-returns-a-function-that-returns-a-function-that-is-called',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      const tag = () => () => actions.run;
      return tag\`\`()();
    })();`,
  },
  {
    expected: HOOK_IN_CONST,
    id: 'tag-that-calls-a-hook-itself-pin',
    source: `const regular = (() => {
      function tag() { return useEstimate(0); }
      return tag\`\`;
    })();`,
  },
  {
    expected: 'constant',
    id: 'tag-whose-result-is-never-called-allowed',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      function tag() { return actions.run; }
      return tag\`\`;
    })();`,
  },
  {
    expected: 'constant',
    id: 'tag-returning-a-safe-function-allowed',
    source: `const regular = (() => {
      const actions = { run() { return useEstimate(0); } };
      function tag() { return () => 0; }
      return tag\`\`();
    })();`,
  },
];

describe('a tagged template evaluates to what its tag returns', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Classifies the single statement in `entry.source` via `constantOf`. */
  function classify(entry: Case): string {
    using parsed = parseModule(api, 'tagged-template-results.ts', entry.source);
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
