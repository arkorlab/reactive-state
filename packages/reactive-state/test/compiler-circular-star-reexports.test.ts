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
  readonly entry?: string;
  readonly expected: Resolved | undefined;
  readonly files: Readonly<Record<string, string>>;
  readonly id: string;
  readonly keys?: readonly string[];
  readonly name?: string;
}

const DIAMOND_LAYERS = { count: 8 } as const;

function buildDiamondAboveCycleFiles(): Readonly<Record<string, string>> {
  const files: Record<string, string> = {
    'c.ts': 'export const value = 42;\n',
    'hub.ts': "export * from './spoke.ts';\nexport * from './c.ts';\n",
    'spoke.ts': "export { value } from './hub.ts';\n",
  };
  let target = 'hub.ts';
  for (let index = DIAMOND_LAYERS.count - 1; index >= 0; index -= 1) {
    const left = `left-${String(index)}.ts`;
    const right = `right-${String(index)}.ts`;
    const layer = index === 0 ? 'a.ts' : `layer-${String(index)}.ts`;
    files[left] = `export * from './${target}';\n`;
    files[right] = `export * from './${target}';\n`;
    files[layer] = `export * from './${left}';\nexport * from './${right}';\n`;
    target = layer;
  }
  return files;
}

/**
 * Circular re-exports reached through `export *` (`export { value } from './a.ts'` or
 * `import { value } from './a.ts'; export { value }`) skip the active cycle branch so sibling
 * `export *` constants still resolve, while pure cycles with no binding and conflicts against
 * mutable exports still resolve to `undefined`.
 */
