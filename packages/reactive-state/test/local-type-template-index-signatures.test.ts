import { isIndexedAccessTypeNode, isTypeAliasDeclaration, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { indexedMemberTypes } from '../src/compiler/local-type-members.ts';

/**
 * An index signature whose key is a template pattern, `data-${string}`, covers the literal keys
 * the pattern matches, as a `string` signature covers every key: what it selects is its value
 * type, ahead of a `string` signature's, which applies only where no other does. Text around
 * `${string}` holes is matched as TypeScript matches it; a pattern the reader does not match — a
 * `${number}` hole, one named through an alias — leaves its value possible. The rows marked a pin
 * answer the same before the change as after it.
 */

const DATA = `type Data = \`data-\${string}\`;`;

const CASES = [
  {
    selected: ['Error'],
    source: `{ [key: \`data-\${string}\`]: Error }["data-x"]`,
    what: 'a prefix pattern',
  },
  {
    selected: ['Error'],
    source: `{ [key: \`data-\${string}\`]: Error; [key: string]: string }["data-x"]`,
    what: 'a pattern ahead of a string signature',
  },
  {
    selected: ['Error'],
    source: `{ [key: \`\${string}-x\`]: Error }["a-x"]`,
    what: 'a suffix pattern',
  },
  {
    selected: ['Error'],
    source: `{ [key: \`a\${string}b\${string}c\`]: Error }["aXbYc"]`,
    what: 'a pattern of several holes',
  },
  {
    selected: ['Error'],
    source: `{ [key: \`data-\${string}\` | \`aria-\${string}\`]: Error }["aria-x"]`,
    what: 'a union of patterns',
  },
  {
    selected: ['Error'],
    source: `{ [key: (\`data-\${string}\`)]: Error }["data-x"]`,
    what: 'a parenthesized pattern',
  },
  {
    selected: ['Error'],
    source: `{ [key: \`a\${string}\` | number]: Error }["ab"]`,
    what: 'a pattern beside a number domain',
  },
  {
    selected: ['Error'],
    source: `{ [key: \`a\\n\${string}\`]: Error }["a\\nx"]`,
    what: 'a pattern of escaped text',
  },
  {
    prelude: DATA,
    selected: ['Error'],
    source: '{ [key: Data]: Error }["data-x"]',
    what: 'a pattern named through an alias, which stays possible',
  },
  {
    selected: ['Error'],
    source: `{ [key: \`data-\${number}\`]: Error }["data-1"]`,
    what: 'a number hole, which stays possible',
  },
  {
    selected: ['string'],
    source: `{ [key: \`data-\${string}\`]: Error; [key: string]: string }["other"]`,
    what: 'a key no pattern covers, of a string signature',
  },
  {
    selected: ['string'],
    source: `{ [key: \`a\${string}a\`]: Error; [key: string]: string }["a"]`,
    what: 'a key shorter than the text around the hole',
  },
  {
    selected: ['string'],
    source: `{ [key: \`a\${string}b\${string}c\`]: Error; [key: string]: string }["ac"]`,
    what: 'a key missing the text between two holes',
  },
  {
    selected: [],
    source: `{ [key: \`data-\${string}\`]: Error }["other"]`,
    what: 'a key no pattern covers (pin)',
  },
  {
    selected: ['string'],
    source: `{ data: string; [key: \`data-\${string}\`]: Error }["data"]`,
    what: 'a written name beside a pattern (pin)',
  },
  {
    selected: ['Error'],
    source: '{ [key: string]: Error }["data-x"]',
    what: 'a string signature (pin)',
  },
  {
    selected: ['Error'],
    source: `{ [key: number]: Error; [key: \`a\${string}\`]: string }["1"]`,
    what: 'a number signature beside a pattern the key leaves (pin)',
  },
] as const satisfies readonly {
  readonly prelude?: string;
  readonly selected: readonly string[];
  readonly source: string;
  readonly what: string;
}[];

describe('a template pattern index signature selected by a literal key', () => {
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
      'template-index-signatures.ts',
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
