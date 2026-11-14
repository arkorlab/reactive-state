import type { Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isErased, readsCodeGlobal } from '../src/compiler/code-globals.ts';
import { handedGlobal } from '../src/compiler/handed-globals.ts';

/**
 * A read of a global in a module that gives the global's name to a name of its own elsewhere — a
 * parameter of another function, a variable of another block, a parameter of a type — as a shared
 * module may: the read is the global's where no declaration in scope gives the name, and is read as
 * the global's there, as it is in a module that gives the name nowhere. Where a declaration in scope
 * gives it — a parameter, the module's own variable or import, a `var` of one of its blocks — the
 * read is that declaration's.
 */

const CASES = [
  {
    lines: [
      'export function run(source: string) {',
      '  return Function(source)();',
      '}',
      'function unrelated(Function: unknown) {',
      '  return Function;',
      '}',
    ],
    reads: ['2:Function'],
    what: "another function's parameter",
  },
  {
    lines: [
      'type Hide = (Function: unknown) => void;',
      'export function run(source: string) {',
      '  return Function(source)();',
      '}',
    ],
    reads: ['3:Function'],
    what: "a type's parameter",
  },
  {
    lines: [
      'export function run(source: string) {',
      '  return Function(source)();',
      '}',
      'export function other() {',
      '  {',
      '    const Function = 1;',
      '    return Function;',
      '  }',
      '}',
    ],
    reads: ['2:Function'],
    what: "another block's constant",
  },
  {
    lines: [
      'export const read = (key: string) => globalThis[key];',
      'export function other(globalThis: unknown) {',
      '  return globalThis;',
      '}',
    ],
    reads: ['1:globalThis'],
    what: 'the global object by a computed key',
  },
  {
    lines: ['export function run(source: string) {', '  return Function(source)();', '}'],
    reads: ['2:Function'],
    what: 'no other declaration',
  },
  {
    lines: [
      'export function run(Function: (source: string) => unknown, source: string) {',
      '  return Function(source);',
      '}',
    ],
    reads: [],
    what: 'its own parameter',
  },
  {
    lines: [
      'const Function = (source: string) => source;',
      'export function run(source: string) {',
      '  return Function(source);',
      '}',
    ],
    reads: [],
    what: "the module's constant",
  },
  {
    lines: [
      "import { Function } from './made';",
      'export function run(source: string) {',
      '  return Function(source);',
      '}',
      'function unrelated(Function: unknown) {',
      '  return Function;',
      '}',
    ],
    reads: [],
    what: "the module's import",
  },
  {
    lines: [
      'if (true) {',
      '  var Function = (source: string) => source;',
      '}',
      'export function run(source: string) {',
      '  return Function(source);',
      '}',
    ],
    reads: [],
    what: "a var of the module's block",
  },
] as const;

describe('a global read where another declaration gives its name', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /**
   * Where `found` says a node of the module `lines` reads what it looks for, `line:text`, walked
   * as a shared module's checks walk it: past what is erased (`isErased`).
   */
  function foundIn(lines: readonly string[], found: (node: Node) => boolean): readonly string[] {
    const source = `${lines.join('\n')}\n`;
    using parsed = api.createSourceFile('shadowed.ts', source);
    const { sourceFile } = parsed;
    const reads: string[] = [];
    const visit = (node: Node): void => {
      if (isErased(node)) {
        return;
      }
      if (found(node)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        reads.push(`${String(line + 1)}:${source.slice(node.getStart(sourceFile), node.end)}`);
      }
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
    return reads;
  }

  it.each(CASES)('makes code of text: $what', ({ lines, reads }) => {
    expect(foundIn(lines, (node) => readsCodeGlobal(node))).toStrictEqual(reads);
  });

  it('hands on a global whose member answers otherwise', () => {
    const lines = [
      "export const pick = () => Reflect.get(Math, 'random');",
      'function unrelated(Math: unknown) {',
      '  return Math;',
      '}',
    ];
    const reached = new Set(['Math.random']);

    expect(foundIn(lines, (node) => handedGlobal(node, reached) !== undefined)).toStrictEqual([
      '1:Math',
    ]);
  });
});
