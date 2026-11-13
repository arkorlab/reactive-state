import { type Expression, isBinaryExpression, isIdentifier, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedAtMethod, framedOwnMethod } from '../src/compiler/framed-at-methods.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * The name of a function declaration is a binding a program may write: a method that names it may
 * hold what was written to it instead, and the declaration's body then proves nothing.
 */
const CASES = [
  {
    id: 'declaration-never-written-is-an-own-method',
    source: `function frames(holder: any, error: Error) { function at() { return 'safe'; } holder.at = at; }`,
    own: true,
    result: false,
  },
  {
    id: 'declaration-written-later-is-no-own-method',
    source: `function frames(holder: any, error: Error) { function at() { return 'safe'; } at = () => error; holder.at = at; }`,
    own: false,
    result: undefined,
  },
  {
    id: 'declaration-written-in-a-branch-is-no-own-method',
    source: `function frames(holder: any, error: Error, flag: boolean) { function at() { return 'safe'; } if (flag) at = () => error; holder.at = at; }`,
    own: false,
    result: undefined,
  },
  {
    id: 'declaration-written-by-a-pattern-of-an-unknown-key-is-no-own-method',
    source: `function frames(holder: any, error: Error, key: string) { function at() { return 'safe'; } ({ [key]: at } = { at: () => error }); holder.at = at; }`,
    own: false,
    result: undefined,
  },
  {
    id: 'declaration-written-by-an-array-pattern-is-no-own-method',
    source: `function frames(holder: any, error: Error, list: unknown[]) { function at() { return 'safe'; } [at] = list; holder.at = at; }`,
    own: false,
    result: undefined,
  },
  {
    id: 'declaration-written-by-a-loop-head-is-no-own-method',
    source: `function frames(holder: any, error: Error, list: unknown[]) { function at() { return 'safe'; } for (at of list) {} holder.at = at; }`,
    own: false,
    result: undefined,
  },
  {
    id: 'declaration-shadowed-where-the-name-is-written-pin',
    source: `function frames(holder: any, error: Error) { function at() { return 'safe'; } const other = () => { let at = () => error; at = () => 'x'; return at; }; holder.at = at; void other; }`,
    own: true,
    result: false,
  },
  {
    id: 'declaration-returning-the-error',
    source: `function frames(holder: any, error: Error) { function at() { return error; } holder.at = at; }`,
    own: true,
    result: true,
  },
] as const;

describe('a method that names a function declaration', () => {
  it.each(CASES)('$id', ({ source, own, result }) => {
    const found = methodValue(source);

    expect(found.own).toBe(own);
    expect(found.result).toBe(result);
  });
});

function methodValue(source: string): { own: boolean; result: boolean | undefined } {
  using api = openTypeScript();
  using parsed = parseModule(api, 'at-methods-declarations.ts', source);
  const value = assignedAt(parsed.sourceFile);
  return {
    own: framedOwnMethod(value),
    result: framedAtMethod(value, (each) => isIdentifier(each) && each.text === 'error'),
  };
}

/** The right of the `holder.at = ...` assignment. */
function assignedAt(root: Node): Expression {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isBinaryExpression(node) && node.left.getText() === 'holder.at') return node.right;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no holder.at assignment');
}
