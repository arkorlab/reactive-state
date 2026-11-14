import type { Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isErased, readsCodeGlobal } from '../src/compiler/code-globals.ts';

/**
 * A decorator runs where the class is defined, outside the parameters of the method it decorates —
 * and outside a parameter's own, a parameter's decorator being another's of the same list: in
 * `class C { @(Function('return 1')()) method(Function: unknown) {} }` the `Function` of the
 * decorator is the global's, and the `Function` of the body is the parameter's. So are a method's
 * computed name and the member names of a class, which a parameter of a method does not reach. What
 * a function around the class declares is in scope of its decorators, as it is of the class.
 */

const CODE = "Function('return 1')()";

const CASES = [
  {
    reads: ['Function'],
    source: `export class C {\n  @(${CODE}) method(Function: unknown) {}\n}`,
    what: "a method's decorator, beside a parameter of the name",
  },
  {
    reads: ['Function'],
    source: `export class C {\n  @(${CODE}) static method(Function: unknown) {}\n}`,
    what: "a static method's decorator, beside a parameter of the name",
  },
  {
    reads: ['Function'],
    source: `export class C {\n  @(${CODE}) get value(): unknown {\n    return 1;\n  }\n  method(Function: unknown) {}\n}`,
    what: "a getter's decorator, with a method of a parameter of the name beside it",
  },
  {
    reads: ['Function'],
    source: `export class C {\n  @(${CODE}) set value(Function: unknown) {}\n}`,
    what: "a setter's decorator, beside its parameter of the name",
  },
  {
    reads: ['Function'],
    source: `export class C {\n  @(${CODE}) value = 1;\n  method(Function: unknown) {}\n}`,
    what: "a property's decorator, with a method of a parameter of the name beside it",
  },
  {
    reads: ['Function'],
    source: `export class C {\n  @(${CODE}) accessor value = 1;\n  method(Function: unknown) {}\n}`,
    what: "an accessor property's decorator, with a method of a parameter of the name beside it",
  },
  {
    reads: ['Function'],
    source: `@(${CODE})\nexport class C {\n  method(Function: unknown) {}\n}`,
    what: "a class's decorator, with a method of a parameter of the name in it",
  },
  {
    reads: ['Function'],
    source: `export class C {\n  method(@(${CODE}) Function: unknown) {}\n}`,
    what: "a parameter's decorator, beside the parameter of the name it decorates",
  },
  {
    reads: ['Function'],
    source: `export class C {\n  method(first: unknown, @(${CODE}) second: unknown, Function: unknown) {}\n}`,
    what: "a parameter's decorator, beside another parameter of the name",
  },
  {
    reads: ['Function'],
    source: `export class C {\n  constructor(@(${CODE}) Function: unknown) {}\n}`,
    what: "a constructor's parameter's decorator, beside the parameter of the name",
  },
  {
    reads: ['Function'],
    source: `export class C {\n  set value(@(${CODE}) Function: unknown) {}\n}`,
    what: "a setter's parameter's decorator, beside the parameter of the name",
  },
  {
    reads: ['Function'],
    source: `export class C {\n  [${CODE}](Function: unknown) {}\n}`,
    what: "a method's computed name, beside a parameter of the name",
  },
  {
    reads: ['Function'],
    source: `export class C {\n  get [${CODE}]() {\n    return 1;\n  }\n  method(Function: unknown) {}\n}`,
    what: "a getter's computed name, with a method of a parameter of the name beside it",
  },
  {
    reads: ['Function'],
    source: `export class C {\n  [${CODE}] = 1;\n  method(Function: unknown) {}\n}`,
    what: "a property's computed name, with a method of a parameter of the name beside it",
  },
  {
    reads: ['Function'],
    source: `export class C extends (${CODE}) {\n  method(Function: unknown) {}\n}`,
    what: "a class's `extends`, with a method of a parameter of the name in it",
  },
  {
    reads: ['Function'],
    source: `export class C {\n  static {\n    ${CODE};\n  }\n  method(Function: unknown) {}\n}`,
    what: "a class's static block, with a method of a parameter of the name beside it",
  },
  {
    reads: ['Function'],
    source: `export class C {\n  @(${CODE}) method(Function: unknown, other = Function) {}\n}`,
    what: "a method's decorator, beside a default that reads the parameter",
  },
  {
    reads: ['0, Function', 'Function'],
    source:
      "export class C {\n  @((0, Function)('return () => {}')()) method(Function: unknown) {}\n}",
    what: 'a decorator past a comma, beside a parameter of the name',
  },
  {
    reads: ['Function', 'Function'],
    source: `export class C {\n  @(${CODE}) first(Function: unknown) {}\n  @(${CODE}) second(Function: unknown) {}\n}`,
    what: 'the decorators of two methods, each beside a parameter of the name',
  },
  {
    reads: ['Function'],
    source: `export class C {\n  @(${CODE}) method(Function: unknown) {\n    return Function;\n  }\n}`,
    what: "a method's decorator, where its body reads the parameter",
  },
  {
    reads: ['Function'],
    source: `export const make = () => class {\n  @(${CODE}) method(Function: unknown) {}\n};`,
    what: "a decorator of a class expression's method, beside a parameter of the name",
  },
  {
    reads: [],
    source: `export class C {\n  method(Function: unknown) {\n    return ${CODE};\n  }\n}`,
    what: "a method's body, where the parameter of the name is read",
  },
  {
    reads: [],
    source: `export class C {\n  method(Function: unknown, other = ${CODE}) {}\n}`,
    what: "a method's default, where the parameter of the name is read",
  },
  {
    reads: [],
    source: `export function make(Function: unknown) {\n  return class {\n    @(${CODE}) method() {}\n  };\n}`,
    what: 'a decorator beside which a function around the class declares the name',
  },
  {
    reads: [],
    source: `export function make(Function: unknown) {\n  class C {\n    method(@(${CODE}) other: unknown) {}\n  }\n  return C;\n}`,
    what: "a parameter's decorator, beside which a function around the class declares the name",
  },
  {
    reads: [],
    source: "export class C {\n  @(run('return 1')()) method(Function: unknown) {}\n}",
    what: 'a decorator that reads no global of code, beside a parameter of the name',
  },
  {
    reads: ['Function'],
    source: `export class C {\n  static {\n    const Function = (text: string) => text;\n    Function('return 1');\n  }\n  @(${CODE}) method() {}\n}`,
    what: 'a decorator of the global, beside a static block that declares the name of its own',
  },
] as const;

describe('a decorator read, beside a parameter of the name it reads', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The text of each node of `source` that reads what made code. */
  function codeReadsIn(source: string): readonly string[] {
    using parsed = api.createSourceFile('decorators.ts', `${source}\n`);
    const { sourceFile } = parsed;
    const reads: string[] = [];
    const visit = (node: Node): void => {
      if (isErased(node)) {
        return;
      }
      if (readsCodeGlobal(node)) {
        reads.push(sourceFile.text.slice(node.getStart(sourceFile), node.end));
      }
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
    return reads;
  }

  it.each(CASES)('reads $what', ({ reads, source }) => {
    expect(codeReadsIn(source)).toStrictEqual(reads);
  });
});
