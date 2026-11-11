import type { Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkServerNode } from '../src/compiler/prefix.ts';

/**
 * Node runs the authority's program with its types stripped, and nothing more: it refuses a
 * `namespace` or `module` that holds anything but types — `interface`s, type aliases and namespaces
 * of those — with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, as it refuses an `enum` and a parameter
 * property, and an `import … =` and an `export =` written in a function with
 * `ERR_INVALID_TYPESCRIPT_SYNTAX`; it runs a `declare`d namespace and a namespace of types alone.
 * Each row is the server part's code, written in a function's body, where it is, and whether the
 * compiler refuses it. Node 24.22 ran each row's code as it is written; the namespace, alias and
 * `export =` rows ran on 24.14 and 26.13 too, with the same answers.
 */
const CASES: readonly {
  readonly code: string;
  readonly refusal: string | undefined;
  readonly what: string;
}[] = [
  {
    code: 'namespace N { export const x = 1 }',
    refusal: 'namespace',
    what: 'a namespace of a value',
  },
  {
    code: 'module M { export const x = 1 }',
    refusal: 'namespace',
    what: 'a module of a value',
  },
  {
    code: 'function f() { namespace N { export const x = 1 } }',
    refusal: 'namespace',
    what: 'a namespace in a function',
  },
  {
    code: 'const f = () => { namespace N { export const x = 1 } };',
    refusal: 'namespace',
    what: 'a namespace in an arrow function',
  },
  {
    code: 'class C { m() { namespace N { export const x = 1 } } }',
    refusal: 'namespace',
    what: 'a namespace in a method',
  },
  {
    code: 'namespace A.B { export const x = 1 }',
    refusal: 'namespace',
    what: 'a dotted namespace of a value',
  },
  {
    code: 'namespace N { export class C {} }',
    refusal: 'namespace',
    what: 'a namespace of a class',
  },
  {
    code: 'namespace N { export function f() {} }',
    refusal: 'namespace',
    what: 'a namespace of a function',
  },
  {
    code: 'namespace N { export namespace M { export const x = 1 } }',
    refusal: 'namespace',
    what: 'a namespace of a namespace of a value',
  },
  {
    code: 'namespace N { declare const x: number }',
    refusal: 'namespace',
    what: 'a namespace that declares a value',
  },
  {
    code: 'namespace N { declare namespace M { const x: number } }',
    refusal: 'namespace',
    what: 'a namespace that declares a namespace',
  },
  { code: 'import X = Y.Z;', refusal: 'import', what: 'an import alias' },
  { code: 'import type X = Y.Z;', refusal: 'import', what: 'a type-only import alias' },
  { code: "import fs = require('node:fs');", refusal: 'import', what: 'an import of require' },
  { code: 'export = q;', refusal: 'export', what: 'an export assignment' },
  {
    code: 'namespace N { export type T = 1; export interface I { a: T } }',
    refusal: undefined,
    what: 'a namespace of types',
  },
  { code: 'namespace N {}', refusal: undefined, what: 'an empty namespace' },
  {
    code: 'namespace A.B.C { export interface I {} }',
    refusal: undefined,
    what: 'a dotted namespace of types',
  },
  {
    code: 'namespace A { export namespace B { export type T = 1 } }',
    refusal: undefined,
    what: 'a namespace of a namespace of types',
  },
  {
    code: 'module M { export interface I {} }',
    refusal: undefined,
    what: 'a module of types',
  },
  {
    code: 'namespace N { export declare type T = 1 }',
    refusal: undefined,
    what: 'a namespace of a declared type',
  },
  {
    code: 'namespace N { declare namespace M { type T = 1 } }',
    refusal: undefined,
    what: 'a namespace of a declared namespace of types',
  },
  {
    code: 'declare namespace N { const x: number; namespace M { const y: 1 } }',
    refusal: undefined,
    what: 'a declared namespace, and what it holds',
  },
  {
    code: "declare module 'x' { export const y: number }",
    refusal: undefined,
    what: 'a declared module',
  },
  {
    code: 'namespace N { declare namespace M { import A = Y.Z } }',
    refusal: 'namespace',
    what: 'a namespace of a declared namespace of an import alias',
  },
  {
    code: 'namespace N { import A = Y.Z }',
    refusal: 'namespace',
    what: 'a namespace of an import alias',
  },
  {
    code: 'declare namespace N { import A = Y.Z }',
    refusal: undefined,
    what: 'a declared namespace of an import alias',
  },
  {
    code: "declare module 'x' { import A = require('y'); export = A }",
    refusal: undefined,
    what: 'a declared module of an import and an export assignment',
  },
  {
    code: 'declare namespace N { namespace M { import A = Y.Z } }',
    refusal: undefined,
    what: 'a namespace in a declared namespace, of an import alias',
  },
  { code: 'enum E { A }', refusal: 'enum', what: 'an enum' },
  {
    code: 'class C { constructor(private z: number) {} }',
    refusal: 'parameter property',
    what: 'a parameter property',
  },
  { code: 'const x = 1;', refusal: undefined, what: 'plain code' },
];

const REFUSED = CASES.flatMap(({ code, refusal: reason, what }) =>
  reason === undefined ? [] : [{ code, reason, what }],
);
const ACCEPTED = CASES.flatMap(({ code, refusal: reason, what }) =>
  reason === undefined ? [{ code, what }] : [],
);

describe('what the server part holds that Node cannot run with its types stripped', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The reason `checkServerNode` first refuses somewhere in a function whose body is `code`. */
  function refusal(code: string): string | undefined {
    using parsed = api.createSourceFile('strippable.ts', `function frames() {\n${code}\n}\n`);
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
