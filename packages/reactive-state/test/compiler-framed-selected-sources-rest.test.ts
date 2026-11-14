import { type Expression, isIdentifier, isReturnStatement, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { selectedValues } from '../src/compiler/framed-selected-sources.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A member that a rest takes the copy of a source for holds what the fields the pattern names do
 * not take. A name the pattern lists leaves a field out of the copy only where a field of the member
 * is asked for; the member itself, asked whole, receives the copy whatever names the pattern lists.
 */
const CASES = [
  {
    id: 'whole-member-with-an-empty-name-listed',
    source: `function frames(src: object) { const obj: any = {}; let y: unknown; ({ '': y, ...obj.m } = src); return obj; }`,
    keys: ['m'],
    values: ['src:'],
  },
  {
    id: 'whole-member-with-a-named-field-listed',
    source: `function frames(src: object) { const obj: any = {}; let y: unknown; ({ field: y, ...obj.m } = src); return obj; }`,
    keys: ['m'],
    values: ['src:'],
  },
  {
    id: 'asked-field-the-pattern-lists-pin',
    source: `function frames(src: object) { const obj: any = {}; let y: unknown; ({ field: y, ...obj.m } = src); return obj; }`,
    keys: ['m', 'field'],
    values: [],
  },
  {
    id: 'asked-field-the-pattern-does-not-list-pin',
    source: `function frames(src: object) { const obj: any = {}; let y: unknown; ({ other: y, ...obj.m } = src); return obj; }`,
    keys: ['m', 'field'],
    values: ['src:field'],
  },
] as const;

describe('what a rest copy gives a member', () => {
  it.each(CASES)('$id', ({ source, keys, values }) => {
    expect(selected(source, keys)).toStrictEqual(values);
  });
});

function selected(source: string, keys: readonly string[]): readonly string[] {
  using api = openTypeScript();
  using parsed = parseModule(api, 'selected-sources-rest.ts', source);
  const read = returned(parsed.sourceFile);
  return selectedValues(read, keys, read).map(
    (each) => `${each.value.getText()}:${each.keys.join('.')}`,
  );
}

function returned(root: Node): Expression {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isReturnStatement(node) && node.expression !== undefined && isIdentifier(node.expression))
      return node.expression;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no returned name');
}
