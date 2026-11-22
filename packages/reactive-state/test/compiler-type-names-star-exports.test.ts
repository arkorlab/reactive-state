import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { isTypeAliasDeclaration } from 'typescript/ast';
import { afterEach, describe, expect, it } from 'vitest';

import { nonJsonPart } from '../src/compiler/json-types.ts';
import { Modules } from '../src/compiler/modules.ts';
import { typeReading } from '../src/compiler/type-names.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * What a barrel exports as a name. A name the file exports itself hides the one `export *`
 * re-exports, whatever it exports it as: a class, a re-export of a package's type. The reader
 * looked past an export it could not read to the star's, so `export * from './safe'` beside
 * `export class State {…}` was read as the interface `./safe` declares. An export of the name that
 * the reader cannot read stops the search now: the type is one the compile cannot read.
 */

const api = openTypeScript();

const dirs: string[] = [];

/** The message of a type the compile cannot read, as `nonJsonPart` words it. */
const UNREAD = 'a type the compile cannot read';

/** What `nonJsonPart` answers of `State` imported from `barrel.ts` of an application of `files`. */
function walkOfImport(files: Readonly<Record<string, string>>): {
  readonly admits: string | undefined;
  readonly part: string | undefined;
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'reactive-state-star-exports-'));
  dirs.push(dir);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  const probe = path.join(dir, 'probe.ts');
  using parsed = parseModule(
    api,
    probe,
    "import type { State as Imported } from './barrel'; type State = Imported;",
  );
  using modules = new Modules(api, dir);
  const { sourceFile } = parsed;
  const state = sourceFile.statements.find(
    (statement) => isTypeAliasDeclaration(statement) && statement.name.text === 'State',
  );
  if (state === undefined || !isTypeAliasDeclaration(state)) {
    throw new Error('no State');
  }
  const found = nonJsonPart(state.type, { file: probe, sourceFile }, typeReading(modules));
  return { admits: found?.admits, part: found?.part };
}

interface Case {
  readonly id: string;
  readonly files: Readonly<Record<string, string>>;
  /** The part found, as the code writes it; none where the type is JSON all through. */
  readonly part: string | undefined;
  /** Whether it is refused as a type the compile cannot read. */
  readonly unread?: boolean;
}

const SAFE = 'export interface State { id: string }';
const FUNCTION_STATE = 'export interface State { id: string; run: () => void }';

const CASES: readonly Case[] = [
  {
    id: 'a-class-of-the-name-beside-a-star-export',
    files: {
      'barrel.ts': "export * from './safe'; export class State { id = ''; callback = () => {}; }",
      'safe.ts': SAFE,
    },
    part: 'Imported',
    unread: true,
  },
  {
    id: 'a-class-of-the-name-before-the-star-export',
    files: {
      'barrel.ts': "export class State { id = ''; } export * from './safe';",
      'safe.ts': SAFE,
    },
    part: 'Imported',
    unread: true,
  },
  {
    id: 'a-package-type-of-the-name-re-exported-beside-a-star-export',
    files: {
      'barrel.ts': "export * from './safe'; export type { State } from 'zod';",
      'safe.ts': SAFE,
    },
    part: 'Imported',
    unread: true,
  },
  {
    id: 'a-package-type-of-the-name-listed-beside-a-star-export',
    files: {
      'barrel.ts':
        "import type { Other as State } from 'zod'; export * from './safe'; export type { State };",
      'safe.ts': SAFE,
    },
    part: 'Imported',
    unread: true,
  },
  {
    id: 'a-class-of-the-name-through-a-barrel-of-a-barrel',
    files: {
      'barrel.ts': "export * from './middle';",
      'middle.ts': "export * from './safe'; export class State { id = ''; }",
      'safe.ts': SAFE,
    },
    part: 'Imported',
    unread: true,
  },
  {
    id: 'a-star-export-alone',
    files: { 'barrel.ts': "export * from './safe';", 'safe.ts': SAFE },
    part: undefined,
  },
  {
    id: 'a-star-export-beside-a-class-of-another-name',
    files: {
      'barrel.ts': "export * from './safe'; export class Other { callback = () => {}; }",
      'safe.ts': SAFE,
    },
    part: undefined,
  },
  {
    id: 'a-star-export-beside-a-constant-of-another-name',
    files: { 'barrel.ts': "export * from './safe'; export const other = 1;", 'safe.ts': SAFE },
    part: undefined,
  },
  {
    id: 'an-interface-of-the-name-beside-a-star-export-is-read',
    files: {
      'barrel.ts': `export * from './safe'; ${FUNCTION_STATE}`,
      'safe.ts': SAFE,
    },
    part: '() => void',
  },
  {
    id: 'an-alias-of-the-name-beside-a-star-export-is-read',
    files: {
      'barrel.ts': "export * from './safe'; export type State = { id: string; names: string[] };",
      'safe.ts': FUNCTION_STATE,
    },
    part: undefined,
  },
  {
    id: 'a-re-export-of-the-name-from-another-file-beside-a-star-export-is-read',
    files: {
      'barrel.ts': "export * from './safe'; export { State } from './other';",
      'safe.ts': SAFE,
      'other.ts': FUNCTION_STATE,
    },
    part: '() => void',
  },
  {
    id: 'a-constant-and-an-alias-of-the-name-beside-a-star-export',
    files: {
      'barrel.ts':
        "export * from './safe'; export const State = { id: '' } as const; export type State = { id: string };",
      'safe.ts': FUNCTION_STATE,
    },
    part: undefined,
  },
  {
    id: 'two-star-exports-of-one-declaration',
    files: {
      'barrel.ts': "export * from './a'; export * from './b';",
      'a.ts': "export * from './safe';",
      'b.ts': "export * from './safe';",
      'safe.ts': SAFE,
    },
    part: undefined,
  },
];

describe('what a barrel exports as a name its own export hides the star for', () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it.each(CASES)('$id', ({ files, part, unread = false }) => {
    const walk = walkOfImport(files);

    expect({ part: walk.part, unread: walk.admits === UNREAD }).toStrictEqual({ part, unread });
  });
});
