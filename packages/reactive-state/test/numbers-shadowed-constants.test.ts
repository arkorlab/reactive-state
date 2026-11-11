import { type ElementAccessExpression, isElementAccessExpression, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { frameMemberName } from '../src/compiler/framed-bindings.ts';

/**
 * A constant a block gives again, `{ const key = alias; … }`, is read as the constant it is where it
 * is read and as the one around it where the code means that one: the key a computed read is
 * recorded as is what the language computes of it, or none. A constant computed once, whoever
 * reads it, keeps that: what it computes to in one read is what it computes to in the next, and
 * what it computes to is the same whichever constant is read before it.
 */

const OUTSIDE = 'const key = 1; const alias = key + 1; const other = 5;';

/** What each read computes to in a block that gives the names again as `given` does, run in Node. */
const COMPUTED = [
  {
    given: 'const key = alias;',
    reads: {
      'alias * key': '4',
      'alias + alias + key': '6',
      'alias + key': '4',
      alias: '2',
      key: '2',
      'key + alias': '4',
      'Math.max(alias, key)': '2',
      'Math.max(key, alias)': '2',
    },
  },
  {
    given: 'const alias = key;',
    reads: {
      'alias * key': '1',
      'alias + alias + key': '3',
      'alias + key': '2',
      alias: '1',
      key: '1',
      'key + alias': '2',
      'Math.max(alias, key)': '1',
      'Math.max(key, alias)': '1',
    },
  },
  {
    given: 'const key = alias + 1;',
    reads: {
      'alias * key': '6',
      'alias + alias + key': '7',
      'alias + key': '5',
      alias: '2',
      key: '3',
      'key + alias': '5',
      'Math.max(alias, key)': '3',
      'Math.max(key, alias)': '3',
    },
  },
  {
    given: 'const alias = key + key;',
    reads: {
      'alias * key': '2',
      'alias + alias + key': '5',
      'alias + key': '3',
      alias: '2',
      key: '1',
      'key + alias': '3',
      'Math.max(alias, key)': '2',
      'Math.max(key, alias)': '2',
    },
  },
  {
    given: 'const key = other;',
    reads: {
      'alias * key': '10',
      'alias + alias + key': '9',
      'alias + key': '7',
      alias: '2',
      key: '5',
      'key + alias': '7',
      'Math.max(alias, key)': '5',
      'Math.max(key, alias)': '5',
    },
  },
] as const;

/**
 * A setter an object the code writes owns, `key.setTime(Infinity)`, answers what the code writes of
 * it, `0` — no `NaN` a date's would — wherever its receiver is read through a name a block gives
 * again: the outer `key` is the object, and so is the one a read of `computed` means.
 */
const OWN_SETTER = {
  computed: '0',
  given: 'const key = computed;',
  outside: 'const key = { setTime() { return 0; } }; const computed = key.setTime(Infinity);',
  reads: [
    'key',
    'computed',
    'Math.max(key, computed)',
    'Math.max(computed, key)',
    'key + computed',
    'computed + key',
  ],
} as const;

describe('the key a read of constants a block gives again is recorded as', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The member `value[read]` is recorded as, of `read` in a block that declares `given`. */
  function recordedOf(given: string, read: string, outside = OUTSIDE): string | undefined {
    using parsed = api.createSourceFile(
      'numbers.ts',
      `declare const value: Record<string, unknown>; ${outside} { ${given} value[${read}]; }`,
    );
    let element: ElementAccessExpression | undefined;
    const find = (node: Node): void => {
      if (isElementAccessExpression(node)) element = node;
      node.forEachChild(find);
    };
    find(parsed.sourceFile);
    if (element === undefined) throw new Error('No read is made.');
    return frameMemberName(element);
  }

  it.each(COMPUTED)('is the language’s or none: $given', ({ given, reads }) => {
    // Never another key than the language's: a key is told, or none.
    const another = Object.entries(reads).filter(([read, computed]) => {
      const member = recordedOf(given, read);
      return member !== undefined && member !== computed;
    });
    // Not none throughout: a constant's key is told where nothing shadows it.
    const told = Object.keys(reads).some((read) => recordedOf(given, read) !== undefined);

    expect(another).toStrictEqual([]);
    expect(told).toBe(true);
  });

  it.each(OWN_SETTER.reads)('is the setter’s own, or none: %s', (read) => {
    const member = recordedOf(OWN_SETTER.given, read, OWN_SETTER.outside);

    expect(member === undefined || member === OWN_SETTER.computed).toBe(true);
  });
});
