import { type Expression, isCallExpression, isIdentifier, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import {
  arrayMethodMayBeOverridden,
  framedArrayString,
  framedArrayText,
} from '../src/compiler/framed-arrays.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * What an array's `join`, `toString`, `sort` and `toSorted` do is the language's, whatever the program
 * wrote to one of them: no write is followed to prove a method custom, so the text conversion of an
 * array that may hold an error is refused though `join` or `toString` was replaced, and an array
 * that holds none is as it was. A reader of what a method answers asks by name instead
 * (`arrayMethodMayBeOverridden`): the file writes, defines, names or copies the method, or gives an
 * array another prototype.
 */
const HEAD = 'function frames(error: Error, key: string, source: object, flag: boolean) {';

const CONVERSIONS = [
  {
    id: 'replaced-to-string',
    source: `${HEAD} const values = [error]; values.toString = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'replaced-join',
    source: `${HEAD} const values = [error]; values.join = () => 'safe'; return values.join(','); }`,
    converts: true,
  },
  {
    id: 'replaced-join-under-an-element-access',
    source: `${HEAD} const values = [error]; values['join'] = () => 'safe'; return values.join(','); }`,
    converts: true,
  },
  {
    id: 'replaced-join-read-by-to-string',
    source: `${HEAD} const values = [error]; values.join = () => 'safe'; return String(values); }`,
    converts: true,
  },
  {
    id: 'replaced-by-a-logical-assignment',
    source: `${HEAD} const values = [error]; values.join ||= () => 'safe'; return values.join(','); }`,
    converts: true,
  },
  {
    id: 'replaced-by-an-array-pattern',
    source: `${HEAD} const values = [error]; [values.join] = [() => 'safe']; return values.join(','); }`,
    converts: true,
  },
  {
    id: 'replaced-by-a-loop-head',
    source: `${HEAD} const values = [error]; for (values.join of [() => 'safe']) { } return values.join(','); }`,
    converts: true,
  },
  {
    id: 'replaced-then-deleted',
    source: `${HEAD} const values = [error]; values.toString = () => 'safe'; delete values.toString; return String(values); }`,
    converts: true,
  },
  {
    id: 'replaced-sort-converts-the-elements',
    source: `${HEAD} const values = [error, 'a']; values.toSorted = () => []; return values.toSorted(); }`,
    converts: true,
  },
  {
    id: 'replaced-in-a-function-that-runs-first',
    source: `${HEAD} const values = [error]; function replace() { values.join = () => 'safe'; } replace(); return values.join(','); }`,
    converts: true,
  },
  {
    id: 'not-replaced',
    source: `${HEAD} const values = [error]; return values.join(','); }`,
    converts: true,
  },
  {
    id: 'replaced-join-of-an-array-of-texts-pin',
    source: `${HEAD} const values = ['a']; values.join = () => 'safe'; return values.join(','); }`,
    converts: false,
  },
  {
    id: 'replaced-to-string-of-an-array-of-texts-pin',
    source: `${HEAD} const values = ['a']; values.toString = () => 'safe'; return String(values); }`,
    converts: false,
  },
  {
    id: 'replaced-on-another-array-pin',
    source: `${HEAD} const values = ['a']; const other = [error]; other.join = () => 'safe'; return values.join(','); }`,
    converts: false,
  },
  {
    id: 'a-field-of-another-name-pin',
    source: `${HEAD} const values = ['a']; (values as any).label = 'safe'; return values.join(','); }`,
    converts: false,
  },
] as const;

describe('text conversion of an array whose text method the program replaced', () => {
  it.each(CONVERSIONS)('$id', ({ source, converts }) => {
    expect(convertsError(source)).toBe(converts);
  });
});

const GUARDS = [
  {
    id: 'a-member-of-the-name-assigned',
    source: `${HEAD} const values = [1]; values.map = () => []; return values.map(String); }`,
    method: 'map',
    may: true,
  },
  {
    id: 'a-member-of-the-name-assigned-under-a-text-key',
    source: `${HEAD} const values = [1]; values['at'] = () => 1; return values.at(0); }`,
    method: 'at',
    may: true,
  },
  {
    id: 'a-member-deleted',
    source: `${HEAD} const values = [1]; delete (values as any).find; return values.find(Boolean); }`,
    method: 'find',
    may: true,
  },
  {
    id: 'a-member-of-a-key-the-compile-cannot-read-assigned',
    source: `${HEAD} const values = [1]; (values as any)[key] = () => 1; return values.filter(Boolean); }`,
    method: 'filter',
    may: true,
  },
  {
    id: 'a-definition-names-it',
    source: `${HEAD} const values = [1]; Object.defineProperty(values, 'slice', { value: () => [] }); return values.slice(); }`,
    method: 'slice',
    may: true,
  },
  {
    id: 'an-object-with-a-field-of-the-name-a-mutator-may-copy',
    source: `${HEAD} const values = [1]; Object.assign(values, { flat: () => [] }); return values.flat(); }`,
    method: 'flat',
    may: true,
  },
  {
    id: 'a-mutator-given-a-source-the-compile-cannot-read',
    source: `${HEAD} const values = [1]; Object.assign(values, source); return values.some(Boolean); }`,
    method: 'some',
    may: true,
  },
  {
    id: 'another-prototype-for-an-array',
    source: `${HEAD} const values = [1]; Object.setPrototypeOf(values, source); return values.every(Boolean); }`,
    method: 'every',
    may: true,
  },
  {
    id: 'a-class-with-a-method-of-the-name',
    source: `${HEAD} class Rows { reduce() { return 0; } } const values = [1]; return new Rows().reduce() + values.length; }`,
    method: 'reduce',
    may: true,
  },
  {
    id: 'no-write-of-the-name-pin',
    source: `${HEAD} const values = [1]; values.push(2); (values as any).label = 'x'; return values.map(String); }`,
    method: 'map',
    may: false,
  },
  {
    id: 'a-write-of-another-name-pin',
    source: `${HEAD} const values = [1]; values.join = () => 'safe'; return values.map(String); }`,
    method: 'map',
    may: false,
  },
  {
    id: 'a-mutator-of-an-object-with-written-fields-pin',
    source: `${HEAD} const values = [1]; const options = Object.assign({}, { size: 1 }); void options; return values.find(Boolean); }`,
    method: 'find',
    may: false,
  },
] as const;

describe('the methods of an array a file may give another implementation', () => {
  it.each(GUARDS)('$id', ({ source, method, may }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-methods-language.ts', source);

    expect(arrayMethodMayBeOverridden(firstCall(parsed.sourceFile), method)).toBe(may);
  });
});

/** Whether a native join, toString, sort, toSorted or String call in the source converts `error`. */
function convertsError(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'array-text-methods-language.ts', source);
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
    if (framedArrayText(node, words)) return true;
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

/** The first call in the source: it names the file the guard asks about. */
function firstCall(root: Node): Node {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isCallExpression(node)) return node;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no call');
}
