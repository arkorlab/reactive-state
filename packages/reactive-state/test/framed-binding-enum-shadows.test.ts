import {
  type ElementAccessExpression,
  type Identifier,
  isElementAccessExpression,
  isIdentifier,
  type Node,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { frameDeclarationOf, frameMemberName } from '../src/compiler/framed-bindings.ts';

/**
 * An enum, a namespace or an `import … =` alias gives its name a value of its own in the scope that
 * holds it, as a constant does: a read of the name there is of that value, which the constant of
 * the same name around it does not answer. So the key `value[key]` reads is none the code fixes,
 * and no declaration is the name's. The rows marked a pin answer the same before the change as
 * after it.
 */

const CASES = [
  {
    source: "const key = '1'; { enum key { A } value[key]; }",
    what: 'an enum of a block',
  },
  {
    source: "const key = '1'; { enum key { A } value[Number(key)]; }",
    what: 'an enum of a block, a key computed of it',
  },
  {
    source: "const key = '1'; function read() { enum key { A } return value[key]; }",
    what: 'an enum of a function’s body',
  },
  {
    source: "const key = '1'; switch (kind) { case 0: enum key { A } value[key]; }",
    what: 'an enum of a switch’s cases',
  },
  {
    source: "const key = '1'; { value[key]; enum key { A } }",
    what: 'an enum declared after its read',
  },
  {
    source: "const key = '1'; { const enum key { A } value[key]; }",
    what: 'a const enum of a block',
  },
  {
    source:
      "const key = '1'; namespace Outer { namespace key { export const own = 2; } value[key]; }",
    what: 'a namespace of a namespace’s body',
  },
  {
    source: "const key = '1'; namespace Outer { import key = Other.key; value[key]; }",
    what: 'an import alias of a namespace’s body',
  },
  {
    source: "const key = '1'; namespace Outer { enum key { A } value[key]; }",
    what: 'an enum of a namespace’s body',
  },
] as const;

const PINS = [
  { source: "const key = '1'; { value[key]; }", what: 'a block that declares nothing (pin)' },
  {
    source: "const key = '1'; { enum other { A } value[key]; }",
    what: 'an enum of another name (pin)',
  },
  {
    source: "const key = '1'; { enum key { A } } { value[key]; }",
    what: 'an enum of a block beside it (pin)',
  },
  {
    source: "const key = '1'; { interface key { own: 2 } value[key]; }",
    what: 'an interface of the name, which has no value (pin)',
  },
  {
    source: "const key = '1'; { type key = 2; value[key]; }",
    what: 'a type alias of the name, which has no value (pin)',
  },
  {
    source: "const key = '1'; namespace Outer { import type key = Other.key; value[key]; }",
    what: 'a type import alias of the name (pin)',
  },
  {
    source: "const key = '1'; namespace Outer { enum other { A } value[key]; }",
    what: 'an enum of another name in a namespace (pin)',
  },
  {
    source: "declare module 'key' {} const key = '1'; value[key];",
    what: 'a module the code names by text (pin)',
  },
] as const;

describe('a read of a name an enum, a namespace or an import alias declares', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /**
   * What `value[…]`, the last read of a key in `source`, records as its member, and the declaration
   * of the name `key` it reads, if any.
   */
  function readOf(source: string): {
    readonly declared: boolean;
    readonly member: string | undefined;
  } {
    using parsed = api.createSourceFile(
      'framed-bindings.ts',
      `declare const value: Record<string, unknown>; declare const kind: number; ${source}`,
    );
    let read: ElementAccessExpression | undefined;
    const find = (node: Node): void => {
      if (isElementAccessExpression(node)) read = node;
      node.forEachChild(find);
    };
    find(parsed.sourceFile);
    if (read === undefined) throw new Error(`No key is read in ${source}.`);
    let name: Identifier | undefined;
    const named = (node: Node): void => {
      if (name === undefined && isIdentifier(node) && node.text === 'key') name = node;
      node.forEachChild(named);
    };
    named(read.argumentExpression);
    if (name === undefined) throw new Error(`No \`key\` is read in ${source}.`);
    return { declared: frameDeclarationOf(name) !== undefined, member: frameMemberName(read) };
  }

  it.each(CASES)('$what', ({ source }) => {
    expect(readOf(source)).toStrictEqual({ declared: false, member: undefined });
  });

  it.each(PINS)('$what', ({ source }) => {
    expect(readOf(source)).toStrictEqual({ declared: true, member: '1' });
  });
});
