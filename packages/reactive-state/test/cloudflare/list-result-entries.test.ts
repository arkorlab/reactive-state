import { describe, expect, it } from 'vitest';

import { itemsWithin } from '../../src/authority/items.ts';
import { listResultEntries } from '../support/list-result-entries.ts';

/** The own-entry boundary also holds in the actual Workers authority runtime. */
describe('own data entries of generated list results', () => {
  it.each(listResultEntries())('$name', ({ keys, make }) => {
    const { calls, each } = make();

    const checked = itemsWithin('rows', each, {});

    expect(checked?.map((entry) => entry.key)).toStrictEqual(keys);
    expect(calls).toStrictEqual([]);
  });
});
