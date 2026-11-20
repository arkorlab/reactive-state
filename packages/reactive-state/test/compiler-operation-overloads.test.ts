import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  isFunctionDeclaration,
  isVariableStatement,
  type SourceFile,
  type Statement,
} from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ReactiveCompileError } from '../src/compiler/errors.ts';
import { exportOf } from '../src/compiler/module-exports.ts';
import { Modules, type ParsedModule } from '../src/compiler/modules.ts';
import { operationExports } from '../src/compiler/operations.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Bodyless overload and ambient `declare` signatures do not count as separate runtime exports. */
const ACCEPTED_OPERATIONS = [
  {
    id: 'single-overload-before-async-implementation',
    source: [
      "'use server';",
      'export function save(value: string): Promise<void>;',
      'export async function save(value: string): Promise<void> {',
      '  void value;',
      '}',
    ].join('\n'),
    expected: ['save'],
  },
  {
    id: 'multiple-overloads-and-sibling-operations',
    source: [
      "'use server';",
      'export function choose(value: string): Promise<string>;',
      'export function choose(value: number): Promise<number>;',
      'export async function choose(value: string | number): Promise<string | number> {',
      '  return value;',
      '}',
      'export async function remove(id: string): Promise<void> {',
      '  void id;',
      '}',
    ].join('\n'),
    expected: ['choose', 'remove'],
  },
  {
    id: 'overloaded-default-operation',
    source: [
      "'use server';",
      'export default function save(value: string): Promise<void>;',
      'export default async function save(value?: string): Promise<void> {',
      '  void value;',
      '}',
    ].join('\n'),
    expected: ['default'],
  },
  {
    id: 'anonymous-overloaded-default-operation',
    source: [
      "'use server';",
      'export default function (value: string): Promise<void>;',
      'export default async function (value?: string): Promise<void> {',
      '  void value;',
      '}',
    ].join('\n'),
    expected: ['default'],
  },
  {
    id: 'ambient-declare-function-and-variable-exports',
    source: [
      "'use server';",
      'export declare function erased(value: string): Promise<void>;',
      'export declare const phantom: (value: string) => Promise<void>;',
      'export async function live(value: string): Promise<void> {',
      '  void value;',
      '}',
    ].join('\n'),
    expected: ['live'],
  },
  {
    id: 'local-overloads-exported-by-list',
    source: [
      "'use server';",
      'function save(value: string): Promise<void>;',
      'async function save(value: string): Promise<void> {',
      '  void value;',
      '}',
      'export { save };',
    ].join('\n'),
    expected: ['save'],
  },
  {
    id: 'unexported-overload-before-exported-implementation',
    source: [
      "'use server';",
      'function save(value: string): Promise<void>;',
      'export async function save(value: string): Promise<void> {',
      '  void value;',
      '}',
    ].join('\n'),
    expected: ['save'],
  },
] as const;

const REFUSED_OPERATIONS = [
  {
    id: 'overloaded-operation-also-reexported-by-list',
    source: [
      "'use server';",
      'export function save(value: string): Promise<void>;',
      'export async function save(value: string): Promise<void> {',
      '  void value;',
      '}',
      'export { save };',
    ].join('\n'),
    line: 6,
    reason: '`save` is exported twice.',
  },
  {
    id: 'duplicate-implemented-functions',
    source: [
      "'use server';",
      'export async function save(): Promise<void> {}',
      'export async function save(): Promise<void> {}',
    ].join('\n'),
    line: 3,
    reason: '`save` is exported twice.',
  },
] as const;

const MODULE_EXPORT_CASES = [
  {
    id: 'module-export-resolves-overload-implementation',
    source: [
      'export function generateStaticParams(limit: number): Promise<never[]>;',
      'export async function generateStaticParams(): Promise<never[]> {',
      '  return [];',
      '}',
    ].join('\n'),
    name: 'generateStaticParams',
    expected: 'implemented-function',
  },
  {
    id: 'module-export-skips-ambient-declare-exports',
    source: [
      'export declare function generateStaticParams(): Promise<never[]>;',
      'export declare const other: () => Promise<never[]>;',
    ].join('\n'),
    name: 'generateStaticParams',
    expected: 'none',
  },
  {
    id: 'module-export-skips-ambient-declare-variable',
    source: 'export declare const generateStaticParams: () => Promise<never[]>;',
    name: 'generateStaticParams',
    expected: 'none',
  },
  {
    id: 'module-export-plain-implemented-and-default-excluded',
    source: [
      'export default function ignored(): null {',
      '  return null;',
      '}',
      'export async function generateStaticParams(): Promise<never[]> {',
      '  return [];',
      '}',
    ].join('\n'),
    name: 'generateStaticParams',
    expected: 'implemented-function',
  },
] as const;

type ExportedKind = 'bodyless-function' | 'implemented-function' | 'none' | 'other' | 'variable';

/** The file every row of this suite is parsed as. */
const MODULE = 'actions/overloads.ts';

function namedModule(sourceFile: SourceFile): ParsedModule {
  return { file: MODULE, name: MODULE, sourceFile, text: sourceFile.text };
}

function refusalLine(api: API, source: string): { readonly line: number; readonly reason: string } {
  using parsed = parseModule(api, MODULE, source);
  const module = namedModule(parsed.sourceFile);
  try {
    operationExports(module);
  } catch (error) {
    if (error instanceof ReactiveCompileError) {
      return { line: error.line, reason: error.reason };
    }
    throw error;
  }
  return { line: -1, reason: '' };
}

function statementKind(statement: Statement | undefined): ExportedKind {
  if (statement === undefined) {
    return 'none';
  }
  if (isFunctionDeclaration(statement)) {
    return statement.body === undefined ? 'bodyless-function' : 'implemented-function';
  }
  return isVariableStatement(statement) ? 'variable' : 'other';
}

async function lookupExportKind(api: API, source: string, name: string): Promise<ExportedKind> {
  const directory = await mkdtemp(path.join(tmpdir(), 'rs-operation-overloads-'));
  try {
    const entry = path.join(directory, 'page.ts');
    await writeFile(entry, `${source}\n`);
    using modules = new Modules(api, directory);
    return statementKind(exportOf(entry, name, modules));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

describe('overloaded and ambient exports in operations and module exports', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(ACCEPTED_OPERATIONS)('lists $id', ({ expected, source }) => {
    using parsed = parseModule(api, MODULE, source);
    const module = namedModule(parsed.sourceFile);

    expect(operationExports(module)).toStrictEqual(expected);
  });

  it.each(REFUSED_OPERATIONS)('refuses $id', ({ line, reason, source }) => {
    const refusal = refusalLine(api, source);

    expect(refusal.reason).toBe(reason);
    expect(refusal.line).toBe(line);
  });

  it.each(MODULE_EXPORT_CASES)('resolves $id', async ({ expected, name, source }) => {
    await expect(lookupExportKind(api, source, name)).resolves.toBe(expected);
  });
});
