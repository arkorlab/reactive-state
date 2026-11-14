import {
  type Expression,
  type GetAccessorDeclaration,
  isArrowFunction,
  isFunctionExpression,
  isGetAccessorDeclaration,
  type Node,
  type SourceFile,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedReceiverDispatch } from '../src/compiler/framed-at-methods.ts';
import { getterWrites } from '../src/compiler/framed-getter-writes.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * The class a method or a getter defines binds a `this` of its own for its members, but not for the
 * expression it extends: that is read where the class stands, with the `this` of the code around it
 * (ECMA-262, ClassDefinitionEvaluation), so a write or a read through it is the method's own.
 */
const PRELUDE =
  'declare const Base: any; declare function make<T = unknown>(...rest: unknown[]): any;';

const DISPATCH = [
  { id: 'this-read', body: 'class Derived extends this.Base {} return Derived;', dispatches: true },
  {
    id: 'this-written',
    body: 'class Derived extends (this.kept = 1, Base) {} return Derived;',
    dispatches: true,
  },
  {
    id: 'this-in-a-call-argument',
    body: 'class Derived extends make(this) {} return Derived;',
    dispatches: true,
  },
  {
    id: 'this-with-type-arguments',
    body: 'class Derived extends this.Base<string> {} return Derived;',
    dispatches: true,
  },
  {
    id: 'this-in-a-class-expression',
    body: 'return class extends this.Base {};',
    dispatches: true,
  },
  {
    id: 'this-in-a-nested-class',
    body: 'class Outer extends Base { member = class extends this.Base {}; } return Outer;',
    dispatches: false,
  },
  {
    id: 'a-class-of-its-own-this-pin',
    body: 'class Derived extends Base { read() { return this; } } return Derived;',
    dispatches: false,
  },
  {
    id: 'a-field-of-its-own-this-pin',
    body: 'class Derived extends Base { held = this; } return Derived;',
    dispatches: false,
  },
  {
    id: 'a-name-pin',
    body: 'class Derived extends Base {} return Derived;',
    dispatches: false,
  },
] as const;

describe('a method that names its this in the extends clause of a class', () => {
  it.each(DISPATCH)('$id', ({ body, dispatches }) => {
    const source = `${PRELUDE} const method = function () { ${body} };`;

    expect(receiverDispatched(source)).toBe(dispatches);
  });

  it('an arrow has no this to name', () => {
    const source = `${PRELUDE} const method = () => { class Derived extends this.Base {} return Derived; };`;

    expect(receiverDispatched(source)).toBe(false);
  });
});

const GETTERS = [
  {
    id: 'this-written',
    body: 'class Derived extends (this.kept = 1, Base) {} return Derived;',
    writes: 1,
  },
  {
    id: 'this-written-in-a-class-expression',
    body: 'return class extends (this.kept = 1, Base) {};',
    writes: 1,
  },
  {
    id: 'this-written-with-type-arguments',
    body: 'class Derived extends (this.kept = 1, make)<string> {} return Derived;',
    writes: 1,
  },
  { id: 'this-read', body: 'class Derived extends this.Base {} return Derived;', writes: 0 },
  {
    id: 'this-given-on',
    body: 'class Derived extends make(this) {} return Derived;',
    writes: undefined,
  },
  {
    id: 'super-read',
    body: 'class Derived extends super.Base {} return Derived;',
    writes: undefined,
  },
  {
    id: 'a-class-of-its-own-this-pin',
    body: 'class Derived extends Base { write() { this.kept = 1; } } return Derived;',
    writes: 0,
  },
  {
    id: 'a-field-of-its-own-this-pin',
    body: 'class Derived extends Base { held = (this.kept = 1); } return Derived;',
    writes: 0,
  },
  { id: 'a-name-pin', body: 'class Derived extends Base {} return Derived;', writes: 0 },
  {
    id: 'a-name-with-type-arguments-pin',
    body: 'class Derived extends Base<string> {} return Derived;',
    writes: 0,
  },
] as const;

describe('a getter that writes through its this in the extends clause of a class', () => {
  it.each(GETTERS)('$id', ({ body, writes }) => {
    const source = `${PRELUDE} const object = { get total() { ${body} } };`;

    expect(writesOf(source)).toBe(writes);
  });
});

function inModule<T>(source: string, read: (file: SourceFile) => T): T {
  using api = openTypeScript();
  using parsed = parseModule(api, 'heritage.ts', source);
  return read(parsed.sourceFile);
}

function receiverDispatched(source: string): boolean {
  return inModule(source, (file) => {
    return framedReceiverDispatch(
      find(file, (node): node is Expression => isFunctionExpression(node) || isArrowFunction(node)),
      () => false,
    );
  });
}

function writesOf(source: string): number | undefined {
  return inModule(source, (file) => {
    return getterWrites(
      find(file, (node): node is GetAccessorDeclaration => isGetAccessorDeclaration(node)),
    )?.length;
  });
}

function find<T extends Node>(root: Node, matches: (node: Node) => node is T): T {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (matches(node)) return node;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no such node');
}
