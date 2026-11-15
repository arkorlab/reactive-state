import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isFunctionDeclaration, isVariableStatement } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { exportedMember } from '../src/compiler/exported-values.ts';
import { Modules } from '../src/compiler/modules.ts';
import { isConstant, stateStatementOf } from '../src/compiler/statements.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

interface Case {
  readonly id: string;
  readonly kind: 'exported' | 'flags' | 'state';
  readonly source: string;
  readonly expected: unknown;
}

/**
 * `isConstant` inspects `NodeFlags` on the declaration list rather than matching whitespace after
 * `const`, so comments or adjacent destructuring brackets stay `const` while `await using` does not.
 */
const CASES: readonly Case[] = [
  {
    expected: [true],
    id: 'block-comment-after-const-flag',
    kind: 'flags',
    source: 'const/* explanation */ value = 1;',
  },
  {
    expected: [true],
    id: 'array-destructuring-without-space',
    kind: 'flags',
    source: 'const[first] = [1];',
  },
  {
    expected: [true],
    id: 'object-destructuring-without-space',
    kind: 'flags',
    source: 'const{ first } = { first: 1 };',
  },
  {
    expected: '42',
    id: 'exported-commented-constant-value',
    kind: 'exported',
    source: 'export const/* explanation */ value = 42;\n',
  },
  {
    expected: 'state',
    id: 'state-declaration-without-space',
    kind: 'state',
    source: 'const[value, setValue] = useReactiveState(0);',
  },
  {
    expected: 'hook',
    id: 'custom-hook-declaration-without-space',
    kind: 'state',
    source: 'const{ filter } = useFilter(initial);',
  },
  {
    expected: [true],
    id: 'plain-spaced-const-pin',
    kind: 'flags',
    source: 'const value = 1;',
  },
  {
    expected: [false],
    id: 'let-with-block-comment-pin',
    kind: 'flags',
    source: 'let/* explanation */ value = 1;',
  },
  {
    expected: [false],
    id: 'var-declaration-pin',
    kind: 'flags',
    source: 'var value = 1;',
  },
  {
    expected: [false, false],
    id: 'using-and-await-using-declarations-pin',
    kind: 'flags',
    source: 'async function run() { using a = make(); await using b = make(); }',
  },
];

describe('constant declaration list flags', () => {
  let api: API;
  let tempDir: string;

  beforeAll(() => {
    api = openTypeScript();
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'rs-const-flags-'));
  });

  afterAll(() => {
    rmSync(tempDir, { force: true, recursive: true });
    api[Symbol.dispose]();
  });

  /** Evaluates one `Case` against `isConstant`, `exportedMember`, or `stateStatementOf`. */
  function evaluate(entry: Case): unknown {
    if (entry.kind === 'exported') {
      const file = path.join(tempDir, `${entry.id}.ts`);
      writeFileSync(file, entry.source, 'utf8');
      using modules = new Modules(api, tempDir);
      const found = exportedMember(modules, file, 'value', []);
      return found?.getText(found.getSourceFile());
    }
    using parsed = parseModule(api, 'const-flags.ts', entry.source);
    if (entry.kind === 'state') {
      const statement = parsed.sourceFile.statements[0];
      const state = stateStatementOf(
        statement,
        {
          isHook: (identifier) => identifier.text === 'useFilter',
          sourceFile: parsed.sourceFile,
        },
        (reason) => {
          throw new Error(reason);
        },
      );
      return state?.kind;
    }
    const fn = parsed.sourceFile.statements.find((each) => isFunctionDeclaration(each));
    const statements = fn?.body?.statements ?? parsed.sourceFile.statements;
    return statements
      .filter((each) => isVariableStatement(each))
      .map((statement) => isConstant(statement, parsed.sourceFile));
  }

  it.each(CASES)('$id', (entry) => {
    expect(evaluate(entry)).toStrictEqual(entry.expected);
  });
});
