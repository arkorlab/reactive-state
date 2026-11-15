import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { SourceFile } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { exportOf } from '../src/compiler/module-exports.ts';
import { Modules, type ParsedModule } from '../src/compiler/modules.ts';
import { operationExports } from '../src/compiler/operations.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** String-literal export specifiers expose their unquoted `.text`, matching identifier exports. */
const ACCEPTED_EXPORTS = [
  {
    id: 'double-quoted-export-alias',
    source: [
      "'use server';",
      'const save = async (): Promise<void> => {};',
      'export { save as "my-op" };',
    ].join('\n'),
    expected: ['my-op'],
  },
  {
    id: 'single-quoted-and-escaped-export-aliases',
    source: [
      "'use server';",
      'const first = async (): Promise<void> => {};',
      'const second = async (): Promise<void> => {};',
      String.raw`export { first as 'single-op', second as "line\nop" };`,
    ].join('\n'),
    expected: ['single-op', 'line\nop'],
  },
  {
    id: 'string-reexport-without-alias',
    source: ["'use server';", "export { 'my-op' } from './more';"].join('\n'),
    expected: ['my-op'],
  },
  {
    id: 'string-reexport-to-string-alias',
    source: ["'use server';", 'export { "my-op" as "their-op" } from "./more";'].join('\n'),
    expected: ['their-op'],
  },
  {
    id: 'quoted-default-export-alias',
    source: [
      "'use server';",
      'const main = async (): Promise<void> => {};',
      'export { main as "default" };',
    ].join('\n'),
    expected: ['default'],
  },
  {
    id: 'string-reexport-to-identifier-and-type-only-excluded',
    source: [
      "'use server';",
      'export { "my-op" as renamed, type "only-type" as ignored } from "./more";',
    ].join('\n'),
    expected: ['renamed'],
  },
] as const;

const REFUSED_DUPLICATES = [
  {
    id: 'duplicate-identifier-and-quoted-name',
    source: [
      "'use server';",
      'export async function save(): Promise<void> {}',
      'const other = async (): Promise<void> => {};',
      'export { other as "save" };',
    ].join('\n'),
    reason: '`save` is exported twice.',
  },
  {
    id: 'duplicate-default-and-quoted-default',
    source: [
      "'use server';",
      'export default async function main(): Promise<void> {}',
      'const other = async (): Promise<void> => {};',
      'export { other as "default" };',
    ].join('\n'),
    reason: '`default` is exported twice.',
  },
  {
    id: 'duplicate-double-and-single-quoted-names',
    source: [
      "'use server';",
      'const first = async (): Promise<void> => {};',
      'const second = async (): Promise<void> => {};',
      'export { first as "my-op" };',
      "export { second as 'my-op' };",
    ].join('\n'),
    reason: '`my-op` is exported twice.',
  },
] as const;

const MODULE_EXPORT_PINS = [
  {
    id: 'module-export-matches-unquoted-string-alias',
    source: 'const build = async () => []; export { build as "my-op" };',
    present: 'my-op',
    absent: '"my-op"',
  },
  {
    id: 'module-export-matches-string-reexport-target',
    source: 'export { "my-op" as other } from "./more";',
    present: 'other',
    absent: 'my-op',
  },
] as const;

function namedModule(sourceFile: SourceFile, name: string): ParsedModule {
  return { file: name, name, sourceFile, text: sourceFile.text };
}

async function presencePair(
  api: API,
  source: string,
  present: string,
  absent: string,
): Promise<readonly [boolean, boolean]> {
  const directory = await mkdtemp(path.join(tmpdir(), 'rs-string-exports-'));
  try {
    const entry = path.join(directory, 'entry.ts');
    await writeFile(entry, `${source}\n`);
    using modules = new Modules(api, directory);
    return [
      exportOf(entry, present, modules) !== undefined,
      exportOf(entry, absent, modules) !== undefined,
    ];
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

describe('string-literal export names in operations and module exports', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(ACCEPTED_EXPORTS)('lists $id', ({ expected, source }) => {
    using parsed = parseModule(api, 'actions/string-exports.ts', source);
    const module = namedModule(parsed.sourceFile, 'actions/string-exports.ts');

    expect(operationExports(module)).toStrictEqual(expected);
  });

  it.each(REFUSED_DUPLICATES)('refuses $id', ({ reason, source }) => {
    using parsed = parseModule(api, 'actions/string-exports.ts', source);
    const module = namedModule(parsed.sourceFile, 'actions/string-exports.ts');

    expect(() => operationExports(module)).toThrow(reason);
  });

  it.each(MODULE_EXPORT_PINS)('resolves $id', async ({ absent, present, source }) => {
    await expect(presencePair(api, source, present, absent)).resolves.toStrictEqual([true, false]);
  });
});
