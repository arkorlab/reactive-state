import {
  isIdentifier,
  isInterfaceDeclaration,
  isTypeAliasDeclaration,
  isTypeParameterDeclaration,
  isTypeReferenceNode,
  type Node,
  type SourceFile,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { localTypeBinding, type LocalTypeBinding } from '../src/compiler/local-type-aliases.ts';

/**
 * A mapped type's parameter, `Item` of `{ [Item in 'first']: Item }`, is a type parameter of the
 * type: its value's references to the name, and its remapped key's, are the parameter's, whatever
 * an alias around the type is named — as a function's type parameter hides one of an alias, TypeScript
 * keeps this one in `typeParameter`, not in the `typeParameters` of the declarations that have a list.
 */

const CASES = [
  {
    lines: ['type Item = Date;', "type M = { [Item in 'first']: Item };"],
    reads: ["parameter Item in 'first'"],
    what: "a mapped type's value",
  },
  {
    lines: ['type Item = Date;', "type M = { [Item in 'first' as Uppercase<Item>]: 1 };"],
    reads: ["parameter Item in 'first'"],
    what: "a mapped type's remapped key",
  },
  {
    lines: ['type Item = Date;', "type M = { [Item in 'first' as Uppercase<Item>]: Item };"],
    reads: ["parameter Item in 'first'", "parameter Item in 'first'"],
    what: "a mapped type's key and value",
  },
  {
    lines: ['type Item = Date;', 'type M<T> = { [Item in keyof T]: T[Item] };'],
    reads: ['parameter Item in keyof T'],
    what: "a mapped type's index of its own key",
  },
  {
    lines: ['type Item = Date;', "type M = { [Item in 'a']: { [Other in 'b']: Item } };"],
    reads: ["parameter Item in 'a'"],
    what: "a mapped type within another's value",
  },
  {
    lines: ['type Item = Date;', "type M = { [Item in 'a']: { [Item in 'b']: Item } };"],
    reads: ["parameter Item in 'b'"],
    what: "a mapped type's own parameter of the name again",
  },
  {
    lines: ["type M<Item> = { [Key in 'a']: Item } & { [Item in 'a']: 1 };"],
    reads: ['parameter Item'],
    what: "an alias's type parameter, which another mapped type's hides within itself alone",
  },
  {
    lines: ["type M<Item> = { [Item in 'a']: Item };"],
    reads: ["parameter Item in 'a'"],
    what: "a mapped type's parameter of an alias's type parameter's name",
  },
  {
    lines: ['type Item = Date;', "type M = { [Key in 'first']: Item };"],
    reads: ['alias Item'],
    what: 'an alias of the name another parameter leaves',
  },
  {
    lines: ['type Item = Date;', "type M = { [Item in 'first']: 1 };", 'type After = Item;'],
    reads: ['alias Item'],
    what: 'an alias read after the mapped type',
  },
  {
    lines: [
      'interface Item {',
      '  readonly id: string;',
      '}',
      'type M = { [Key in keyof Item]: Item[Key] };',
    ],
    reads: ['interface Item', 'interface Item'],
    what: "an interface of a mapped type's source",
  },
] as const;

/** What `binding` is, as the cases read it: `parameter` with its text, `alias`, `interface`. */
function describeBinding(binding: LocalTypeBinding, source: string, file: SourceFile): string {
  if (binding === undefined || binding === null) {
    return String(binding);
  }
  if (isTypeParameterDeclaration(binding)) {
    return `parameter ${source.slice(binding.getStart(file), binding.end)}`;
  }
  if (isTypeAliasDeclaration(binding)) {
    return `alias ${binding.name.text}`;
  }
  return isInterfaceDeclaration(binding) ? `interface ${binding.name.text}` : 'class';
}

describe("a mapped type's parameter in the lexical type lookup", () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** What each reference to `Item` in the module `lines` binds to, in the order they are written. */
  function bindingsOfItem(lines: readonly string[]): readonly string[] {
    const source = `${lines.join('\n')}\n`;
    using parsed = api.createSourceFile('mapped.ts', source);
    const found: string[] = [];
    const visit = (node: Node): void => {
      if (
        isTypeReferenceNode(node) &&
        isIdentifier(node.typeName) &&
        node.typeName.text === 'Item'
      ) {
        found.push(describeBinding(localTypeBinding(node.typeName), source, parsed.sourceFile));
      }
      node.forEachChild(visit);
    };
    parsed.sourceFile.forEachChild(visit);
    return found;
  }

  it.each(CASES)('$what', ({ lines, reads }) => {
    expect(bindingsOfItem(lines)).toStrictEqual(reads);
  });
});
