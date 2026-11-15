import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  isExportDeclaration,
  isVariableStatement,
  type SourceFile,
  type Statement,
} from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { exportOf } from '../src/compiler/module-exports.ts';
import { Modules, type ParsedModule } from '../src/compiler/modules.ts';
import { operationExports } from '../src/compiler/operations.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Binding patterns in exported variable statements contribute every bound identifier. */
const DESTRUCTURED_OPERATIONS = [
  {
    id: 'object-destructured-operation-exports',
    source: ["'use server';", 'export const { GET, POST } = handlers;'].join('\n'),
    expected: ['GET', 'POST'],
  },
  {
    id: 'renamed-and-quoted-object-destructured-exports',
    source: [
      "'use server';",
      'export const { internal: PUBLIC, "quoted-key": QUOTED } = handlers;',
    ].join('\n'),
    expected: ['PUBLIC', 'QUOTED'],
  },
  {
    id: 'array-destructured-holes-and-rest-exports',
    source: ["'use server';", 'export const [, second, ...rest] = handlers;'].join('\n'),
    expected: ['second', 'rest'],
  },
  {
    id: 'nested-object-array-and-default-destructured-exports',
    source: [
      "'use server';",
      'export const { group: { first, list: [second = fallback] } } = handlers;',
    ].join('\n'),
    expected: ['first', 'second'],
  },
  {
    id: 'mixed-identifier-and-pattern-declarators',
    source: ["'use server';", 'export const plain = direct, { one } = pair, [two] = list;'].join(
      '\n',
    ),
    expected: ['plain', 'one', 'two'],
  },
  {
    id: 'unexported-and-ambient-destructured-excluded',
    source: [
      "'use server';",
      'const { hidden } = handlers;',
      'export declare const { erased }: { erased: () => Promise<void> };',
      'export const visible = direct;',
    ].join('\n'),
    expected: ['visible'],
  },
] as const;

const REFUSED_DESTRUCTURED_DUPLICATES = [
  {
    id: 'duplicate-destructured-and-function-operation',
    source: [
      "'use server';",
      'export const { save } = handlers;',
      'export async function save(): Promise<void> {}',
    ].join('\n'),
    reason: '`save` is exported twice.',
  },
  {
    id: 'duplicate-across-two-destructured-declarators',
    source: ["'use server';", 'export const { save } = first, { other: save } = second;'].join(
      '\n',
    ),
    reason: '`save` is exported twice.',
  },
] as const;

const DESTRUCTURED_MODULE_EXPORTS: readonly {
  readonly expected: readonly StatementTag[];
  readonly files: Readonly<Record<string, string>>;
  readonly id: string;
  readonly names: readonly string[];
}[] = [
  {
    id: 'module-export-finds-object-destructured-names',
    files: { 'entry.ts': 'export const { GET, POST } = handlers;' },
    names: ['GET', 'POST', 'DELETE'],
    expected: ['variable', 'variable', 'none'],
  },
  {
    id: 'module-export-respects-renamed-object-pattern',
    files: { 'entry.ts': 'export const { internal: PUBLIC } = handlers;' },
    names: ['PUBLIC', 'internal'],
    expected: ['variable', 'none'],
  },
  {
    id: 'module-export-finds-nested-and-array-patterns',
    files: {
      'entry.ts': 'export const { group: { first, list: [, second, ...rest] } } = handlers;',
    },
    names: ['first', 'second', 'rest', 'group'],
    expected: ['variable', 'variable', 'variable', 'none'],
  },
  {
    id: 'module-export-follows-star-reexport-to-destructured-declaration',
    files: {
      'entry.ts': "export * from './handlers';",
      'handlers.ts': 'export const { generateStaticParams } = factory();',
    },
    names: ['generateStaticParams', 'missing'],
    expected: ['export', 'none'],
  },
  {
    id: 'module-export-ignores-unexported-and-ambient-patterns',
    files: {
      'entry.ts': [
        'const { localOnly } = handlers;',
        'export declare const { erased }: { erased: () => void };',
        'export const kept = direct;',
      ].join('\n'),
    },
    names: ['kept', 'localOnly', 'erased'],
    expected: ['variable', 'none', 'none'],
  },
];

type StatementTag = 'export' | 'none' | 'other' | 'variable';

function namedModule(sourceFile: SourceFile, name: string): ParsedModule {
  return { file: name, name, sourceFile, text: sourceFile.text };
}

function statementTag(statement: Statement | undefined): StatementTag {
  if (statement === undefined) {
    return 'none';
  }
  if (isVariableStatement(statement)) {
    return 'variable';
  }
  return isExportDeclaration(statement) ? 'export' : 'other';
}

async function lookupTags(
  api: API,
  files: Readonly<Record<string, string>>,
  names: readonly string[],
): Promise<readonly StatementTag[]> {
  const directory = await mkdtemp(path.join(tmpdir(), 'rs-destructured-exports-'));
  try {
    for (const [relative, content] of Object.entries(files)) {
      await writeFile(path.join(directory, relative), `${content}\n`);
    }
    const entry = path.join(directory, 'entry.ts');
    using modules = new Modules(api, directory);
    return names.map((name) => statementTag(exportOf(entry, name, modules)));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

describe('destructured exports in operations and module exports', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(DESTRUCTURED_OPERATIONS)('lists $id', ({ expected, source }) => {
    using parsed = parseModule(api, 'actions/destructured.ts', source);
    const module = namedModule(parsed.sourceFile, 'actions/destructured.ts');

    expect(operationExports(module)).toStrictEqual(expected);
  });

  it.each(REFUSED_DESTRUCTURED_DUPLICATES)('refuses $id', ({ reason, source }) => {
    using parsed = parseModule(api, 'actions/destructured.ts', source);
    const module = namedModule(parsed.sourceFile, 'actions/destructured.ts');

    expect(() => operationExports(module)).toThrow(reason);
  });

  it.each(DESTRUCTURED_MODULE_EXPORTS)('resolves $id', async ({ expected, files, names }) => {
    await expect(lookupTags(api, files, names)).resolves.toStrictEqual(expected);
  });
});
