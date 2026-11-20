import { isTypeAliasDeclaration } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { nonJsonPart } from '../src/compiler/json-types.ts';
import { Modules } from '../src/compiler/modules.ts';
import { typeReading } from '../src/compiler/type-names.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * An index signature whose key may be a symbol holds entries JSON leaves out, and its type is
 * refused: `{ [key: symbol]: string }`. TypeScript takes an alias of `symbol` as a key
 * (`type Key = symbol; { [key: Key]: string }`) as well as parentheses (`[key: (symbol)]`), and the
 * walk read only the keyword and a union written in place. A key is read as one that may be a
 * symbol unless it is `string`, `number`, a template literal type, or a union of those: what the
 * code does not write as one of them is not followed to what it names.
 */

const api = openTypeScript();

/** The message of an entry a symbol may name, as `nonJsonPart` words it. */
const SYMBOL_KEY = 'an entry of a name that may be a symbol, which JSON holds none of';

/** What `nonJsonPart` answers of the alias `State` that `source` declares. */
function walkOfState(source: string): {
  readonly admits: string | undefined;
  readonly part: string | undefined;
} {
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

interface Case {
  readonly id: string;
  readonly source: string;
  /** The index refused as one a symbol may name, as the code writes it; none where it is read. */
  readonly refused: string | undefined;
}

const CASES: readonly Case[] = [
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
    id: 'key-of-a-union-with-an-alias',
    source: 'type Key = symbol; type State = { id: string; [key: Key | string]: string };',
    refused: '[key: Key | string]: string',
  },
  {
    id: 'key-of-an-alias-of-text-is-not-followed',
    source: 'type Key = string; type State = { id: string; [key: Key]: string };',
    refused: '[key: Key]: string',
  },
  {
    id: 'key-of-text-in-parentheses-is-not-followed',
    source: 'type State = { id: string; [key: (string)]: string };',
    refused: '[key: (string)]: string',
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
  },
];

describe('the key of an index signature that a symbol may be', () => {
  it.each(CASES)('$id', ({ refused, source }) => {
    const walk = walkOfState(source);

    expect({ symbolKey: walk.admits === SYMBOL_KEY ? walk.part : undefined }).toStrictEqual({
      symbolKey: refused,
    });
  });
});
