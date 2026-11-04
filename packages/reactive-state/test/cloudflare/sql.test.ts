import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { SqlDriver } from '../../src/authority/sql.ts';
import { durableObjectSql, StorageFaultError } from '../../src/cloudflare/sql.ts';
import { authority } from './helpers.ts';

/**
 * Runs `check` on a driver over a fresh object's storage, with a table of its own beside the
 * authority's. The checks run inside the object, where its storage is.
 */
async function inObject(check: (sql: SqlDriver) => void): Promise<void> {
  await runInDurableObject(authority(), (_instance, state) => {
    const sql = durableObjectSql(state.storage);
    sql.run('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
    check(sql);
  });
}

function insert(sql: SqlDriver, body: string): void {
  sql.run('INSERT INTO notes (body) VALUES (?)', body);
}

function bodies(sql: SqlDriver): readonly unknown[] {
  return sql.all('SELECT body FROM notes ORDER BY id').map((row) => row['body']);
}

describe('the Durable Object’s driver', () => {
  it('lands every statement of a transaction together', async () => {
    await inObject((sql) => {
      const answer = sql.transaction(() => {
        insert(sql, 'one');
        insert(sql, 'two');
        return 'done';
      });

      expect(answer).toBe('done');
      expect(bodies(sql)).toStrictEqual(['one', 'two']);
    });
  });

  it('lands none of them when the body throws', async () => {
    await inObject((sql) => {
      expect(() => {
        return sql.transaction(() => {
          insert(sql, 'kept back');
          throw new Error('refused halfway');
        });
      }).toThrow('refused halfway');
      expect(bodies(sql)).toStrictEqual([]);
    });
  });

  it('refuses a body that hands back a promise, and keeps nothing it wrote', async () => {
    await inObject((sql) => {
      expect(() => {
        return sql.transaction(() => {
          insert(sql, 'too early');
          return Promise.resolve();
        });
      }).toThrow(/synchronous body/u);
      expect(bodies(sql)).toStrictEqual([]);
    });
  });

  it('refuses a transaction inside another, keeps neither, and opens the next one', async () => {
    await inObject((sql) => {
      expect(() => {
        sql.transaction(() => {
          insert(sql, 'outer');
          sql.transaction(() => {
            insert(sql, 'inner');
          });
        });
      }).toThrow(/inside another/u);
      expect(bodies(sql)).toStrictEqual([]);
      expect(sql.transaction(() => 'open again')).toBe('open again');
    });
  });

  it('throws a statement the storage would not run as a storage fault, not a plain error', async () => {
    await inObject((sql) => {
      expect(() => sql.get('SELECT body FROM missing')).toThrow(StorageFaultError);
      expect(() => {
        sql.run('INSERT INTO missing VALUES (1)');
      }).toThrow(/missing/u);
    });
  });

  it('reads a row as the first of its rows, and a missing one as nothing', async () => {
    await inObject((sql) => {
      insert(sql, 'only');

      expect(sql.get('SELECT body FROM notes WHERE id = ?', 1)).toStrictEqual({ body: 'only' });
      expect(sql.get('SELECT body FROM notes WHERE id = ?', 2)).toBeUndefined();
    });
  });
});
