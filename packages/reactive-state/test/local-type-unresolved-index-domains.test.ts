import { isIndexedAccessTypeNode, isTypeAliasDeclaration, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { indexedMemberTypes } from '../src/compiler/local-type-members.ts';

/**
 * An index signature whose key is a type the reader cannot tell the keys of — `PropertyKey`, an
 * alias the file imports, `Uppercase<string>` — may cover any key, so its value stays possible
 * beside the others, as a pattern's the reader does not match does. A `symbol` covers no text, and
 * a name the type writes is read as before. The rows marked a pin answer the same before the
 * change as after it.
 */

const KEYS = 'import type { Key } from "./keys";';

const CASES = [
  {
    selected: ['Error'],
    source: '{ [key: PropertyKey]: Error }["x"]',
    what: 'PropertyKey over a name',
  },
  {
    selected: ['Error'],
    source: '{ [key: PropertyKey]: Error }[1]',
    what: 'PropertyKey over a number',
  },
  {
    prelude: 'type Keys = PropertyKey;',
    selected: ['Error'],
    source: '{ [key: Keys]: Error }["x"]',
    what: 'PropertyKey through a local alias',
  },
  {
    selected: ['Error'],
    source: '{ [key: Uppercase<string>]: Error }["A"]',
    what: 'an intrinsic string mapping',
  },
  {
    prelude: KEYS,
    selected: ['Error'],
    source: '{ [key: Key]: Error }["x"]',
    what: 'an imported alias',
  },
  {
    prelude: KEYS,
    selected: ['string', 'Error'],
    source: '{ [key: Key]: Error; [key: string]: string }["x"]',
    what: 'an imported alias beside a string signature',
  },
  {
    prelude: KEYS,
    selected: ['string', 'Error'],
    source: '{ [key: Key]: Error; [key: number]: string }[1]',
    what: 'an imported alias beside a number signature',
  },
  {
    selected: [],
    source: '{ [key: symbol]: Error }["x"]',
    what: 'a symbol, which covers no text (pin)',
  },
  {
    selected: ['string'],
    source: '{ [key: PropertyKey]: Error; title: string }["title"]',
    what: 'a written name beside PropertyKey (pin)',
  },
  {
    selected: ['Error'],
    source: '{ [key: string]: Error }["x"]',
    what: 'a string signature (pin)',
  },
] as const satisfies readonly {
  readonly prelude?: string;
  readonly selected: readonly string[];
  readonly source: string;
  readonly what: string;
}[];

describe('an index signature keyed by a type the reader cannot read', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The source texts of the members the indexed type `source` selects, after the `prelude`. */
  function selectedTexts(prelude: string, source: string): readonly string[] | undefined {
    using parsed = api.createSourceFile(
      'unresolved-index-domains.ts',
      `${prelude}\ntype Value = ${source};`,
    );
    let selected: readonly string[] | undefined;
    const visit = (node: Node): void => {
      if (isTypeAliasDeclaration(node) && node.name.text === 'Value') {
        if (!isIndexedAccessTypeNode(node.type)) throw new Error('The test source is indexed.');
        selected = indexedMemberTypes(node.type.objectType, node.type.indexType)?.map((member) =>
          member.getText(),
        );
      }
      node.forEachChild(visit);
    };
    visit(parsed.sourceFile);
    return selected;
  }

  it.each(CASES)('$what', (row) => {
    expect(selectedTexts('prelude' in row ? row.prelude : '', row.source)).toStrictEqual(
      row.selected,
    );
  });
});
