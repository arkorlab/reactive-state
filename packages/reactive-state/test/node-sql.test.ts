import { describe, expect, it, onTestFinished } from 'vitest';

import { nodeSql } from '../src/authority/node-sql.ts';
import type { SqlDriver } from '../src/authority/sql.ts';

/** A driver on an in-memory database with one table, closed when the test finishes. */
function opened(): SqlDriver {
  const sql = nodeSql(':memory:');
  onTestFinished(() => {
    sql.close();
  });
  sql.run('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
  return sql;
}

function bodies(sql: SqlDriver): readonly unknown[] {
  return sql.all('SELECT body FROM notes ORDER BY id').map((row) => row['body']);
}

describe('the Node driver', () => {
  it('lands every statement of a transaction together', () => {
    const sql = opened();

    const answer = sql.transaction(() => {
      sql.run('INSERT INTO notes (body) VALUES (?)', 'one');
      sql.run('INSERT INTO notes (body) VALUES (?)', 'two');
      return 'done';
    });

    expect(answer).toBe('done');
    expect(bodies(sql)).toStrictEqual(['one', 'two']);
  });

  it('lands none of them when the body throws', () => {
    const sql = opened();

    expect(() => {
      return sql.transaction(() => {
        sql.run('INSERT INTO notes (body) VALUES (?)', 'kept back');
        throw new Error('refused halfway');
      });
    }).toThrow('refused halfway');
    expect(bodies(sql)).toStrictEqual([]);
  });

  it('refuses a body that hands back a promise, and keeps nothing it wrote', () => {
    const sql = opened();

    expect(() => {
      return sql.transaction(() => {
        sql.run('INSERT INTO notes (body) VALUES (?)', 'too early');
        return Promise.resolve();
      });
    }).toThrow(/synchronous body/u);
    expect(bodies(sql)).toStrictEqual([]);
  });

  it('refuses a transaction inside another, and keeps neither', () => {
    const sql = opened();

    expect(() => {
      sql.transaction(() => {
        sql.run('INSERT INTO notes (body) VALUES (?)', 'outer');
        sql.transaction(() => {
          sql.run('INSERT INTO notes (body) VALUES (?)', 'inner');
        });
      });
    }).toThrow(/inside another/u);
    expect(bodies(sql)).toStrictEqual([]);
  });

  it('opens the next transaction after one that could not begin', () => {
    const sql = opened();
    // A transaction the driver did not open stands in for a write lock not had in time: its
    // `BEGIN` fails either way.
    sql.run('BEGIN');

    expect(() => sql.transaction(() => 'never')).toThrow(/within a transaction/u);

    sql.run('ROLLBACK');

    expect(sql.transaction(() => 'open again')).toBe('open again');
  });

  it('answers the body’s error when SQLite has rolled the transaction back already', () => {
    const sql = opened();

    expect(() => {
      return sql.transaction(() => {
        sql.run('INSERT INTO notes (body) VALUES (?)', 'kept back');
        // As SQLite does itself for a full disk or an I/O error, before the error reaches the body.
        sql.run('ROLLBACK');
        throw new Error('the disk is full');
      });
    }).toThrow('the disk is full');
    expect(bodies(sql)).toStrictEqual([]);
    expect(sql.transaction(() => 'open again')).toBe('open again');
  });

  it('answers a missing row as nothing', () => {
    const sql = opened();

    expect(sql.get('SELECT body FROM notes WHERE id = ?', 1)).toBeUndefined();
  });
});
