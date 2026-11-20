import { isBinaryExpression, type Node, SyntaxKind } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { membershipThrows } from '../src/compiler/throw-operators.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

interface Row {
  readonly id: string;
  readonly source: string;
}

/** A generator method has an object `prototype`, so `instanceof` reads it and returns `false`. */
const GENERATORS: readonly Row[] = [
  { id: 'a generator method', source: '({}) instanceof (({ *g() {} }).g as any);' },
  { id: 'an async generator method', source: '({}) instanceof (({ async *g() {} }).g as any);' },
  {
    id: 'a generator method held by a constant',
    source: 'const holder = { *g() {} };\n({}) instanceof (holder.g as any);',
  },
];

/** A method that is no generator has no `prototype`: `instanceof` throws, in Node 26.13.1 alike. */
const NO_PROTOTYPE: readonly Row[] = [
  { id: 'an ordinary method', source: '({}) instanceof (({ g() {} }).g as any);' },
  { id: 'an async method', source: '({}) instanceof (({ async g() {} }).g as any);' },
  { id: 'an arrow function', source: '({}) instanceof ((() => {}) as any);' },
];

/** A function written out has a `prototype` object, and `instanceof` returns. */
const PROTOTYPED: readonly Row[] = [
  { id: 'a generator function expression', source: '({}) instanceof (function* () {} as any);' },
  { id: 'a function expression', source: '({}) instanceof (function () {} as any);' },
];

describe('the function target of instanceof', () => {
  it.each(GENERATORS.map((row) => [row.id, row] as const))('reads %s as no throw', (_id, row) => {
    expect(throwsOf(row)).toBe(false);
  });

  it.each(NO_PROTOTYPE.map((row) => [row.id, row] as const))('reads %s as a throw', (_id, row) => {
    expect(throwsOf(row)).toBe(true);
  });

  it.each(PROTOTYPED.map((row) => [row.id, row] as const))('reads %s as no throw', (_id, row) => {
    expect(throwsOf(row)).toBe(false);
  });
});

/** Whether the module answers that the last `instanceof` of the source throws. */
function throwsOf(row: Row): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'operator-targets.ts', row.source);
  const found = lastInstanceof(parsed.sourceFile);
  if (found === undefined) {
    throw new Error('The fixture holds an instanceof.');
  }
  return membershipThrows(found, undefined);
}

/** The last `instanceof` expression of a source, in order of appearance. */
function lastInstanceof(node: Node): Node | undefined {
  let found: Node | undefined;
  const visit = (each: Node): void => {
    found =
      isBinaryExpression(each) && each.operatorToken.kind === SyntaxKind.InstanceOfKeyword
        ? each
        : found;
    each.forEachChild(visit);
  };
  visit(node);
  return found;
}
