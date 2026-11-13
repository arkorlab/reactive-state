import { type Expression, isCallExpression, isIdentifier, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedArrayString } from '../src/compiler/framed-arrays.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A write that holds a read among its operands makes its change after the read: `a.push(String(a),
 * error)` reads the array as it was. Where a loop, or a function that is called again, brings the
 * write back to the read, or the array is not made by each run, the earlier write may reach it.
 */
const HEAD = "function frames(error: Error) { const a: unknown[] = ['safe'];";

const CASES = [
  {
    id: 'push-after-a-read-in-its-arguments',
    source: `${HEAD} a.push(String(a), error); return a; }`,
    converts: false,
  },
  {
    id: 'unshift-after-a-read-in-its-arguments',
    source: `${HEAD} a.unshift(String(a), error); return a; }`,
    converts: false,
  },
  {
    id: 'splice-after-a-read-in-its-arguments',
    source: `${HEAD} a.splice(1, 0, String(a), error); return a; }`,
    converts: false,
  },
  {
    id: 'assign-after-a-read-in-its-source',
    source: `${HEAD} Object.assign(a, { 1: String(a), 2: error }); return a; }`,
    converts: false,
  },
  {
    id: 'define-property-after-a-read-in-its-descriptor',
    source: `${HEAD} Object.defineProperty(a, 1, { value: (String(a), error) }); return a; }`,
    converts: false,
  },
  {
    id: 'assignment-after-a-read-in-its-right',
    source: `${HEAD} a[1] = (String(a), error); return a; }`,
    converts: false,
  },
  {
    id: 'nested-call-after-a-read-in-its-arguments',
    source: `${HEAD} a.push(...[String(a), error]); return a; }`,
    converts: false,
  },
  {
    id: 'read-before-an-enclosing-write-in-a-condition',
    source: `${HEAD} a.push(String(a) === '' ? error : error); return a; }`,
    converts: false,
  },
  {
    id: 'push-in-a-loop-pin',
    source: `${HEAD} for (let at = 0; at < 2; at += 1) { a.push(String(a), error); } return a; }`,
    converts: true,
  },
  {
    id: 'push-in-a-while-loop-pin',
    source: `${HEAD} let at = 0; while (at < 2) { a.push(String(a), error); at += 1; } return a; }`,
    converts: true,
  },
  {
    id: 'push-in-a-called-function-pin',
    source: `${HEAD} function add() { a.push(String(a), error); } add(); add(); return a; }`,
    converts: true,
  },
  {
    id: 'push-after-the-read-pin',
    source: `${HEAD} String(a); a.push(error); return a; }`,
    converts: false,
  },
  {
    id: 'push-before-the-read-pin',
    source: `${HEAD} a.push(error); String(a); return a; }`,
    converts: true,
  },
  {
    id: 'push-with-a-later-closure-pin',
    source: `${HEAD} a.push(error, () => String(a)); return a; }`,
    converts: true,
  },
  {
    id: 'array-made-in-each-pass-of-a-loop',
    source: `${HEAD} for (let at = 0; at < 2; at += 1) { const b: unknown[] = ['safe']; b.push(String(b), error); } return a; }`,
    converts: false,
  },
] as const;

describe('a read among the operands of a write', () => {
  it.each(CASES)('$id', ({ source, converts }) => {
    expect(convertsError(source)).toBe(converts);
  });
});

/** Whether a `String(…)` of the source converts the `error` element of its array. */
function convertsError(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'operand-reads.ts', source);
  const words = {
    error: (value: Expression, keys?: readonly string[]) => {
      const each = unwrapped(value);
      return (
        (keys === undefined || keys.length === 0) && isIdentifier(each) && each.text === 'error'
      );
    },
    typed: () => false,
  };
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === 'String' &&
      framedArrayString(node.arguments[0], words, node)
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
