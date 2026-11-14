import {
  isBinaryExpression,
  isBlock,
  isExpressionStatement,
  isFunctionDeclaration,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { jumpsOver } from '../src/compiler/framed-writes.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** The first node under `root` that the predicate takes. */
function found(root: Node, taken: (node: Node) => boolean): Node {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (taken(node)) return node;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no node');
}

/**
 * A return that holds the write it is asked to jump over goes after the write is made: it is in no
 * arm of its own. The question is answered, and does not climb out of the file looking for an arm
 * that holds a node that holds the other.
 */
describe('a jump that holds the write', () => {
  it('is answered for a return in a finally block', () => {
    using api = openTypeScript();
    using parsed = parseModule(
      api,
      'x.ts',
      `function frames(values: any) { try { } finally { return (values.join = 1); } values.join = 2; }`,
    );
    const declaration = found(parsed.sourceFile, (node) => isFunctionDeclaration(node));
    const write = found(declaration, (node) => {
      return (
        isBinaryExpression(node) &&
        node.right.getText() === '1' &&
        node.left.getText() === 'values.join'
      );
    });
    const target = found(
      declaration,
      (node) => isExpressionStatement(node) && node.getText() === 'values.join = 2;',
    );
    const scope = found(declaration, (node) => isBlock(node));

    // A return of the function that holds the scope ends the run, and lands past nothing in it.
    expect(jumpsOver(scope, write, target, scope)).toBe(false);
  });
});
