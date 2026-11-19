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
  readonly id: string;
  readonly files: Readonly<Record<string, string>>;
  readonly name?: string;
  readonly keys?: readonly string[];
  readonly expected: Resolved | undefined;
}

/**
 * Re-exported bindings keep the module that declared them rather than settling again against the
 * re-exporting module's declarations, while `export *` omits `default` and type-only re-exports.
 */
const CASES: readonly Case[] = [
  {
    expected: { file: 'b.ts', global: 'Infinity', text: 'Infinity' },
    files: {
      'a.ts': "const Infinity = 0;\nexport { value } from './b.ts';\n",
      'b.ts': 'export const value = Infinity;\n',
    },
    id: 'named-reexport-preserves-defining-global',
  },
  {
    expected: { file: 'b.ts', global: 'Infinity', text: 'Infinity' },
    files: {
      'a.ts':
        "const Infinity = 0;\nconst inner = 0;\nexport { original as value } from './b.ts';\n",
      'b.ts': 'const inner = Infinity;\nexport { inner as original };\n',
    },
    id: 'aliased-named-reexport-preserves-defining-global',
  },
  {
    expected: { file: 'b.ts', global: 'Infinity', text: 'Infinity' },
    files: {
      'a.ts': "const Infinity = 0;\nexport { default as value } from './b.ts';\n",
      'b.ts': 'export default Infinity;\n',
    },
    id: 'default-to-named-reexport-preserves-defining-global',
  },
  {
    expected: { file: 'b.ts', global: 'Infinity', text: 'Infinity' },
    files: {
      'a.ts': "const Infinity = 0;\nexport { value as default } from './b.ts';\n",
      'b.ts': 'export const value = Infinity;\n',
    },
    id: 'named-to-default-reexport-preserves-defining-global',
    name: 'default',
  },
  {
    expected: { file: 'b.ts', global: 'Infinity', text: 'Infinity' },
    files: {
      'a.ts': "import { value } from './b.ts';\nconst Infinity = 0;\nexport { value };\n",
      'b.ts': 'export const value = Infinity;\n',
    },
    id: 'imported-then-locally-reexported-preserves-defining-global',
  },
  {
    expected: { file: 'a.ts', global: 'Infinity', text: 'Infinity' },
    files: {
      'a.ts': "export const first = Infinity;\nexport { first as value } from './a.ts';\n",
    },
    id: 'self-aliased-reexport-preserves-own-global',
  },
  {
    expected: undefined,
    files: {
      'a.ts': "export * from './b.ts';\n",
      'b.ts': 'export default 1;\n',
    },
    id: 'star-reexport-does-not-forward-default',
    name: 'default',
  },
  {
    expected: { file: 'b.ts', global: 'Infinity', text: 'Infinity' },
    files: {
      'a.ts': [
        "import type { Infinity } from './types.ts';",
        "export type { value } from './types.ts';",
        "export { type value as ignored } from './types.ts';",
        "export * from './b.ts';",
      ].join('\n'),
      'b.ts': "import { type Infinity } from './types.ts';\nexport const value = Infinity;\n",
      'types.ts': 'export const Infinity = 0;\nexport const value = 0;\n',
    },
    id: 'type-only-reexports-and-imports-do-not-shadow-runtime-value',
  },
  {
    expected: { file: 'c.ts', global: 'Infinity', text: 'Infinity' },
    files: {
      'a.ts': "const Infinity = 1;\nexport * from './b.ts';\n",
      'b.ts': "const Infinity = 0;\nexport { value } from './c.ts';\n",
      'c.ts': 'export const value = Infinity;\n',
    },
    id: 'chained-star-over-named-reexport',
  },
  {
    expected: { file: 'b.ts', global: 'Infinity', text: 'Infinity' },
    files: {
      'a.ts': "const Infinity = 0;\nexport * from './b.ts';\n",
      'b.ts': 'export const value = Infinity;\n',
    },
    id: 'direct-star-reexport-pin',
  },
  {
    expected: { file: 'b.ts', global: undefined, text: '0' },
    files: {
      'a.ts': "export { value } from './b.ts';\n",
      'b.ts': 'const Infinity = 0;\nexport const value = Infinity;\n',
    },
    id: 'defining-module-shadowed-global-pin',
  },
  {
    expected: { file: 'b.ts', global: 'Infinity', text: 'Infinity' },
    files: {
      'a.ts': "const KEY = 'other';\nconst Infinity = 0;\nexport { value } from './b.ts';\n",
      'b.ts': "const KEY = 'when';\nexport const value = { [KEY]: Infinity };\n",
    },
    id: 'reexported-object-member-uses-defining-module-pin',
    keys: ['when'],
  },
  {
    expected: undefined,
    files: {
      'a.ts': "let local = 1;\nexport const value = local;\nexport * from './b.ts';\n",
      'b.ts': 'export const value = 42;\n',
    },
    id: 'own-mutable-export-still-blocks-star-fallback-pin',
  },
];

describe('defining modules of re-exported values', () => {
  let api: API;
  let tempDir: string;

  beforeAll(() => {
    api = openTypeScript();
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'rs-reexport-modules-'));
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
