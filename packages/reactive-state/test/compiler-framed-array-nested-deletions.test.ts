import { type Expression, isCallExpression, isIdentifier, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedArrayString } from '../src/compiler/framed-arrays.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A deletion that is no statement of its own (an operand of `void`, a comma, a short circuit, a
 * condition) gives the array the method it inherits as one that is: where it removes the method an
 * assignment wrote, or where nothing wrote it, `toString` is the native one and delegates to the
 * custom `join`. Where the file may give the array another prototype, no deletion says so.
 */
const HEAD =
  'function frames(error: Error, flag: boolean, name: string) { const values = [error]; const other: unknown[] = [];';

const CASES = [
  {
    id: 'void-delete-of-an-unwritten-to-string',
    source: `${HEAD} values.join = () => 'safe'; void delete values.toString; return String(values); }`,
    converts: true,
  },
  {
    id: 'comma-delete-of-an-unwritten-to-string',
    source: `${HEAD} values.join = () => 'safe'; (delete values.toString, 0); return String(values); }`,
    converts: true,
  },
  {
    id: 'negated-delete-of-an-unwritten-to-string',
    source: `${HEAD} values.join = () => 'safe'; !delete values.toString; return String(values); }`,
    converts: true,
  },
  {
    id: 'delete-in-a-list-of-an-unwritten-to-string',
    source: `${HEAD} values.join = () => 'safe'; [delete values.toString]; return String(values); }`,
    converts: true,
  },
  {
    id: 'delete-through-an-element-access',
    source: `${HEAD} values.join = () => 'safe'; void delete values['toString']; return String(values); }`,
    converts: true,
  },
  {
    id: 'delete-of-an-unwritten-to-string-in-a-short-circuit',
    source: `${HEAD} values.join = () => 'safe'; flag && delete values.toString; return String(values); }`,
    converts: true,
  },
  {
    id: 'delete-of-an-unwritten-to-string-in-a-condition',
    source: `${HEAD} values.join = () => 'safe'; flag ? delete values.toString : 0; return String(values); }`,
    converts: true,
  },
  {
    id: 'delete-of-an-unwritten-to-string-in-an-if',
    source: `${HEAD} values.join = () => 'safe'; if (flag) void delete values.toString; return String(values); }`,
    converts: true,
  },
  {
    id: 'delete-of-an-unwritten-to-string-in-a-loop',
    source: `${HEAD} values.join = () => 'safe'; for (let at = 0; at < 2; at += 1) void delete values.toString; return String(values); }`,
    converts: true,
  },
  {
    id: 'void-delete-gives-back-the-native-to-string',
    source: `${HEAD} values.toString = () => 'text'; values.join = () => 'safe'; void delete values.toString; return String(values); }`,
    converts: true,
  },
  {
    id: 'comma-delete-gives-back-the-native-to-string',
    source: `${HEAD} values.toString = () => 'text'; values.join = () => 'safe'; (delete values.toString, 0); return String(values); }`,
    converts: true,
  },
  {
    id: 'short-circuit-delete-after-a-custom-to-string-pin',
    source: `${HEAD} values.toString = () => 'text'; values.join = () => 'safe'; flag && delete values.toString; return String(values); }`,
    converts: true,
  },
  {
    id: 'delete-of-an-opaque-name-pin',
    source: `${HEAD} values.join = () => 'safe'; void delete values[name]; return String(values); }`,
    converts: true,
  },
  {
    id: 'delete-of-another-array-refused',
    source: `${HEAD} values.join = () => 'safe'; void delete other.toString; return String(values); }`,
    converts: true,
  },
  {
    id: 'delete-of-the-join-gives-back-the-native-join',
    source: `${HEAD} values.join = () => 'safe'; void delete values.join; return String(values); }`,
    converts: true,
  },
  {
    id: 'delete-where-the-prototype-may-change-pin',
    source: `${HEAD} const names = ['setPrototypeOf']; values.join = () => 'safe'; void delete values.toString; return String(values) + names.length; }`,
    converts: true,
  },
  {
    id: 'direct-delete-of-an-unwritten-to-string-refused',
    source: `${HEAD} values.join = () => 'safe'; delete values.toString; return String(values); }`,
    converts: true,
  },
  {
    id: 'delete-after-a-native-method-is-given-to-the-array-prototype-pin',
    source: `${HEAD} Array.prototype.toString = Array.prototype.join; values.join = () => 'safe'; delete values.toString; return String(values); }`,
    converts: true,
  },
  {
    id: 'nested-delete-after-a-native-method-is-given-to-the-array-prototype-pin',
    source: `${HEAD} Array.prototype.toString = Array.prototype.join; values.join = () => 'safe'; void delete values.toString; return String(values); }`,
    converts: true,
  },
  {
    id: 'delete-after-a-definition-on-the-array-prototype-pin',
    source: `${HEAD} Object.defineProperty(Array.prototype, 'toString', { value: Array.prototype.join, configurable: true }); values.join = () => 'safe'; void delete values.toString; return String(values); }`,
    converts: true,
  },
] as const;

describe('a deletion of a method nested in another expression', () => {
  it.each(CASES)('$id', ({ source, converts }) => {
    expect(convertsError(source)).toBe(converts);
  });
});

/** Whether the source's `String(array)` converts the `error` element. */
function convertsError(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'nested-deletions.ts', source);
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
