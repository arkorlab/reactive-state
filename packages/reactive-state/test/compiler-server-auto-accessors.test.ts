import type { Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkServerNode } from '../src/compiler/prefix.ts';

/**
 * Node strips the types of the authority's program and keeps an `accessor` field as it is written,
 * which no JavaScript engine parses yet: `class C { accessor x = 1 }` fails to load with `SyntaxError:
 * Unexpected identifier 'x'` — a `static` one, one of a computed or a private name, a `private` or an
 * `override` one, in a class expression or in a class within a function or a method, as `node` runs
 * it and `stripTypeScriptTypes` writes it (24.14.1, 24.22.1 and 26.13.0 answered alike). Stripping
 * removes it where it is erased: within a `declare`d class or namespace, and as an `abstract` member.
 * A `declare` written on the field alone does not (`SyntaxError: Unexpected token 'accessor'`). Each
 * row is the server part's code, written in a function's body, and whether the compiler refuses it.
 */
const REFUSED: readonly { readonly code: string; readonly what: string }[] = [
  { code: 'class C { accessor x = 1 }', what: 'an accessor field' },
  { code: 'class C { accessor x; }', what: 'an accessor field of no value' },
  { code: 'class C { accessor x: number = 1 }', what: 'a typed accessor field' },
  { code: 'class C { static accessor x = 1 }', what: 'a static accessor field' },
  { code: "class C { accessor ['x'] = 1 }", what: 'an accessor field of a computed name' },
  { code: 'class C { accessor #x = 1 }', what: 'an accessor field of a private name' },
  { code: 'class C { private accessor x = 1 }', what: 'a private accessor field' },
  { code: 'class C extends B { override accessor x = 2 }', what: 'an override accessor field' },
  { code: 'class C { declare accessor x: number }', what: 'an accessor field declared on its own' },
  { code: 'const C = class { accessor x = 1 };', what: 'an accessor field of a class expression' },
  { code: 'const f = () => class { accessor x = 1 };', what: 'a class expression in an arrow' },
  {
    code: 'function f() { class C { accessor x = 1 } }',
    what: 'an accessor field of a class in a function',
  },
  {
    code: 'class A { m() { class C { accessor x = 1 } } }',
    what: 'an accessor field of a class in a method',
  },
  {
    code: 'class A { static { class C { accessor x = 1 } } }',
    what: 'an accessor field of a class in a static block',
  },
  {
    code: 'class A { f = class { accessor x = 1 }; }',
    what: 'an accessor field of a class in a field',
  },
  {
    code: 'abstract class C { abstract accessor x: number; accessor y = 1 }',
    what: 'an accessor field beside an abstract one',
  },
  {
    code: 'declare class D { accessor x: number } class C { accessor x = 1 }',
    what: 'an accessor field beside a declared class',
  },
];

const ACCEPTED: readonly { readonly code: string; readonly what: string }[] = [
  { code: 'declare class C { accessor x: number }', what: 'an accessor field of a declared class' },
  {
    code: 'declare class C { static accessor x: number }',
    what: 'a static accessor field of a declared class',
  },
  {
    code: 'declare namespace N { class C { accessor x: number } }',
    what: 'an accessor field of a class in a declared namespace',
  },
  {
    code: 'declare namespace N { namespace M { class C { accessor x: number } } }',
    what: 'an accessor field of a class in a namespace of a declared one',
  },
  {
    code: 'abstract class C { abstract accessor x: number }',
    what: 'an abstract accessor field',
  },
  {
    code: 'abstract class C { protected abstract accessor x: number }',
    what: 'a protected abstract accessor field',
  },
  { code: 'class C { accessor = 1 }', what: 'a field named accessor' },
  { code: 'class C { accessor; }', what: 'a field named accessor of no value' },
  { code: 'class C { accessor: number = 1 }', what: 'a typed field named accessor' },
  { code: 'class C { static accessor = 1 }', what: 'a static field named accessor' },
  { code: 'class C { accessor() { return 1; } }', what: 'a method named accessor' },
  { code: 'class C { get accessor() { return 1; } }', what: 'a getter named accessor' },
  { code: 'class C { accessor\n x = 1 }', what: 'a field named accessor before another' },
  {
    code: 'class C { #x = 1; get x() { return this.#x; } }',
    what: 'a getter over a private field',
  },
];

describe('the server part holds no auto-accessor Node would fail to load', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The reason `checkServerNode` first refuses somewhere in a function whose body is `code`. */
  function refusal(code: string): string | undefined {
    using parsed = api.createSourceFile('auto-accessors.ts', `function frames() {\n${code}\n}\n`);
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

  it.each(REFUSED)('refuses $what', ({ code }) => {
    expect(refusal(code)).toContain('`accessor`');
  });

  it.each(ACCEPTED)('takes $what', ({ code }) => {
    expect(refusal(code)).toBeUndefined();
  });
});
