import { isExpressionStatement, type Expression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedObjectSources } from '../src/compiler/framed-object-members.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A member read walks a written prototype chain, and for the key `__proto__` each prototype answers
 * two ways: its own field of that name, and what the `Object.prototype` getter returns. The same
 * prototype read the same way is reached by many paths, so the reads are kept once each: a chain of
 * written prototypes read through as many `__proto__` members otherwise takes a time that grows as
 * a power of two with their number.
 */
const DEPTH = 24;

describe('reads through a written prototype chain', () => {
  it('reads a deep chain through as many __proto__ members once each', () => {
    expect(selected(chain(DEPTH, '{}'), DEPTH)).toStrictEqual([]);
  });

  it('finds the field at the bottom of a deep chain', () => {
    expect(selected(chain(DEPTH, "{ ['__proto__']: error }"), 1)).toStrictEqual(['error:stack']);
  });

  it('finds the field at the bottom of a short chain read through its members', () => {
    expect(selected(chain(3, "{ ['__proto__']: error }"), 1)).toStrictEqual(['error:stack']);
  });
});

/** `depth` literals, each written with the one inside it as its prototype, around `inner`. */
function chain(depth: number, inner: string): string {
  let literal = inner;
  for (let each = 0; each < depth; each += 1) literal = `{ __proto__: ${literal} }`;
  return literal;
}

/** The sources `stack` of the literal read through `reads` `__proto__` members may be read from. */
function selected(literal: string, reads: number): readonly string[] | undefined {
  using api = openTypeScript();
  using parsed = parseModule(
    api,
    'prototype-chain-reads.ts',
    `declare const error: Error; (${literal})${'.__proto__'.repeat(reads)};`,
  );
  return framedObjectSources(statement(parsed.sourceFile), ['stack'])
    ?.map((each) => `${each.value.getText()}:${each.keys.join('.')}`)
    .toSorted((left, right) => left.localeCompare(right));
}

function statement(root: Node): Expression {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isExpressionStatement(node)) return node.expression;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no statement');
}
