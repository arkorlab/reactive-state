import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { isFunctionDeclaration, isTypeAliasDeclaration } from 'typescript/ast';
import { afterEach, describe, expect, it } from 'vitest';

import { nonJsonPart } from '../src/compiler/json-types.ts';
import { Modules } from '../src/compiler/modules.ts';
import { typeReading } from '../src/compiler/type-names.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * An index signature whose key may be a symbol holds entries JSON leaves out, and its type is
 * refused: `{ [key: symbol]: string }`. TypeScript takes an alias of `symbol` as a key
 * (`type Key = symbol; { [key: Key]: string }`) as well as parentheses (`[key: (symbol)]`), and the
 * walk read only the keyword and a union written in place. A key is read through parentheses, a
 * union and a name the module reads as an alias without type parameters — of the file or of an
 * import — down to `string`, `number` or a template literal type, which are no symbol, and
 * `symbol`, which is one; a key it cannot read to one of those — a type parameter, a package's type,
 * an interface, a generic alias, any other type — may be a symbol and is refused. An aliased text
 * key (`type UserId = string; { [id: UserId]: User }`) is ordinary, and stays taken.
 */

const api = openTypeScript();

const dirs: string[] = [];

/** The message of an entry a symbol may name, as `nonJsonPart` words it. */
const SYMBOL_KEY = 'an entry of a name that may be a symbol, which JSON holds none of';

interface Walk {
  readonly admits: string | undefined;
  readonly part: string | undefined;
}

/** What `nonJsonPart` answers of the alias `State` that `source` declares. */
function walkOfState(source: string): Walk {
  using parsed = parseModule(api, 'state.ts', source);
  using modules = new Modules(api, process.cwd());
  const { sourceFile } = parsed;
  const state = sourceFile.statements.find(
    (statement) => isTypeAliasDeclaration(statement) && statement.name.text === 'State',
  );
  if (state === undefined || !isTypeAliasDeclaration(state)) {
    throw new Error('no State');
  }
  const found = nonJsonPart(state.type, { file: 'state.ts', sourceFile }, typeReading(modules));
  return { admits: found?.admits, part: found?.part };
}

