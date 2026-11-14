import type { Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkServerNode } from '../src/compiler/prefix.ts';

/**
 * Node erases what a `declare` marks, whole, and with it the `enum`s and the decorators written
 * within: `declare enum E { A }`, an `enum` in a `declare`d namespace, module or `global`, and a
 * decorator on a member of a `declare`d class or on a class in a `declare`d namespace run as if
 * they were not written (Node 24.14, 24.22 and 26.13 ran each row's code as it is written, in a
 * function). What is not ambient it refuses as before: an `enum`, a decorator, a parameter property;
 * a parameter property even in a `declare`d class, and the decorator written before a `declare`d
 * class itself. Each row is the server part's code in a function's body, and whether the compiler
 * refuses it, and for what.
 */
const REFUSED: readonly {
  readonly code: string;
  readonly reason: string;
  readonly what: string;
}[] = [
  { code: 'enum E { A }', reason: 'enum', what: 'an enum' },
  { code: 'const enum E { A }', reason: 'enum', what: 'a const enum' },
  { code: 'namespace N { enum E { A } }', reason: 'namespace', what: 'an enum in a namespace' },
  {
    code: 'declare enum E { A } enum F { B }',
    reason: 'enum',
    what: 'an enum beside a declared one',
  },
  {
    code: 'declare namespace N { enum E { A } } enum F { B }',
    reason: 'enum',
    what: 'an enum beside a declared namespace',
  },
  {
    code: 'declare class C { constructor(private x: number); }',
    reason: 'parameter property',
    what: 'a parameter property of a declared class',
  },
  {
    code: 'declare namespace N { class C { constructor(public readonly x: number); } }',
    reason: 'parameter property',
    what: 'a parameter property of a class in a declared namespace',
  },
  {
    code: 'class C { @dec m() {} }',
    reason: 'decorator',
    what: 'a decorator of a method',
  },
  {
    code: 'declare const dec: any; @dec declare class C {}',
    reason: 'decorator',
    what: 'a decorator written before a declared class',
  },
  {
    code: 'declare class D { m(): void; } class C { @dec m() {} }',
    reason: 'decorator',
    what: 'a decorator beside a declared class',
  },
];

const ACCEPTED: readonly { readonly code: string; readonly what: string }[] = [
  { code: 'declare enum E { A }', what: 'a declared enum' },
  { code: 'declare enum E { A = 1, B }', what: 'a declared enum with values' },
  { code: 'declare const enum E { A }', what: 'a declared const enum' },
  { code: 'declare namespace N { enum E { A } }', what: 'an enum in a declared namespace' },
  {
    code: 'declare namespace N { const enum E { A } }',
    what: 'a const enum in a declared namespace',
  },
  {
    code: 'declare namespace N { export enum E { A } }',
    what: 'an exported enum in a declared namespace',
  },
  {
    code: 'declare namespace N { namespace M { enum E { A } } }',
    what: 'an enum in a namespace within a declared one',
  },
  {
    code: 'declare namespace N.M { enum E { A } }',
    what: 'an enum in a dotted declared namespace',
  },
  { code: 'declare module M { enum E { A } }', what: 'an enum in a declared module' },
  { code: 'declare global { enum E { A } }', what: 'an enum in a declared global' },
  {
    code: 'declare class C { @dec m(): void; }',
    what: 'a decorator of a method of a declared class',
  },
  {
    code: 'declare class C { @dec p: number; }',
    what: 'a decorator of a field of a declared class',
  },
  {
    code: 'declare class C { constructor(@dec x: number); }',
    what: 'a decorator of a parameter of a declared class',
  },
  {
    code: 'declare namespace N { class C { @dec m(): void; } }',
    what: 'a decorator of a method of a class in a declared namespace',
  },
  {
    code: 'declare namespace N { @dec class C {} }',
    what: 'a decorator of a class in a declared namespace',
  },
  {
    code: 'declare module M { @dec class C {} }',
    what: 'a decorator of a class in a declared module',
  },
];

describe('what the server part holds within a declare that Node erases whole', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The reason `checkServerNode` first refuses somewhere in a function whose body is `code`. */
  function refusal(code: string): string | undefined {
    using parsed = api.createSourceFile(
      'strippable-ambient.ts',
      `function frames() {\n${code}\n}\n`,
    );
    const pending: Node[] = [parsed.sourceFile];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      try {
        checkServerNode(node, new Set(), (reason) => {
          throw new Error(reason);
        });
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      node.forEachChild((child) => {
        pending.push(child);
      });
    }
    return undefined;
  }

  it.each(REFUSED)('refuses $what', ({ code, reason }) => {
    expect(refusal(code)).toContain(reason);
  });

  it.each(ACCEPTED)('takes $what', ({ code }) => {
    expect(refusal(code)).toBeUndefined();
  });
});
