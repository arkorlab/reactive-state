import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isIdentifier } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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

const LAYERS = { coupled: 7, deep: 13 } as const;

function buildCyclicDiamond(options: {
  readonly backEdgeTarget: string;
  readonly bottomRest: readonly string[];
  readonly extraFiles: Readonly<Record<string, string>>;
  readonly layers: number;
  readonly prefix?: string;
  readonly topFile: string;
}): Readonly<Record<string, string>> {
  const prefix = options.prefix ?? '';
  const files: Record<string, string> = { ...options.extraFiles };
  let nextLeft = '';
  let nextRight = '';
  for (let index = options.layers - 1; index >= 0; index -= 1) {
    const left = `${prefix}left-${String(index)}.ts`;
    const right = `${prefix}right-${String(index)}.ts`;
    const targets =
      index === options.layers - 1
        ? [options.backEdgeTarget, ...options.bottomRest]
        : [nextLeft, nextRight];
    const body = targets.map((target) => `export * from './${target}';\n`).join('');
    files[left] = body;
    files[right] = body;
    nextLeft = left;
    nextRight = right;
  }
  files[options.topFile] = `export * from './${nextLeft}';\nexport * from './${nextRight}';\n`;
  return files;
}

function buildCoupledTwoSccFiles(): Readonly<Record<string, string>> {
  const lower = buildCyclicDiamond({
    backEdgeTarget: 'lower-top.ts',
    bottomRest: ['leaf.ts'],
    extraFiles: { 'leaf.ts': "export const value = { nested: 'ok' };\n" },
    layers: LAYERS.coupled,
    prefix: 'lo-',
    topFile: 'lower-top.ts',
  });
  return buildCyclicDiamond({
    backEdgeTarget: 'a.ts',
    bottomRest: ['lower-top.ts'],
    extraFiles: lower,
    layers: LAYERS.coupled,
    prefix: 'hi-',
    topFile: 'a.ts',
  });
}

/**
 * Cyclic diamond barrel graphs resolve in linear module-lookup count per `(file, export)` pair
 * rather than re-traversing shared descendants across every path when a back-edge reaches an
 * ancestor barrel.
 */
