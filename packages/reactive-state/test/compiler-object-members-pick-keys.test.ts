import { isTypeAliasDeclaration } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { nonJsonPart } from '../src/compiler/json-types.ts';
import { Modules } from '../src/compiler/modules.ts';
import { typeReading } from '../src/compiler/type-names.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * The members `Pick<T, K>` makes are those `K` names. A key that names no member of `T` — which
 * TypeScript allows where `T` has an index signature, `Pick<{ id: string; [key: string]: V }, 'id' |
 * 'run'>` — is a member whose type the index supplies, and the mapping dropped it, so a value
 * type no JSON holds went unseen. A `Pick` one of whose keys names no member is a type the compile
 * cannot read now; `Omit`, which keeps the index, and a `Pick` of keys that all name a member are
 * read as before.
 */

const api = openTypeScript();

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

const UNREAD = 'a type the compile cannot read';

interface Case {
  readonly id: string;
  readonly source: string;
  /** The part found, as the code writes it; none where the type is JSON all through. */
  readonly part: string | undefined;
  /** Whether it is refused as a type the compile cannot read. */
  readonly unread?: boolean;
}

const FN = 'type Fn = () => void;';
const DICTIONARY = '{ id: string; [k: string]: string | Fn }';

const CASES: readonly Case[] = [
  {
    id: 'pick-of-a-dictionary-with-a-key-the-index-supplies',
    source: `${FN} type State = Pick<${DICTIONARY}, 'id' | 'run'>;`,
    part: `Pick<${DICTIONARY}, 'id' | 'run'>`,
    unread: true,
  },
  {
    id: 'pick-of-an-interface-of-a-dictionary-with-a-key-the-index-supplies',
    source: `${FN} interface Dictionary ${DICTIONARY} type State = Pick<Dictionary, 'id' | 'run'>;`,
    part: "Pick<Dictionary, 'id' | 'run'>",
    unread: true,
  },
  {
    id: 'pick-of-a-dictionary-of-JSON-with-a-key-the-index-supplies',
    source: "type State = Pick<{ id: string; [key: string]: string }, 'id' | 'name'>;",
    part: "Pick<{ id: string; [key: string]: string }, 'id' | 'name'>",
    unread: true,
  },
  {
    id: 'pick-of-a-key-only-the-index-supplies',
    source: `${FN} type State = Pick<${DICTIONARY}, 'run'>;`,
    part: `Pick<${DICTIONARY}, 'run'>`,
    unread: true,
  },
  {
    id: 'pick-of-a-record-of-text-with-a-key',
    source: `${FN} type State = Pick<Record<string, Fn>, 'run'>;`,
    part: "Pick<Record<string, Fn>, 'run'>",
    unread: true,
  },
  {
    id: 'pick-of-a-dictionary-by-the-key-it-names',
    source: `${FN} type State = Pick<${DICTIONARY}, 'id'>;`,
    part: undefined,
  },
  {
    id: 'omit-of-a-dictionary-keeps-the-index',
    source: `${FN} type State = Omit<${DICTIONARY}, 'id'>;`,
    part: '() => void',
  },
  {
    id: 'pick-of-members-that-are-all-named',
    source: "type State = Pick<{ id: string; name: string; run: () => void }, 'id' | 'name'>;",
    part: undefined,
  },
  {
    id: 'pick-of-a-function-member-that-is-named',
    source: "type State = Pick<{ id: string; run: () => void }, 'id' | 'run'>;",
    part: '() => void',
  },
  {
    id: 'pick-of-a-method-that-is-left-out',
    source: "type State = Pick<{ id: string; run(): void }, 'id'>;",
    part: undefined,
  },
  {
    id: 'pick-of-an-interface-with-what-it-extends',
    source:
      "interface Base { id: string } interface Named extends Base { name: string } type State = Pick<Named, 'id' | 'name'>;",
    part: undefined,
  },
  {
    id: 'pick-of-a-partial',
    source: "type State = Pick<Partial<{ id: string; name: string }>, 'id'>;",
    part: undefined,
  },
  {
    id: 'pick-of-the-keys-a-record-names',
    source: "type State = Pick<Record<'a' | 'b', string>, 'a'>;",
    part: undefined,
  },
  {
    id: 'pick-of-keys-an-alias-names',
    source:
      "type Keys = 'id' | 'name'; type State = Pick<{ id: string; name: string; secret: () => void }, Keys>;",
    part: undefined,
  },
];

describe('the members Pick keeps of a type with an index signature', () => {
  it.each(CASES)('$id', ({ part, source, unread = false }) => {
    const walk = walkOfState(source);

    expect({ part: walk.part, unread: walk.admits === UNREAD }).toStrictEqual({ part, unread });
  });
});
