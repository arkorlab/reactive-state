import { isIndexedAccessTypeNode, isTypeAliasDeclaration, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { indexedMemberTypes } from '../src/compiler/local-type-members.ts';

/**
 * Of two adjacent `${string}` holes the first takes a character of the key. TypeScript 6.0.3 counts
 * it as a UTF-16 unit and 7.1 as a code point, so a key whose characters outside the Basic
 * Multilingual Plane make the two counts differ is matched by one and not by the other: such a
 * pattern only may cover the key, and the `string` signature stays beside its value. Where the two
 * agree it matches as before. The rows marked a pin answer the same before the change as after it.
 */

const CASES = [
  {
    selected: ['string', 'Error'],
    source: `{ [key: \`a\${string}\${string}\${string}b\`]: Error; [key: string]: string }["a\\u{1F600}b"]`,
    what: 'a key one code point short, two units enough',
  },
  {
    selected: ['Error'],
    source: `{ [key: \`a\${string}\${string}\${string}b\`]: Error }["a\\u{1F600}b"]`,
    what: 'a pattern alone over such a key (pin)',
  },
  {
    selected: ['Error'],
    source: `{ [key: \`a\${string}\${string}b\`]: Error; [key: string]: string }["a\\u{1F600}b"]`,
    what: 'two holes over one code point (pin)',
  },
  {
    selected: ['Error'],
    source: `{ [key: \`a\${string}\${string}\${string}b\`]: Error; [key: string]: string }["a\\u{1F600}xb"]`,
    what: 'three holes over a code point and a letter (pin)',
  },
  {
    selected: ['Error'],
    source: `{ [key: \`a\${string}\${string}\${string}b\`]: Error; [key: string]: string }["a\\u{1F600}\\u{1F600}b"]`,
    what: 'three holes over two code points (pin)',
  },
  {
    selected: ['string'],
    source: `{ [key: \`a\${string}\${string}\${string}b\`]: Error; [key: string]: string }["axb"]`,
    what: 'three holes over one letter (pin)',
  },
  {
    selected: ['Error'],
    source: `{ [key: \`a\${string}b\`]: Error; [key: string]: string }["ab"]`,
    what: 'a hole over nothing (pin)',
  },
] as const;

describe('adjacent template holes over a key with characters beyond one UTF-16 unit', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The source texts of the members the indexed type `source` selects. */
  function selectedTexts(source: string): readonly string[] | undefined {
    using parsed = api.createSourceFile('template-hole-code-points.ts', `type Value = ${source};`);
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

  it.each(CASES)('$what', ({ selected, source }) => {
    expect(selectedTexts(source)).toStrictEqual(selected);
  });
});