const CASES: readonly Case[] = [
  {
    expected: { file: 'leaf.ts', global: undefined, text: '42' },
    files: buildCyclicDiamond({
      backEdgeTarget: 'a.ts',
      bottomRest: ['leaf.ts'],
      extraFiles: { 'leaf.ts': 'export const value = 42;\n' },
      layers: LAYERS.deep,
      topFile: 'a.ts',
    }),
    id: 'cyclic-diamond-backedge-to-entry-leaf-const',
  },
  {
    expected: { file: 'leaf.ts', global: undefined, text: '42' },
    files: {
      ...buildCyclicDiamond({
        backEdgeTarget: 'hub.ts',
        bottomRest: ['leaf.ts'],
        extraFiles: { 'leaf.ts': 'export const value = 42;\n' },
        layers: LAYERS.deep,
        topFile: 'hub.ts',
      }),
      'a.ts': "export * from './hub.ts';\n",
    },
    id: 'cyclic-diamond-backedge-to-mid-hub-leaf-const',
  },
  {
    expected: undefined,
    files: buildCyclicDiamond({
      backEdgeTarget: 'a.ts',
      bottomRest: [],
      extraFiles: {},
      layers: LAYERS.deep,
      topFile: 'a.ts',
    }),
    id: 'cyclic-diamond-pure-backedge-no-export',
  },
  {
    expected: undefined,
    files: buildCyclicDiamond({
      backEdgeTarget: 'a.ts',
      bottomRest: ['leaf-a.ts', 'leaf-b.ts'],
      extraFiles: {
        'leaf-a.ts': 'export const value = 1;\n',
        'leaf-b.ts': 'export const value = 2;\n',
      },
      layers: LAYERS.deep,
      topFile: 'a.ts',
    }),
    id: 'cyclic-diamond-conflicting-leaf-consts',
  },
  {
    expected: { file: 'leaf.ts', global: undefined, text: '42' },
    files: buildCyclicDiamond({
      backEdgeTarget: 'spoke.ts',
      bottomRest: ['leaf.ts'],
      extraFiles: {
        'leaf.ts': 'export const value = 42;\n',
        'spoke.ts': "export { value } from './a.ts';\n",
      },
      layers: LAYERS.deep,
      topFile: 'a.ts',
    }),
    id: 'cyclic-diamond-named-reexport-backedge',
  },
  {
    expected: { file: 'leaf.ts', global: undefined, text: '42' },
    files: buildCyclicDiamond({
      backEdgeTarget: 'spoke.ts',
      bottomRest: ['leaf.ts'],
      extraFiles: {
        'leaf.ts': 'export const value = 42;\n',
        'spoke.ts': "import { value } from './a.ts';\nexport { value };\n",
      },
      layers: LAYERS.deep,
      topFile: 'a.ts',
    }),
    id: 'cyclic-diamond-imported-reexport-backedge',
  },
  {
    expected: { file: 'leaf.ts', global: undefined, text: "'ok'" },
    files: buildCoupledTwoSccFiles(),
    id: 'coupled-two-scc-cyclic-diamonds-member-read',
    keys: ['nested'],
  },
  {
    entry: 'consumer.ts',
    expected: { file: 'leaf.ts', global: undefined, text: '42' },
    files: {
      ...buildCyclicDiamond({
        backEdgeTarget: 'a.ts',
        bottomRest: ['leaf.ts'],
        extraFiles: { 'leaf.ts': 'export const value = 42;\n' },
        layers: LAYERS.deep,
        topFile: 'a.ts',
      }),
      'consumer.ts': "import { value } from './a.ts';\nexport const pair = [value];\n",
    },
    id: 'array-element-import-from-cyclic-diamond',
    keys: ['0'],
    name: 'pair',
  },
  {
    expected: undefined,
    files: {
      'a.ts': "export * from './c.ts';\nexport * from './b.ts';\n",
      'b.ts': "import { value as imported } from './a.ts';\nexport const value = imported;\n",
      'c.ts': 'export const value = 42;\n',
    },
    id: 'cyclic-local-const-from-import-conflicts-star-pin',
  },
  {
    entry: 'entry.ts',
    expected: { file: 'c.ts', global: undefined, text: '42' },
    files: {
      'a.ts': "export * from './b.ts';\nexport * from './c.ts';\n",
      'b.ts': "export { value } from './a.ts';\n",
      'c.ts': 'export const value = 42;\n',
      'entry.ts': "import { value } from './a.ts';\nexport const forwarded = value;\n",
    },
    id: 'downstream-const-reexporting-cyclic-barrel-pin',
    name: 'forwarded',
  },
  {
    expected: undefined,
    files: {
      'a.ts': "export * from './b.ts';\nexport * from './c.ts';\n",
      'b.ts': "export { other as value } from './d.ts';\n",
      'c.ts': 'export const value = 42;\n',
      'd.ts': "export { other } from './d.ts';\n",
    },
    id: 'closed-external-cycle-still-conflicts-star-pin',
  },
];

describe('bounded export lookups in cyclic barrel graphs', () => {
  let api: API;
  let tempDir: string;

  beforeAll(() => {
    api = openTypeScript();
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'rs-cyclic-barrel-bounds-'));
  });

  afterAll(() => {
    rmSync(tempDir, { force: true, recursive: true });
    api[Symbol.dispose]();
  });

  /** Resolves `entry` while asserting module parse lookups stay linear in the file count. */
  function resolveBounded(entry: Case): {
    readonly maxParses: number;
    readonly parses: number;
    readonly resolved: Resolved | undefined;
  } {
    const dir = path.join(tempDir, entry.id);
    mkdirSync(dir, { recursive: true });
    const fileEntries = Object.entries(entry.files);
    for (const [name, content] of fileEntries) {
      writeFileSync(path.join(dir, name), content, 'utf8');
    }
    using modules = new Modules(api, dir);
    const parseSpy = vi.spyOn(modules, 'parse');
    const found = exportedMember(
      modules,
      path.join(dir, entry.entry ?? 'a.ts'),
      entry.name ?? 'value',
      entry.keys ?? [],
    );
    const parses = parseSpy.mock.calls.length;
    const maxParses = fileEntries.length + (entry.keys?.length ?? 0);
    if (found === undefined) {
      return { maxParses, parses, resolved: undefined };
    }
    const sourceFile = found.getSourceFile();
    return {
      maxParses,
      parses,
      resolved: {
        file: path.basename(sourceFile.fileName),
        global: isIdentifier(found) ? globalOf(found) : undefined,
        text: found.getText(sourceFile),
      },
    };
  }

  it.each(CASES)('$id', (entry) => {
    const { maxParses, parses, resolved } = resolveBounded(entry);
    expect(resolved).toStrictEqual(entry.expected);
    expect(parses).toBeLessThanOrEqual(maxParses);
  });
});
