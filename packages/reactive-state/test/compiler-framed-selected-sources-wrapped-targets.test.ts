import {
  type Expression,
  isIdentifier,
  isSpreadElement,
  type Node,
  type SpreadElement,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { writtenList } from '../src/compiler/framed-selected-sources.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A member of a list is written wherever the language writes it, whatever wraps the member in the
 * code: parentheses, a cast, a non-null assertion, `satisfies`; the list is then no longer the list
 * its literal wrote.
 */
const HEAD = "const list: any[] = ['safe'];";

const CASES = [
  {
    id: 'parenthesized-compound-assignment',
    source: `function frames() { ${HEAD} (list[0]) += 1; return [...list]; }`,
    written: false,
  },
  {
    id: 'parenthesized-assignment',
    source: `function frames() { ${HEAD} (list[0]) = 1; return [...list]; }`,
    written: false,
  },
  {
    id: 'parenthesized-logical-assignment',
    source: `function frames() { ${HEAD} (list[0]) ||= 1; return [...list]; }`,
    written: false,
  },
  {
    id: 'parenthesized-increment',
    source: `function frames() { ${HEAD} (list[0])++; return [...list]; }`,
    written: false,
  },
  {
    id: 'parenthesized-prefix-increment',
    source: `function frames() { ${HEAD} ++(list[0]); return [...list]; }`,
    written: false,
  },
  {
    id: 'parenthesized-delete',
    source: `function frames() { ${HEAD} delete (list[0]); return [...list]; }`,
    written: false,
  },
  {
    id: 'twice-parenthesized-compound-assignment',
    source: `function frames() { ${HEAD} ((list[0])) += 1; return [...list]; }`,
    written: false,
  },
  {
    id: 'cast-compound-assignment',
    source: `function frames() { ${HEAD} (list[0] as any) += 1; return [...list]; }`,
    written: false,
  },
  {
    id: 'non-null-compound-assignment',
    source: `function frames() { ${HEAD} list[0]! += 1; return [...list]; }`,
    written: false,
  },
  {
    id: 'angle-cast-compound-assignment',
    source: `function frames() { ${HEAD} (<any>list[0]) += 1; return [...list]; }`,
    written: false,
  },
  {
    id: 'satisfies-compound-assignment',
    source: `function frames() { ${HEAD} (list[0] satisfies unknown) += 1; return [...list]; }`,
    written: false,
  },
  {
    id: 'cast-assignment',
    source: `function frames() { ${HEAD} (list[0] as any) = 1; return [...list]; }`,
    written: false,
  },
  {
    id: 'non-null-assignment',
    source: `function frames() { ${HEAD} list[0]! = 1; return [...list]; }`,
    written: false,
  },
  {
    id: 'cast-increment',
    source: `function frames() { ${HEAD} (list[0] as any)++; return [...list]; }`,
    written: false,
  },
  {
    id: 'non-null-delete',
    source: `function frames() { ${HEAD} delete list[0]!; return [...list]; }`,
    written: false,
  },
  {
    id: 'parenthesized-in-an-array-pattern',
    source: `function frames() { ${HEAD} [(list[0])] = [1]; return [...list]; }`,
    written: false,
  },
  {
    id: 'cast-in-an-array-pattern',
    source: `function frames() { ${HEAD} [list[0] as any] = [1]; return [...list]; }`,
    written: false,
  },
  {
    id: 'non-null-in-an-object-pattern',
    source: `function frames() { ${HEAD} ({ x: list[0]! } = { x: 1 }); return [...list]; }`,
    written: false,
  },
  {
    id: 'parenthesized-loop-variable',
    source: `function frames() { ${HEAD} for ((list[0]) of [1]) { } return [...list]; }`,
    written: false,
  },
  {
    id: 'parenthesized-method-that-changes-the-list',
    source: `function frames() { ${HEAD} (list.push)(1); return [...list]; }`,
    written: false,
  },
  {
    id: 'cast-method-that-changes-the-list',
    source: `function frames() { ${HEAD} (list.push as any)(1); return [...list]; }`,
    written: false,
  },
  {
    id: 'parenthesized-read-pin',
    source: `function frames() { ${HEAD} void (list[0]); return [...list]; }`,
    written: true,
  },
  {
    id: 'parenthesized-read-for-compound-right-pin',
    source: `function frames() { ${HEAD} let total = 0; total += (list[0] as number); return [...list]; }`,
    written: true,
  },
  {
    id: 'parenthesized-method-that-reads-pin',
    source: `function frames() { ${HEAD} (list.slice)(); return [...list]; }`,
    written: true,
  },
  {
    id: 'cast-read-pin',
    source: `function frames() { ${HEAD} void (list[0] as any); return [...list]; }`,
    written: true,
  },
  {
    id: 'non-null-read-pin',
    source: `function frames() { ${HEAD} void list[0]!; return [...list]; }`,
    written: true,
  },
] as const;

describe('a member of a list a spread copies, written under a wrapper', () => {
  it.each(CASES)('$id', ({ source, written }) => {
    expect(isWritten(source)).toBe(written);
  });
});

/** Whether the list the source spreads is read as its literal wrote it. */
function isWritten(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'wrapped-targets.ts', source);
  return writtenList(spreadOf(parsed.sourceFile).expression) !== undefined;
}

function spreadOf(root: Node): SpreadElement & { readonly expression: Expression } {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isSpreadElement(node) && isIdentifier(node.expression)) return node;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no spread of a name');
}
