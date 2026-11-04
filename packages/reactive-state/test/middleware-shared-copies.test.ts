import {
  type Expression,
  type Identifier,
  isBindingElement,
  isIdentifier,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
} from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  mutatedCollection,
  mutatedSharedConstant,
} from '../src/compiler/middleware-shared-writes.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A shallow copy of a collection both middleware parts bind holds the collection's own elements,
 * so a write through the copy is a write the other part never sees. The copy is refused, bound to a
 * name or not; only the collection itself is read for it, not a member (a text's `slice` copies a text).
 */

interface Row {
  readonly id: string;
  readonly source: string;
  readonly refused: boolean;
  /** The name the collection is bound to; `decision` unless a row says otherwise. */
  readonly name?: string;
}

const ITEMS = 'const decision = [{ x: 1 }];';

const REFUSED: readonly Row[] = [
  // The forms of a copy a name is bound to: each is refused as the collection's own would be.
  {
    id: 'slice-for-of',
    refused: true,
    source: `${ITEMS} const copy = decision.slice(); for (const item of copy) item.x = 2;`,
  },
  {
    id: 'slice-for-each',
    refused: true,
    source: `${ITEMS} const copy = decision.slice(); copy.forEach((item) => { item.x = 2; });`,
  },
  {
    id: 'slice-pattern',
    refused: true,
    source: `${ITEMS} const copy = decision.slice(); const [first] = copy; first.x = 2;`,
  },
  {
    id: 'slice-pop',
    refused: true,
    source: `${ITEMS} const copy = decision.slice(); copy.pop();`,
  },
  {
    id: 'slice-computed-index',
    refused: true,
    source: `${ITEMS} const copy = decision.slice(); function set(index: number) { copy[index].x = 2; }`,
  },
  {
    id: 'slice-at-index',
    refused: true,
    source: `${ITEMS} const copy = decision.slice(); function set(index: number) { copy.at(index)!.x = 2; }`,
  },
  {
    id: 'spread-literal-index',
    refused: true,
    source: `${ITEMS} const copy = [...decision]; copy[0].x = 2;`,
  },
  {
    id: 'spread-at-index',
    refused: true,
    source: `${ITEMS} const copy = [...decision]; function set(index: number) { copy.at(index)!.x = 2; }`,
  },
  // A copy no name is bound to.
  {
    id: 'inline-spread-for-of',
    refused: true,
    source: `${ITEMS} for (const item of [...decision]) item.x = 2;`,
  },
  {
    id: 'inline-slice-for-each',
    refused: true,
    source: `${ITEMS} decision.slice().forEach((item) => { item.x = 2; });`,
  },
  // The other methods that return the elements themselves.
  ...['concat', 'filter', 'flat', 'toReversed', 'toSorted', 'toSpliced', 'with'].map((method) => {
    return {
      id: `${method}-for-of`,
      refused: true,
      source: `${ITEMS} for (const item of decision.${method}()) item.x = 2;`,
    };
  }),
  {
    id: 'values-for-of',
    refused: true,
    source: `${ITEMS} for (const item of decision.values()) item.x = 2;`,
  },
  {
    id: 'entries-for-of',
    refused: true,
    source: `${ITEMS} for (const [, item] of decision.entries()) item.x = 2;`,
  },
  // The collection under a name, a cast, a `!` or a bracketed method name.
  {
    id: 'alias-spread',
    refused: true,
    source: `${ITEMS} const alias = decision; for (const item of [...alias]) item.x = 2;`,
  },
  {
    id: 'alias-of-alias-slice',
    refused: true,
    source: `${ITEMS} const alias = decision; const again = alias; again.slice();`,
  },
  {
    id: 'cast-slice',
    refused: true,
    source: `${ITEMS} for (const item of (decision as { x: number }[]).slice()) item.x = 2;`,
  },
  {
    id: 'non-null-slice',
    refused: true,
    source: `${ITEMS} for (const item of decision!.slice()) item.x = 2;`,
  },
  {
    id: 'bracket-slice',
    refused: true,
    source: `${ITEMS} for (const item of decision['slice']()) item.x = 2;`,
  },
  // A copy of a copy is a copy of the collection.
  {
    id: 'copy-of-copy',
    refused: true,
    source: `${ITEMS} const copy = decision.slice(); const again = [...copy]; void again;`,
  },
  // An array of texts or numbers is copied by the same rule: the rule does not read what it holds.
  {
    id: 'primitive-spread-pin',
    refused: true,
    source: 'const decision = [1, 2, 3]; const total = [...decision].length;',
  },
  // A default of the context's pattern, bound where it is read.
  {
    id: 'default-slice',
    name: 'decision',
    refused: true,
    source:
      'export default (async ({ decision = [{ x: 1 }] }) => { for (const item of decision.slice()) item.x = 2; });',
  },
];

const ACCEPTED: readonly Row[] = [
  // What the collection is asked without copying it stays read as before.
  { id: 'length', refused: false, source: `${ITEMS} const count = decision.length;` },
  { id: 'join', refused: false, source: `${ITEMS} const text = decision.join(',');` },
  {
    id: 'map-to-values',
    refused: false,
    source: `${ITEMS} const values = decision.map((item) => item.x);`,
  },
  {
    id: 'some',
    refused: false,
    source: `${ITEMS} const found = decision.some((item) => item.x > 0);`,
  },
  {
    id: 'for-of-read',
    refused: false,
    source: `${ITEMS} let total = 0; for (const item of decision) total += item.x;`,
  },
  { id: 'method-not-called', refused: false, source: `${ITEMS} const method = decision.slice;` },
  // A copy of another collection, or of a name the collection's own is hidden by.
  {
    id: 'other-collection',
    refused: false,
    source: `${ITEMS} const other = [{ x: 2 }]; for (const item of [...other]) item.x = 3;`,
  },
  {
    id: 'shadowing-parameter',
    refused: false,
    source: `${ITEMS} function copied(decision: { x: number }[]) { return [...decision]; }`,
  },
  {
    id: 'shadowing-constant',
    refused: false,
    source: `${ITEMS} function copied() { const decision = [{ x: 2 }]; return decision.slice(); }`,
  },
  // A member is not the collection: `params.id.slice(0, 8)` copies a text.
  {
    id: 'member-text-slice',
    name: 'params',
    refused: false,
    source: 'export default (async ({ params }) => { return params.id.slice(0, 8); });',
  },
  {
    id: 'member-text-spread',
    name: 'params',
    refused: false,
    source: 'export default (async ({ params }) => { return [...params.id]; });',
  },
];

describe('a shallow copy of a collection both middleware parts bind', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether `mutatedCollection` refuses the name `row` binds, where its first declaration is. */
  function answered(row: Row): boolean {
    using parsed = parseModule(api, 'shared-copies.ts', row.source);
    const found = declaredIn(parsed.sourceFile, row.name ?? 'decision');
    if (found === undefined) {
      throw new Error(`The row ${row.id} declares the name it checks.`);
    }
    return mutatedCollection(found.name, found.initializer);
  }

  it.each(REFUSED)('refuses $id', (row) => {
    expect(answered(row)).toBe(row.refused);
  });

  it.each(ACCEPTED)('keeps $id', (row) => {
    expect(answered(row)).toBe(row.refused);
  });

  it.each([
    {
      id: 'constant-slice',
      refused: true,
      rest: 'const copy = ids.slice(); function set(index: number) { copy[index].x = 2; }',
    },
    { id: 'constant-spread', refused: true, rest: 'for (const item of [...ids]) item.x = 2;' },
    { id: 'constant-length', refused: false, rest: 'const count = ids.length;' },
  ])('reads the constants both parts read: $id', ({ refused, rest }) => {
    using parsed = parseModule(api, 'shared-constants.ts', `const ids = [{ x: 1 }]; ${rest}`);
    const constants = parsed.sourceFile.statements.flatMap((statement) => {
      return isVariableStatement(statement)
        ? [
            {
              declares: statement.declarationList.declarations.flatMap((each) =>
                isIdentifier(each.name) ? [each.name.text] : [],
              ),
              statement,
            },
          ]
        : [];
    });
    const found = mutatedSharedConstant(
      constants,
      () => true,
      (name) => name === 'ids',
    );

    expect(found !== undefined).toBe(refused);
  });
});

/** The first declaration of `name`, a variable's or a pattern's element's, and what it starts as. */
function declaredIn(
  root: Node,
  name: string,
): { readonly name: Identifier; readonly initializer: Expression | undefined } | undefined {
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      (isVariableDeclaration(node) || isBindingElement(node)) &&
      node.name !== undefined &&
      isIdentifier(node.name) &&
      node.name.text === name
    ) {
      return { initializer: node.initializer, name: node.name };
    }
    const children: Node[] = [];
    node.forEachChild((child) => {
      children.push(child);
    });
    pending.push(...children.toReversed());
  }
  return undefined;
}