/** What `nonJsonPart` answers of `State` imported from `barrel.ts` of an application of `files`. */
function walkOfImport(files: Readonly<Record<string, string>>): Walk {
  const dir = mkdtempSync(path.join(tmpdir(), 'reactive-state-index-keys-'));
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

/** What `nonJsonPart` answers of the type of the first parameter of the function `use`, its type parameters given. */
function walkOfParameter(source: string): Walk {
  using parsed = parseModule(api, 'state.ts', source);
  using modules = new Modules(api, process.cwd());
  const { sourceFile } = parsed;
  const use = sourceFile.statements.find(
    (statement) => isFunctionDeclaration(statement) && statement.name?.text === 'use',
  );
  const type =
    use !== undefined && isFunctionDeclaration(use) ? use.parameters[0]?.type : undefined;
  if (type === undefined || use === undefined || !isFunctionDeclaration(use)) {
    throw new Error('no use');
  }
  const reading = typeReading(modules, {
    declarations: use.typeParameters ?? [],
    file: 'state.ts',
  });
  const found = nonJsonPart(type, { file: 'state.ts', sourceFile }, reading);
  return { admits: found?.admits, part: found?.part };
}

interface Case {
  readonly id: string;
  /** The index refused as one a symbol may name, as the code writes it; none where it is read. */
  readonly refused: string | undefined;
  /** The part found where no index is refused, as the code writes it; none where the type is JSON. */
  readonly part?: string;
}

interface Written extends Case {
  readonly source: string;
}

interface Imported extends Case {
  readonly files: Readonly<Record<string, string>>;
}

const WRITTEN: readonly Written[] = [
  {
    id: 'key-of-an-alias-of-symbol',
    source: 'type Key = symbol; type State = { id: string; [key: Key]: string };',
    refused: '[key: Key]: string',
  },
  {
    id: 'key-of-an-alias-of-symbol-in-an-interface',
    source:
      'type Key = symbol; interface Dictionary { id: string; [key: Key]: string } type State = Dictionary;',
    refused: '[key: Key]: string',
  },
  {
    id: 'key-of-symbol-in-parentheses',
    source: 'type State = { id: string; [key: (symbol)]: string };',
    refused: '[key: (symbol)]: string',
  },
  {
    id: 'key-of-an-alias-of-text-or-symbol',
    source: 'type Key = string | symbol; type State = { id: string; [key: Key]: string };',
    refused: '[key: Key]: string',
  },
  {
    id: 'key-of-a-union-with-an-alias-of-symbol',
    source: 'type Key = symbol; type State = { id: string; [key: Key | string]: string };',
    refused: '[key: Key | string]: string',
  },
  {
    id: 'key-of-an-alias-of-an-alias-of-symbol',
    source: 'type Base = symbol; type Key = Base; type State = { id: string; [key: Key]: string };',
    refused: '[key: Key]: string',
  },
  {
    id: 'key-of-an-alias-of-a-union-that-holds-an-alias-of-symbol',
    source:
      'type Mark = symbol; type Key = string | Mark; type State = { id: string; [key: Key]: string };',
    refused: '[key: Key]: string',
  },
  {
    id: 'key-of-a-generic-alias',
    source: 'type Same<T> = T; type State = { id: string; [key: Same<string>]: string };',
    refused: '[key: Same<string>]: string',
  },
  {
    id: 'key-of-an-interface',
    source: 'interface Key { id: string } type State = { id: string; [key: Key]: string };',
    refused: '[key: Key]: string',
  },
  {
    id: 'key-of-symbol',
    source: 'type State = { id: string; [key: symbol]: string };',
    refused: '[key: symbol]: string',
  },
  {
    id: 'key-of-text-or-symbol',
    source: 'type State = { id: string; [key: symbol | string]: string };',
    refused: '[key: symbol | string]: string',
  },
  {
    id: 'key-of-an-alias-of-text',
    source:
      'type UserId = string; interface User { title: string } type State = { id: string; [id: UserId]: User };',
    refused: undefined,
  },
  {
    // No member of a name of its own beside the index: its kind is the language's other values', as
    // for an index of `string` written through an alias, which `object-kinds.ts` reads as the keyword.
    id: 'key-of-an-alias-of-text-with-no-member-beside-it',
    source:
      'type UserId = string; interface User { title: string } type State = { [id: UserId]: User };',
    refused: undefined,
    part: '{ [id: UserId]: User }',
  },
  {
    id: 'key-of-an-alias-of-text-beside-a-member',
    source: 'type Key = string; type State = { id: string; [key: Key]: string };',
    refused: undefined,
  },
  {
    id: 'key-of-an-alias-of-an-alias-of-text',
    source: 'type Base = string; type Key = Base; type State = { id: string; [key: Key]: string };',
    refused: undefined,
  },
  {
    id: 'key-of-an-alias-of-a-number',
    source: 'type Slot = number; type State = { id: string; [key: Slot]: string };',
    refused: undefined,
  },
  {
    id: 'key-of-an-alias-of-text-or-a-number',
    source: 'type Key = string | number; type State = { id: string; [key: Key]: string };',
    refused: undefined,
  },
  {
    id: 'key-of-an-alias-of-a-template-literal-type',
    source: `type Key = \`data-\${string}\`; type State = { id: string; [key: Key]: string };`,
    refused: undefined,
  },
  {
    id: 'key-of-a-union-of-aliases-of-text-and-a-number',
    source:
      'type Name = string; type Slot = number; type State = { id: string; [key: Name | Slot]: string };',
    refused: undefined,
  },
  {
    id: 'key-of-text-in-parentheses',
    source: 'type State = { id: string; [key: (string)]: string };',
    refused: undefined,
  },
  {
    id: 'key-of-an-alias-of-text-in-parentheses',
    source: 'type Key = (string); type State = { id: string; [key: (Key)]: string };',
    refused: undefined,
  },
  {
    id: 'key-of-an-alias-that-names-itself',
    // TypeScript refuses the alias (TS2456); the walk reads it as it reads a type of itself.
    source: 'type Key = Key | string; type State = { id: string; [key: Key]: string };',
    refused: undefined,
  },
  {
    id: 'key-of-text',
    source: 'type State = { id: string; [key: string]: string };',
    refused: undefined,
  },
  {
    id: 'key-of-a-number',
    source: 'type State = { id: string; [key: number]: string };',
    refused: undefined,
  },
  {
    id: 'key-of-text-or-a-number',
    source: 'type State = { id: string; [key: string | number]: string };',
    refused: undefined,
  },
  {
    id: 'key-of-a-template-literal-type',
    source: `type State = { id: string; [key: \`data-\${string}\`]: string };`,
    refused: undefined,
  },
  {
    id: 'key-of-text-in-an-interface',
    source: 'interface Dictionary { id: string; [key: string]: string } type State = Dictionary;',
    refused: undefined,
  },
  {
    id: 'record-of-text',
    source: 'type State = Record<string, string>;',
    refused: undefined,
  },
  {
    id: 'a-function-as-the-value-of-a-text-key',
    source: 'type State = { id: string; [key: string]: string | (() => void) };',
    refused: undefined,
    part: '() => void',
  },
  {
    id: 'a-function-as-the-value-of-an-aliased-text-key',
    source: 'type Key = string; type State = { id: string; [key: Key]: string | (() => void) };',
    refused: undefined,
    part: '() => void',
  },
];

const IMPORTED: readonly Imported[] = [
  {
    id: 'key-of-an-imported-alias-of-text',
    files: {
      'barrel.ts':
        "import type { UserId } from './ids'; export type State = { id: string; [key: UserId]: string };",
      'ids.ts': 'export type UserId = string;',
    },
    refused: undefined,
  },
  {
    id: 'key-of-an-alias-of-an-imported-alias-of-text',
    files: {
      'barrel.ts':
        "import type { UserId } from './ids'; type Key = UserId; export type State = { id: string; [key: Key]: string };",
      'ids.ts': "export * from './base';",
      'base.ts': 'export type UserId = string | number;',
    },
    refused: undefined,
  },
  {
    id: 'key-of-an-imported-alias-of-symbol',
    files: {
      'barrel.ts':
        "import type { Mark } from './ids'; export type State = { id: string; [key: Mark]: string };",
      'ids.ts': 'export type Mark = symbol;',
    },
    refused: '[key: Mark]: string',
  },
  {
    id: 'key-of-an-imported-type-of-a-package',
    files: {
      'barrel.ts':
        "import type { Key } from 'a-package'; export type State = { id: string; [key: Key]: string };",
    },
    refused: '[key: Key]: string',
  },
  {
    id: 'key-of-an-import-that-names-no-alias',
    files: {
      'barrel.ts':
        "import type { Key } from './ids'; export type State = { id: string; [key: Key]: string };",
      'ids.ts': 'export interface Key { id: string }',
    },
    refused: '[key: Key]: string',
  },
];

const PARAMETERS: readonly (Case & { readonly source: string })[] = [
  {
    id: 'key-of-a-type-parameter',
    source:
      'declare function use<K extends string>(value: { id: string; [key: K]: string }): void;',
    refused: '[key: K]: string',
  },
  {
    id: 'key-of-text-where-a-type-parameter-is-given',
    source:
      'declare function use<K extends string>(value: { id: string; [key: string]: K }): void;',
    refused: undefined,
  },
];

/** The index the walk refused as one a symbol may name, or else the part it found. */
function answerOf({ admits, part }: Walk): {
  readonly part: string | undefined;
  readonly symbolKey: string | undefined;
} {
  return admits === SYMBOL_KEY
    ? { part: undefined, symbolKey: part }
    : { part, symbolKey: undefined };
}

describe('the key of an index signature that a symbol may be', () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it.each(WRITTEN)('$id', ({ part, refused, source }) => {
    expect(answerOf(walkOfState(source))).toStrictEqual({ part, symbolKey: refused });
  });

  it.each(IMPORTED)('$id', ({ files, part, refused }) => {
    expect(answerOf(walkOfImport(files))).toStrictEqual({ part, symbolKey: refused });
  });

  it.each(PARAMETERS)('$id', ({ part, refused, source }) => {
    expect(answerOf(walkOfParameter(source))).toStrictEqual({ part, symbolKey: refused });
  });
});