const CASES: readonly Case[] = [
  {
    expected: { file: 'c.ts', global: undefined, text: '42' },
    files: {
      'a.ts': "export * from './b.ts';\nexport * from './c.ts';\n",
      'b.ts': "export { value } from './a.ts';\n",
      'c.ts': 'export const value = 42;\n',
    },
    id: 'circular-named-reexport-before-valid-star',
  },
  {
    expected: { file: 'c.ts', global: undefined, text: '42' },
    files: {
      'a.ts': "export * from './c.ts';\nexport * from './b.ts';\n",
      'b.ts': "export { value } from './a.ts';\n",
      'c.ts': 'export const value = 42;\n',
    },
    id: 'circular-named-reexport-after-valid-star',
  },
  {
    expected: { file: 'c.ts', global: undefined, text: '42' },
    files: {
      'a.ts': "export * from './b.ts';\nexport * from './c.ts';\n",
      'b.ts': "export { alias as value } from './d.ts';\n",
      'c.ts': 'export const value = 42;\n',
      'd.ts': "export { value as alias } from './a.ts';\n",
    },
    id: 'multi-hop-circular-named-reexport-star',
  },
  {
    expected: { file: 'c.ts', global: undefined, text: '42' },
    files: {
      'a.ts': "export * from './b.ts';\nexport * from './c.ts';\n",
      'b.ts': "import { value } from './a.ts';\nexport { value };\n",
      'c.ts': 'export const value = 42;\n',
    },
    id: 'circular-import-then-export-specifier-star',
  },
  {
    expected: { file: 'c.ts', global: undefined, text: '42' },
    files: {
      'a.ts': "export * from './b.ts';\nexport * from './c.ts';\n",
      'b.ts': "import picked from './d.ts';\nexport { picked as value };\n",
      'c.ts': 'export const value = 42;\n',
      'd.ts': "import { value } from './a.ts';\nexport { value as default };\n",
    },
    id: 'circular-default-import-reexport-through-star',
  },
  {
    expected: { file: 'c.ts', global: undefined, text: '42' },
    files: {
      'a.ts': "export * from './m.ts';\nexport * from './c.ts';\n",
      'b.ts': "export { value } from './a.ts';\n",
      'c.ts': 'export const value = 42;\n',
      'm.ts': "export { value } from './n.ts';\n",
      'n.ts': "export * from './b.ts';\n",
    },
    id: 'nested-star-hub-circular-named-reexport',
  },
  {
    expected: { file: 'c.ts', global: undefined, text: "'ok'" },
    files: {
      'a.ts': "export * from './b.ts';\nexport * from './c.ts';\n",
      'b.ts': "export { config as value } from './d.ts';\n",
      'c.ts': "export const value = { nested: 'ok' };\n",
      'd.ts': "export { value as config } from './a.ts';\n",
    },
    id: 'circular-named-reexport-member-projection',
    keys: ['nested'],
  },
  {
    expected: { file: 'c.ts', global: undefined, text: '42' },
    files: {
      'a.ts': "export * from './b.ts';\nexport * from './c.ts';\n",
      'b.ts': "export { value } from './a.ts';\nexport * from './shadowed.ts';\n",
      'c.ts': 'export const value = 42;\n',
      'shadowed.ts': 'export const value = 99;\n',
    },
    id: 'circular-reexport-does-not-fall-through-own-star',
  },
  {
    expected: { file: 'c.ts', global: undefined, text: '42' },
    files: buildDiamondAboveCycleFiles(),
    id: 'stacked-diamonds-above-circular-star',
  },
  {
    entry: 'b.ts',
    expected: { file: 'c.ts', global: undefined, text: '42' },
    files: {
      'a.ts': "export * from './b.ts';\nexport * from './c.ts';\n",
      'b.ts': "export { value } from './a.ts';\n",
      'c.ts': 'export const value = 42;\n',
    },
    id: 'circular-spoke-entry-resolves-star-pin',
  },
  {
    expected: undefined,
    files: {
      'a.ts': "export * from './b.ts';\n",
      'b.ts': "export { value } from './a.ts';\n",
    },
    id: 'pure-star-to-named-cycle-pin',
  },
  {
    expected: undefined,
    files: {
      'a.ts': "export { value } from './b.ts';\n",
      'b.ts': "export { value } from './a.ts';\n",
    },
    id: 'pure-mutual-named-reexport-cycle-pin',
  },
  {
    expected: undefined,
    files: {
      'a.ts': "export { value } from './a.ts';\nexport * from './b.ts';\n",
      'b.ts': 'export const value = 42;\n',
    },
    id: 'explicit-self-cycle-shadows-own-star-pin',
  },
  {
    expected: undefined,
    files: {
      'a.ts': "export * from './b.ts';\nexport * from './c.ts';\n",
      'b.ts': "export { other as value } from './d.ts';\n",
      'c.ts': 'export const value = 42;\n',
      'd.ts': "export { other } from './d.ts';\n",
    },
    id: 'closed-external-cycle-conflicts-with-star-pin',
  },
  {
    expected: undefined,
    files: {
      'a.ts': "export * from './b.ts';\nexport * from './c.ts';\n",
      'b.ts': 'export let value = 1;\n',
      'c.ts': 'export const value = 42;\n',
    },
    id: 'mutable-star-branch-conflicts-with-const-pin',
  },
  {
    expected: undefined,
    files: {
      'a.ts': "export * from './b.ts';\nexport * from './c.ts';\nexport * from './d.ts';\n",
      'b.ts': "export { value } from './a.ts';\n",
      'c.ts': 'export let value = 1;\n',
      'd.ts': 'export const value = 42;\n',
    },
    id: 'circular-plus-mutable-and-const-stars-conflict-pin',
  },
];

describe('circular re-exports across star exports', () => {
  let api: API;
  let tempDir: string;

  beforeAll(() => {
    api = openTypeScript();
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'rs-circular-star-exports-'));
  });

  afterAll(() => {
    rmSync(tempDir, { force: true, recursive: true });
    api[Symbol.dispose]();
  });

  /** Writes `entry.files` into an isolated directory and resolves `entry.name` on `entry.entry`. */
  function resolveCase(entry: Case): Resolved | undefined {
    const dir = path.join(tempDir, entry.id);
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(entry.files)) {
      writeFileSync(path.join(dir, name), content, 'utf8');
    }
    using modules = new Modules(api, dir);
    const found = exportedMember(
      modules,
      path.join(dir, entry.entry ?? 'a.ts'),
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
