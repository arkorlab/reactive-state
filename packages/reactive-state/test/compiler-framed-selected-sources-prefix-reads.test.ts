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
 * A prefix operator writes what it is given only where it steps it (`++`, `--`): `!`, `-`, `+` and
 * `~` read it. A negated or negative read of a member of a list, or of a member below an entry of
 * it, leaves the list what its literal wrote, as any other read does.
 */
const HEAD = "const list: any[] = [{ x: 'safe', n: 1, y: { z: 1 } }, ['a']];";

const READS = [
  { id: 'field-negated', body: 'void !list[0].x;' },
  { id: 'field-made-positive', body: 'void +list[0].n;' },
  { id: 'field-made-negative', body: 'void -list[0].n;' },
  { id: 'field-complemented', body: 'void ~list[0].n;' },
  { id: 'nested-field-negated', body: 'void !list[0].y.z;' },
  { id: 'length-of-an-entry-negated', body: 'void !list[1].length;' },
  { id: 'entry-negated', body: 'void !list[0];' },
  { id: 'entry-made-negative', body: 'void -list[1];' },
  { id: 'field-negated-in-a-condition', body: 'if (!list[0].x) { void list[1]; }' },
] as const;

const WRITES = [
  { id: 'field-incremented-first', body: '++list[0].n;' },
  { id: 'field-decremented-first', body: '--list[0].n;' },
  { id: 'nested-field-incremented-first', body: '++list[0].y.z;' },
  { id: 'entry-incremented-first', body: '++list[0];' },
  { id: 'entry-decremented-first', body: '--list[1];' },
  { id: 'field-incremented-under-parentheses', body: '++(list[0].n);' },
] as const;

describe('a prefix operator on a member of a list a spread copies', () => {
  it.each(READS)('$id is a read of the list', ({ body }) => {
    const source = `function frames(error: any) { ${HEAD} ${body} return [...list]; }`;

    expect(isWritten(source)).toBe(true);
  });

  it.each(WRITES)('$id writes the list', ({ body }) => {
    const source = `function frames(error: any) { ${HEAD} ${body} return [...list]; }`;

    expect(isWritten(source)).toBe(false);
  });
});

/** Whether the list the source spreads is read as its literal wrote it. */
function isWritten(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'prefix-reads.ts', source);
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
