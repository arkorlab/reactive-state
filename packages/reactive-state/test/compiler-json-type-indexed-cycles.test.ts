import { isTypeAliasDeclaration } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { nonJsonPart } from '../src/compiler/json-types.ts';
import { Modules } from '../src/compiler/modules.ts';
import { typeReading } from '../src/compiler/type-names.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A member of a type read through its index, `S['x']`, where the type that holds it names the index
 * again: TypeScript accepts it where an object type stands between the two — `{ x: { y: S['x'] } }`,
 * a linked node written through the index of itself — and the walk read it for ever, until the
 * stack gave out. An indexed access the walk is reading is not read again, as a type of itself is
 * not: a type of itself admits nothing it has not already. TypeScript refuses a definition without
 * the object type between (TS2502), and the walk no longer overflows on that either.
 */

const api = openTypeScript();

/** What `nonJsonPart` answers of the alias `State` that `source` declares: the part, as written. */
function partOfState(source: string): {
  readonly part: string | undefined;
  readonly admits: string | undefined;
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
  /** The part found, as the code writes it; none where the type is JSON all through. */
  readonly part: string | undefined;
}

const CASES: readonly Case[] = [
  {
    id: 'wrapped-in-an-object-type-of-an-interface',
    source: "interface S { x: { y: S['x'] } } type State = S;",
    part: undefined,
  },
  {
    id: 'wrapped-linked-node-of-an-alias',
    source: "type State = { node: { value: string; next: State['node'] | null } };",
    part: undefined,
  },
  {
    id: 'wrapped-in-a-list-of-an-interface',
    source: "interface S { children: { next: S['children'] | null }[] } type State = S;",
    part: undefined,
  },
  {
    id: 'wrapped-and-named-as-an-entry-and-as-an-element',
    source: "type State = { a: { b: State['a']; c: State['a'][] } };",
    part: undefined,
  },
  {
    id: 'wrapped-with-a-function-beside-the-self-reference',
    source: "type State = { node: { run: () => void; next: State['node'] | null } };",
    part: '() => void',
  },
  {
    id: 'two-interfaces-that-read-each-other-through-an-object-type',
    source:
      "interface A { x: { y: B['x'] } } interface B { x: { y: A['x'] } } type State = { a: A; b: B };",
    part: undefined,
  },
  {
    id: 'a-member-that-names-its-own-index-directly',
    source: "interface S { x: S['x'] } type State = S;",
    part: undefined,
  },
  {
    id: 'an-alias-that-names-its-own-index-directly',
    source: "type State = { x: State['x'] };",
    part: undefined,
  },
  {
    id: 'two-aliases-that-name-each-others-index-directly',
    source: "type State = { x: B['y'] }; type B = { y: State['x'] };",
    part: undefined,
  },
  {
    id: 'a-member-read-through-its-index-twice',
    source: "interface S { id: string; again: S['id'] } type State = S;",
    part: undefined,
  },
  {
    id: 'a-chain-of-members-read-through-their-indexes',
    source: "interface S { a: S['b']; b: S['c']; c: string } type State = S;",
    part: undefined,
  },
  {
    id: 'a-member-read-through-its-index-as-an-element',
    source: "interface S { a: S['b'][]; b: S | null } type State = S;",
    part: undefined,
  },
  {
    id: 'a-function-read-through-its-index',
    source: "type State = { run: () => void; again: State['run'] };",
    part: '() => void',
  },
  {
    id: 'a-member-that-may-be-left-out-read-as-an-element',
    source: "type State = { opt?: string; list: State['opt'][] };",
    part: "State['opt']",
  },
];

describe('an indexed access that names the type it is written in', () => {
  it.each(CASES)('$id', ({ part, source }) => {
    expect(partOfState(source).part).toBe(part);
  });
});
