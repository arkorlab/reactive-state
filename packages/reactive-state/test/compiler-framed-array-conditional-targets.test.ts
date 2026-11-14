import { type Expression, isCallExpression, isIdentifier, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedArrayString } from '../src/compiler/framed-arrays.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A native mutator that may write an array writes it through any of the targets its first argument
 * may stand for, a condition, a logical operand, a comma, an assignment, the result of another
 * mutator: what it is given to copy from is read in a form the compile follows, or the read is
 * refused, as for a direct target.
 */
const HEAD =
  "function frames(error: Error, flag: boolean, opaque: () => object) { const list: unknown[] = ['safe']; const other: unknown[] = [];";

const CASES = [
  {
    id: 'assign-to-a-condition-with-an-opaque-source',
    source: `${HEAD} Object.assign(flag ? list : other, opaque()); return String(list); }`,
    converts: true,
  },
  {
    id: 'assign-to-a-condition-with-the-array-last',
    source: `${HEAD} Object.assign(flag ? other : list, opaque()); return String(list); }`,
    converts: true,
  },
  {
    id: 'assign-to-a-logical-operand-with-an-opaque-source',
    source: `${HEAD} Object.assign(flag && list, opaque()); return String(list); }`,
    converts: true,
  },
  {
    id: 'assign-to-a-fallback-with-an-opaque-source',
    source: `${HEAD} Object.assign(other || list, opaque()); return String(list); }`,
    converts: true,
  },
  {
    id: 'assign-to-a-comma-with-an-opaque-source',
    source: `${HEAD} Object.assign((0, list), opaque()); return String(list); }`,
    converts: true,
  },
  {
    id: 'assign-to-an-assignment-with-an-opaque-source',
    source: `${HEAD} let held: unknown; Object.assign((held = list), opaque()); return String(list); }`,
    converts: true,
  },
  {
    id: 'assign-to-the-result-of-another-assign-with-an-opaque-source',
    source: `${HEAD} Object.assign(Object.assign(list, {}), opaque()); return String(list); }`,
    converts: true,
  },
  {
    id: 'assign-to-a-fill-with-an-opaque-source',
    source: `${HEAD} Object.assign(list.fill(0), opaque()); return String(list); }`,
    converts: true,
  },
  {
    id: 'assign-through-a-bound-call-to-a-condition',
    source: `${HEAD} Object.assign.call(null, flag ? list : other, opaque()); return String(list); }`,
    converts: true,
  },
  {
    id: 'define-properties-to-a-condition-with-an-opaque-map',
    source: `${HEAD} Object.defineProperties(flag ? list : other, opaque()); return String(list); }`,
    converts: true,
  },
  {
    id: 'define-property-to-a-condition-with-an-opaque-descriptor',
    source: `${HEAD} Object.defineProperty(flag ? list : other, 0, opaque()); return String(list); }`,
    converts: true,
  },
  {
    id: 'assign-to-the-array-with-an-opaque-source-pin',
    source: `${HEAD} Object.assign(list, opaque()); return String(list); }`,
    converts: true,
  },
  {
    id: 'assign-to-another-array-with-an-opaque-source-pin',
    source: `${HEAD} Object.assign(other, opaque()); return String(list); }`,
    converts: false,
  },
  {
    id: 'assign-to-a-condition-of-others-with-an-opaque-source-pin',
    source: `${HEAD} Object.assign(flag ? other : {}, opaque()); return String(list); }`,
    converts: false,
  },
  {
    id: 'assign-to-a-condition-with-a-written-source-refused',
    source: `${HEAD} Object.assign(flag ? list : other, { a: 1 }); return String(list); }`,
    converts: true,
  },
] as const;

describe('a source given to a mutator whose target may be an array', () => {
  it.each(CASES)('$id', ({ source, converts }) => {
    expect(convertsError(source)).toBe(converts);
  });
});

/** Whether the source's `String(array)` converts the `error` element, or is refused. */
function convertsError(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'conditional-targets.ts', source);
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
