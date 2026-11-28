import { describe, expect, it, vi } from 'vitest';

import { queryCapture } from '../src/sql/compat.ts';

/** Capture upgrade diagnostics apply only to the missing objects of the store's own statement. */
const NAMESPACE = 'custom_log';
const PAGE = 'SELECT "side", "image" FROM "custom_log"."changes"';
const COUNT = 'SELECT "custom_log"."ddl_count"()';
const FOLD = 'SELECT "custom_log"."fold_ddl"($1::double precision)';

/** A PostgreSQL error whose position names `token` in its original statement. */
function missing(sql: string, token: string, code: string) {
  return Object.assign(new Error('an object is missing'), {
    code,
    position: String(sql.indexOf(token) + 1),
  });
}

describe('capture upgrade diagnostics', () => {
  it.each([
    [PAGE, '"side"', '42703'],
    [PAGE, '"image"', '42703'],
    [COUNT, '"custom_log"', '42883'],
    [FOLD, '"custom_log"', '42883'],
  ])('explains a missing capture object in %s', async (sql, token, code) => {
    const original = missing(sql, token, code);
    const query = vi.fn().mockRejectedValue(original);

    await expect(queryCapture({ query }, sql, [], NAMESPACE)).rejects.toMatchObject({
      cause: original,
      message: expect.stringContaining('follow.captureSql()'),
    });
    expect(query).toHaveBeenCalledExactlyOnceWith(sql, []);
  });

  it.each([
    { code: '42501', position: '8' },
    { code: '42703' },
    { code: '42703', position: '0' },
    { code: '42703', position: '1000' },
    { code: '42703', internalQuery: 'SELECT "side" FROM application', position: '8' },
    { code: '42883', position: '8' },
  ])('preserves a different database failure: %j', async (fields) => {
    const original = Object.assign(new Error('unrelated failure'), fields);
    const query = vi.fn().mockRejectedValue(original);

    await expect(queryCapture({ query }, PAGE, [], NAMESPACE)).rejects.toBe(original);
  });

  it('preserves a missing function in another namespace', async () => {
    const sql = 'SELECT "another_log"."ddl_count"()';
    const original = missing(sql, '"another_log"', '42883');
    const query = vi.fn().mockRejectedValue(original);

    await expect(queryCapture({ query }, sql, [], NAMESPACE)).rejects.toBe(original);
  });

  it('returns a successful log read without another query', async () => {
    const rows = { rows: [{ head: 1 }] };
    const query = vi.fn().mockResolvedValue(rows);

    await expect(queryCapture({ query }, PAGE, [0], NAMESPACE)).resolves.toBe(rows);
    expect(query).toHaveBeenCalledExactlyOnceWith(PAGE, [0]);
  });
});
