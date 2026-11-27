import { describe, expect, it } from 'vitest';

import { queryOf } from '../src/authority/query.ts';
import { integer, table, text } from '../src/server/schema.ts';

/**
 * A query's `limit` and `select` of a table the authority keeps, as `queryOf` checks them: the
 * most records `findMany` answers, and the fields it answers of each.
 */

const records = table({ title: text(), rank: integer() });

describe("a query's limit", () => {
  it('is taken with an order and a selection', () => {
    const query = queryOf(
      'find',
      records,
      { limit: 2, orderBy: [{ rank: 'desc' }], select: { title: true }, where: {} },
      'findMany',
    );

    expect(query.limit).toBe(2);
    expect(query.orderBy).toStrictEqual([{ descending: true, field: 'rank' }]);
    expect(query.select).toStrictEqual(['title']);
  });
});
