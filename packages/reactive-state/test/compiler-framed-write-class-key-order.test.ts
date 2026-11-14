import {
  type Identifier,
  isIdentifier,
  isPropertyDeclaration,
  isVoidExpression,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedAssignedValues } from '../src/compiler/framed-writes.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A write to a variable can supply it at a read that is written before the write, where the write
 * runs first. A class evaluates the computed keys of all its members before it runs any static
 * initializer or static block, though they are written after: a write in a key supplies a read in
 * a static initializer. A write in a static initializer written after the read, in a key of another
 * class and to another variable, and a key that writes nothing, supply no read there. A key of a
 * method or an accessor, and a read in a static block, belong to owners of their own: those are
 * counted as possible already.
 */
const DECLARATION = 'declare const a: unknown; declare const b: unknown; let x: unknown = a;';
const WRITE = "[(x = b, 'k')]";

const CASES = [
  {
    id: 'reviewed-write-in-a-key-after-a-static-field',
    source: `${DECLARATION} class C { static y = x; ${WRITE} = 0; } void C;`,
    values: ['b'],
  },
  {
    id: 'write-in-a-method-key-after-a-static-field-pin',
    source: `${DECLARATION} class C { static y = x; static ${WRITE}() { return 0; } } void C;`,
    values: ['b'],
  },
  {
    id: 'write-in-an-accessor-key-after-a-static-field-pin',
    source: `${DECLARATION} class C { static y = x; get ${WRITE}() { return 0; } } void C;`,
    values: ['b'],
  },
  {
    id: 'write-in-a-key-after-a-static-block-pin',
    source: `${DECLARATION} class C { static { void x; } ${WRITE} = 0; } void C;`,
    values: ['b'],
  },
  {
    id: 'write-in-a-key-of-a-class-expression',
    source: `${DECLARATION} const C = class { static y = x; ${WRITE} = 0; }; void C;`,
    values: ['b'],
  },
  {
    id: 'write-in-a-key-of-the-outer-class',
    source: `${DECLARATION} class Outer { static Nested = class { static y = x; }; ${WRITE} = 0; } void Outer;`,
    values: ['b'],
  },
  {
    id: 'logical-write-in-a-key-after-a-static-field',
    source: `${DECLARATION} class C { static y = x; [(x ||= b, 'k')] = 0; } void C;`,
    values: ['b'],
  },
  {
    id: 'write-in-a-key-before-the-static-field-pin',
    source: `${DECLARATION} class C { ${WRITE} = 0; static y = x; } void C;`,
    values: ['b'],
  },
  {
    id: 'write-in-a-static-field-after-the-read-pin',
    source: `${DECLARATION} class C { static y = x; static z = (x = b); } void C;`,
    values: [],
  },
  {
    id: 'write-in-a-key-of-another-class-pin',
    source: `${DECLARATION} class C { static y = x; } class D { ${WRITE} = 0; } void C; void D;`,
    values: [],
  },
  {
    id: 'write-to-another-variable-in-a-key-pin',
    source: `${DECLARATION} let w: unknown = a; class C { static y = x; [(w = b, 'k')] = 0; } void C; void w;`,
    values: [],
  },
  {
    id: 'key-that-writes-nothing-pin',
    source: `${DECLARATION} class C { static y = x; ['k'] = 0; } void C;`,
    values: [],
  },
];

/** The reads of `x` in `root` by a walk of its tree: a static field's initializer, or `void x`. */
function reads(root: Node): readonly Identifier[] {
  const names: Identifier[] = [];
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isIdentifier(node) && node.text === 'x' && isRead(node)) names.push(node);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return names;
}

/** Whether `name` is the whole initializer of a field, or the operand of a `void`. */
function isRead(name: Identifier): boolean {
  const { parent } = name;
  return (isPropertyDeclaration(parent) && parent.initializer === name) || isVoidExpression(parent);
}

describe('the writes that supply a read in a static initializer', () => {
  it.each(CASES)('$id', ({ source, values }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'write-class-key-order.ts', source);
    const found = reads(parsed.sourceFile).map((name) =>
      framedAssignedValues(name).map((each) => each.getText()),
    );

    expect(found).toStrictEqual([values]);
  });
});
