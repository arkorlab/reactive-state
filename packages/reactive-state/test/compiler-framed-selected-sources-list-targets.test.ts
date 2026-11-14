import {
  type Expression,
  isCallExpression,
  isIdentifier,
  isSpreadElement,
  type Node,
  type SpreadElement,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedArrayString } from '../src/compiler/framed-arrays.ts';
import { writtenList } from '../src/compiler/framed-selected-sources.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A list a spread copies is the list its literal wrote only where nothing but a read mentions it:
 * an element, a rest, a default or a loop variable of a pattern is written to, as an assignment is.
 */
const HEAD = "function frames(error: any) { const list: any[] = ['safe'];";

const CASES = [
  {
    id: 'none-pin',
    source: `${HEAD}  return [...list]; }`,
    written: true,
  },
  {
    id: 'plain-assignment',
    source: `${HEAD} list[0] = error; return [...list]; }`,
    written: false,
  },
  {
    id: 'array-pattern-element',
    source: `${HEAD} [list[0]] = [error]; return [...list]; }`,
    written: false,
  },
  {
    id: 'object-pattern-entry',
    source: `${HEAD} ({ x: list[0] } = { x: error }); return [...list]; }`,
    written: false,
  },
  {
    id: 'pattern-default',
    source: `${HEAD} [list[0] = 'd'] = [error]; return [...list]; }`,
    written: false,
  },
  {
    id: 'for-of-head',
    source: `${HEAD} for (list[0] of [error]) { } return [...list]; }`,
    written: false,
  },
  {
    id: 'for-in-head',
    source: `${HEAD} for (list[0] in { k: 1 }) { } return [...list]; }`,
    written: false,
  },
  {
    id: 'nested-array-pattern',
    source: `${HEAD} [[list[0]]] = [[error]]; return [...list]; }`,
    written: false,
  },
  {
    id: 'object-rest',
    source: `${HEAD} ({ ...list[0] } = { value: error }); return [...list]; }`,
    written: false,
  },
  {
    id: 'array-rest',
    source: `${HEAD} [...list[0]] = [error]; return [...list]; }`,
    written: false,
  },
  {
    id: 'parenthesized-element',
    source: `${HEAD} [(list[0])] = [error]; return [...list]; }`,
    written: false,
  },
  {
    id: 'computed-element',
    source: `${HEAD} const at = 0; [list[at]] = [error]; return [...list]; }`,
    written: false,
  },
  {
    id: 'length-in-a-pattern',
    source: `${HEAD} [list.length] = [0]; return [...list]; }`,
    written: false,
  },
  {
    id: 'method-in-a-pattern',
    source: `${HEAD} [list.push] = [() => 0]; return [...list]; }`,
    written: false,
  },
  {
    id: 'whole-list-in-a-pattern',
    source: `${HEAD} [list] = [[error]]; return [...list]; }`,
    written: false,
  },
  {
    id: 'read-of-an-element-pin',
    source: `${HEAD} const copy = list[0]; void copy; return [...list]; }`,
    written: true,
  },
  {
    id: 'pattern-target-of-another-list-pin',
    source: `${HEAD} const other: any[] = []; [other[0]] = [error]; return [...list]; }`,
    written: true,
  },
  {
    id: 'pattern-target-in-a-field-of-an-element',
    source: `${HEAD} const box: any = {}; [list[0].field] = [error]; void box; return [...list]; }`,
    written: false,
  },
] as const;

const ASSIGNED =
  "function frames(error: any) { const a: any[] = ['safe']; const list: any[] = ['safe'];";

const CONVERSIONS = [
  {
    id: 'array-pattern-writes-an-element-the-spread-copies',
    source: `${ASSIGNED} [list[0]] = [error]; Object.assign(a, [...list]); return String(a); }`,
    converts: true,
  },
  {
    id: 'loop-head-writes-an-element-the-spread-copies',
    source: `${ASSIGNED} for (list[0] of [error]) { } Object.assign(a, [...list]); return String(a); }`,
    converts: true,
  },
  {
    id: 'pattern-of-another-list-pin',
    source: `${ASSIGNED} const other: any[] = []; [...other[0]] = [error]; Object.assign(a, [...list]); return String(a); }`,
    converts: false,
  },
] as const;

describe('an element a pattern writes to a list that is spread', () => {
  it.each(CONVERSIONS)('$id', ({ source, converts }) => {
    expect(convertsError(source)).toBe(converts);
  });
});

/** Whether the source's `String(array)` converts the `error` element. */
function convertsError(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'list-targets.ts', source);
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

describe('a list spread where it is written out', () => {
  it.each(CASES)('$id', ({ source, written }) => {
    expect(isWritten(source)).toBe(written);
  });
});

/** Whether the list the source spreads is read as its literal wrote it. */
function isWritten(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'list-targets.ts', source);
  return writtenList(spreadOf(parsed.sourceFile).expression) !== undefined;
}

function spreadOf(root: Node): SpreadElement & { readonly expression: Expression } {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isSpreadElement(node) && isIdentifier(node.expression)) return node;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no spread of a name');
}
