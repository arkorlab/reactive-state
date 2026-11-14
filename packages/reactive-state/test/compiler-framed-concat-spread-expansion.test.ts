import { isObjectLiteralExpression, type Node, type ObjectLiteralExpression } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { concatFields } from '../src/compiler/framed-concat-properties.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Each whole-literal spread of a constant is expanded where it stands, so constants that each spread
 * the one before twice grow as a power of two from as many declarations. The expansion is bounded:
 * past its bound a spread stands as one field the compile cannot read, which every reader of the
 * fields takes as opaque.
 */
const BOUND = 256;

describe('whole-literal spreads of constants', () => {
  it('expands a few spreads in full', () => {
    const fields = fieldsOf(chain(6));

    expect(fields).toHaveLength(2 ** 6);
    expect(fields.every((each) => each !== undefined)).toBe(true);
  });

  it('expands up to the bound in full', () => {
    const fields = fieldsOf(chain(7));

    expect(fields).toHaveLength(2 ** 7);
    expect(fields.every((each) => each !== undefined)).toBe(true);
  });

  it('stops expanding past the bound and leaves one opaque field for each spread it did not', () => {
    const fields = fieldsOf(chain(20));

    expect(fields.length).toBeLessThan(BOUND * 4);
    expect(fields).toContain(undefined);
  });

  it('keeps a cycle opaque', () => {
    const fields = fieldsOf('const a: { x: number } = { ...a, x: 1 };', 'a');

    expect(fields).toContain(undefined);
  });
});

/** Constants `a1` … `a<depth>`, each spreading the one before twice, over `a0`. */
function chain(depth: number): string {
  const lines = ['const a0 = { x: 1 };'];
  for (let each = 1; each <= depth; each += 1)
    lines.push(`const a${each} = { ...a${each - 1}, ...a${each - 1} };`);
  return lines.join(' ');
}

/** The fields of the last declared literal, or of the one named. */
function fieldsOf(source: string, name?: string): readonly unknown[] {
  using api = openTypeScript();
  using parsed = parseModule(api, 'concat-spread-expansion.ts', source);
  const literals: ObjectLiteralExpression[] = [];
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isObjectLiteralExpression(node)) literals.push(node);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  const root = name === undefined ? literals.toSorted(byStart).at(-1) : literals.at(0);
  if (root === undefined) throw new Error('no literal');
  return concatFields(root, () => true);
}

function byStart(left: Node, right: Node): number {
  return left.pos - right.pos;
}
