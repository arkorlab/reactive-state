import { describe, expect, it } from 'vitest';

import { database, table, text } from '../src/server/schema.ts';

/**
 * A store's name as a caller in JavaScript, or through `any`, may give one that is no text: each
 * converts to text that reads as a name.
 */
const NO_TEXT: readonly (readonly [string, unknown])[] = [
  ['`null`', null],
  ['a boolean', true],
  ['a number', NaN],
  ['a list of a name', ['store']],
  ['an object', { toString: () => 'store' }],
];

describe('the store an external table names', () => {
  it.each(NO_TEXT)('is refused where it is %s, though it converts to a name', (_, external) => {
    expect(() => table({ title: text() }, { external: external as string })).toThrow(
      "database(): a store's name is text",
    );
  });

  it('is refused where a table written by hand names one that is no text', () => {
    const written = { external: null, fields: { title: text() }, public: [], unique: [] };

    expect(() => database({ records: written as never })).toThrow(
      "database(): a store's name is text",
    );
  });
});
