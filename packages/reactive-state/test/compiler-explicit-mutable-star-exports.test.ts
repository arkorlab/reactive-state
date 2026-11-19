import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isIdentifier } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { globalOf } from '../src/compiler/bounded.ts';
import { exportedMember } from '../src/compiler/exported-values.ts';
import { Modules } from '../src/compiler/modules.ts';
import { openTypeScript } from '../src/compiler/typescript.ts';

interface Resolved {
  readonly file: string;
  readonly global: string | undefined;
  readonly text: string;
}

interface Case {
  readonly expected: Resolved | undefined;
  readonly files: Readonly<Record<string, string>>;
  readonly id: string;
  readonly keys?: readonly string[];
  readonly name?: string;
}

/**
 * Explicit runtime exports (`export let`, `export var`, destructured exports, `export { local }`,
 * `export { other } from`, `export * as name from`, runtime `enum`/`namespace`) shadow `export *`
 * even when their static value is `undefined`, and conflicting `export *` targets resolve to
 * `undefined` while diamond `export *` paths to one declaration still resolve.
 */
const CASES: readonly Case[] = [
  {
    expected: undefined,
    files: {
      'a.ts': "export let value = 1;\nexport * from './b.ts';\n",
      'b.ts': 'export const value = 42;\n',
    },
    id: 'export-let-shadows-star',
  },
  {
    expected: undefined,
    files: {
      'a.ts': "export * from './b.ts';\nexport var value = 1;\n",
      'b.ts': 'export const value = 42;\n',
    },
    id: 'export-var-after-star-shadows',
  },
  {
    expected: undefined,
    files: {
      'a.ts':
        "const pair = { other: 1 };\nexport const { other: value } = pair;\nexport * from './b.ts';\n",
      'b.ts': 'export const value = 42;\n',
    },
    id: 'export-destructured-const-shadows-star',
  },
  {
    expected: undefined,
    files: {
      'a.ts': "let local = 1;\nexport { local as value };\nexport * from './b.ts';\n",
      'b.ts': 'export const value = 42;\n',
    },
    id: 'export-named-mutable-local-shadows-star',
  },
  {
    expected: undefined,
    files: {
      'a.ts': "export { other as value } from './c.ts';\nexport * from './b.ts';\n",
      'b.ts': 'export const value = 42;\n',
      'c.ts': 'export let other = 1;\n',
    },
    id: 'export-named-remote-mutable-shadows-star',
  },
  {
    expected: undefined,
    files: {
      'a.ts': "export * as value from './c.ts';\nexport * from './b.ts';\n",
      'b.ts': 'export const value = 42;\n',
      'c.ts': 'export const item = 1;\n',
    },
    id: 'export-namespace-as-name-shadows-star',
  },
  {
    expected: undefined,
    files: {
      'a.ts': "export { default as value } from './c.ts';\nexport * from './b.ts';\n",
      'b.ts': 'export const value = 42;\n',
      'c.ts': 'let item = 1;\nexport default item;\n',
    },
    id: 'export-default-mutable-reexport-shadows',
  },
  {
    expected: undefined,
    files: {
      'a.ts': "export enum value { First = 1 }\nexport * from './b.ts';\n",
      'b.ts': 'export const value = 42;\n',
    },
    id: 'export-enum-shadows-star',
  },
  {
    expected: undefined,
    files: {
      'a.ts': "export * from './b.ts';\nexport * from './c.ts';\n",
      'b.ts': 'export let value = 1;\n',
      'c.ts': 'export const value = 42;\n',
    },
    id: 'conflicting-star-mutable-and-const',
  },
  {
    expected: undefined,
    files: {
      'a.ts': "export * from './b.ts';\nexport * from './c.ts';\n",
      'b.ts': 'export const value = 1;\n',
      'c.ts': 'export const value = 2;\n',
    },
    id: 'conflicting-star-two-consts',
  },
  {
    expected: {
      file: 'a.ts',
      global: undefined,
      text: 'export function value(x: unknown) { return x; }',
    },
    files: {
      'a.ts': [
        'export function value(x: number): number;',
        'export function value(x: unknown) { return x; }',
      ].join('\n'),
    },
    id: 'overloaded-exported-function-body',
  },
  {
    expected: { file: 'shared.ts', global: undefined, text: '42' },
    files: {
      'a.ts': "export * from './b.ts';\nexport * from './c.ts';\n",
      'b.ts': "export * from './shared.ts';\n",
      'c.ts': "export * from './shared.ts';\n",
      'shared.ts': 'export const value = 42;\n',
    },
    id: 'diamond-star-same-declaration-pin',
  },
  {
    expected: { file: 'b.ts', global: undefined, text: '42' },
    files: {
      'a.ts': [
        'export interface value { count: number }',
        'export declare const value: number;',
        'export namespace value { export type Item = number; }',
        "export * from './b.ts';",
      ].join('\n'),
      'b.ts': 'export const value = 42;\n',
    },
    id: 'erased-type-and-declare-do-not-shadow',
  },
  {
    expected: { file: 'a.ts', global: undefined, text: '7' },
    files: {
      'a.ts': "export * from './b.ts';\nexport const value = 7;\n",
      'b.ts': 'export const value = 42;\n',
    },
    id: 'own-const-wins-over-star-pin',
  },
];

describe('explicit runtime exports over star re-exports', () => {
  let api: API;
  let tempDir: string;

  beforeAll(() => {
    api = openTypeScript();
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'rs-explicit-star-exports-'));
  });

  afterAll(() => {
    rmSync(tempDir, { force: true, recursive: true });
    api[Symbol.dispose]();
  });

  /** Writes `entry.files` into an isolated directory and resolves `entry.name` on `a.ts`. */
  function resolveCase(entry: Case): Resolved | undefined {
    const dir = path.join(tempDir, entry.id);
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(entry.files)) {
      writeFileSync(path.join(dir, name), content, 'utf8');
    }
    using modules = new Modules(api, dir);
    const found = exportedMember(
      modules,
      path.join(dir, 'a.ts'),
      entry.name ?? 'value',
      entry.keys ?? [],
    );
    if (found === undefined) {
      return undefined;
    }
    const sourceFile = found.getSourceFile();
    return {
      file: path.basename(sourceFile.fileName),
      global: isIdentifier(found) ? globalOf(found) : undefined,
      text: found.getText(sourceFile),
    };
  }

  it.each(CASES)('$id', (entry) => {
    expect(resolveCase(entry)).toStrictEqual(entry.expected);
  });
});
