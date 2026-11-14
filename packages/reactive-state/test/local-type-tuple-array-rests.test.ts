import { isIndexedAccessTypeNode, isTypeAliasDeclaration, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { indexedMemberTypes } from '../src/compiler/local-type-members.ts';

/**
 * A numeric index selects every position of a written tuple, a rest's element among them: the
 * element of `...Error[]`, and of `...Array<Error>` or `...ReadonlyArray<Error>` where no
 * declaration of the file hides the name, which is the same array. A rest of another type — an
 * alias, a type parameter — is none the reader expands, and the fixed positions the code shows
 * stay selected beside it. The rows marked a pin answer the same before the change as after it.
 */

const CASES = [
  {
    selected: ['string', 'Error'],
    source: '[string, ...Array<Error>][number]',
    what: 'the rest of an Array reference',
  },
  {
    selected: ['string', 'Error'],
    source: '[string, ...ReadonlyArray<Error>][number]',
    what: 'the rest of a ReadonlyArray reference',
  },
  {
    selected: ['string', 'Error'],
    source: '(readonly [string, ...ReadonlyArray<Error>])[number]',
    what: 'the rest of a readonly tuple',
  },
  {
    selected: ['string', 'Error', 'number'],
    source: '[string, ...Array<Error>, number][number]',
    what: 'a rest before a fixed position',
  },
  {
    selected: ['Error'],
    source: '[...Array<Error>][number]',
    what: 'a tuple of a rest alone',
  },
  {
    selected: ['string', 'Error'],
    source: '[head: string, ...tail: Array<Error>][number]',
    what: 'a named rest',
  },
  {
    selected: ['string', 'Error'],
    source: '[string, ...globalThis.Array<Error>][number]',
    what: 'the rest of a qualified Array reference',
  },
  {
    selected: ['string', 'Error'],
    source: '[string, ...Error[]][number]',
    what: 'the rest of an array type (pin)',
  },
  {
    prelude: 'type Array<T> = { stack: string };',
    selected: ['string'],
    source: '[string, ...Array<Error>][number]',
    what: 'a rest of a local Array, no native array (pin)',
  },
  {
    prelude: 'type Rest = string[];',
    selected: ['Error'],
    source: '[Error, ...Rest][number]',
    what: 'a rest of an alias beside a fixed position (pin)',
  },
  {
    prelude: 'type Rest = Error[];',
    selected: undefined,
    source: '[...Rest][number]',
    what: 'a rest of an alias alone (pin)',
  },
  {
    selected: ['string'],
    source: '[string, ...Array<Error>][0]',
    what: 'a fixed position before a rest (pin)',
  },
  {
    selected: undefined,
    source: '[string, ...Array<Error>][1]',
    what: 'a position a rest holds (pin)',
  },
  {
    selected: undefined,
    source: 'Array<Error>[number]',
    what: 'an Array reference selected whole (pin)',
  },
] as const satisfies readonly {
  readonly prelude?: string;
  readonly selected: readonly string[] | undefined;
  readonly source: string;
  readonly what: string;
}[];

describe('a numeric index selected from a written tuple with an Array rest', () => {
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
      'tuple-array-rests.ts',
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
