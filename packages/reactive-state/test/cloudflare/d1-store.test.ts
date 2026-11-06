import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  externalFind,
  type ExternalStore,
  type ExternalTable,
} from '../../src/authority/external.ts';
import type { Order, Where } from '../../src/authority/query.ts';
import {
  changeCaptureSql,
  d1Executor,
  d1Store,
  pruneChanges,
} from '../../src/cloudflare/d1-store.ts';
import { boolean, database, integer, json, table, text } from '../../src/server/schema.ts';

/**
 * An application's D1 as an external store, exercised in workerd: SQL predicates and ordering,
 * trigger images, and a cursor that remains meaningful after the application's pruning.
 */

const declared = table(
  {
    active: boolean({ default: true }),
    document: json(),
    rank: integer({ default: 2 }),
    title: text(),
  },
  { external: 'main' },
);
const declaration = database({ records: declared });
const records: ExternalTable = { name: 'records', table: declared };
const mapping = {
  records: { columns: { active: 'enabled', title: 'label' }, id: 'key', name: 'stored_records' },
};
const executor = d1Executor(env.REACTIVE_D1);
const VALUES = { manyFields: 20, old: 10, recent: 20 } as const;

/** One SQL statement against the application's own primary database. */
async function sql(statement: string, params: readonly unknown[] = []) {
  return executor.all(statement, params);
}

/** The store's records as the authority answers them, not merely the rows SQLite returns. */
function found(
  store: ExternalStore,
  where: Where = {},
  orderBy: readonly Order[] = [],
  limit?: number,
) {
  return externalFind(store, records, { limit, orderBy, where }, undefined);
}

describe('a D1 external store', () => {
  beforeEach(async () => {
    await sql('DROP TABLE IF EXISTS stored_records');
    await sql('DROP TABLE IF EXISTS _rs_changes');
    await sql('DROP TABLE IF EXISTS _rs_meta');
    await sql(
      'CREATE TABLE stored_records (key TEXT PRIMARY KEY COLLATE NOCASE, label TEXT COLLATE NOCASE, enabled INTEGER, rank INTEGER, document TEXT, ignored TEXT)',
    );
    for (const statement of changeCaptureSql(declaration, 'main', mapping)) {
      await sql(statement);
    }
  });

  it('reads mapped columns, defaults, booleans and whole JSON documents', async () => {
    await sql('INSERT INTO stored_records (key, label, enabled, document) VALUES (?, ?, ?, ?)', [
      'one',
      'hello',
      0,
      '{"nested":[true,2]}',
    ]);
    await sql('INSERT INTO stored_records (key) VALUES (?)', ['two']);
    const store = d1Store(executor, mapping);

    await expect(found(store)).resolves.toStrictEqual([
      { active: false, document: { nested: [true, 2] }, id: 'one', rank: 2, title: 'hello' },
      { active: true, document: null, id: 'two', rank: 2, title: '' },
    ]);
    await expect(store.get(records, 'absent')).resolves.toBeNull();
    await expect(store.count(records, { active: true, rank: 2 })).resolves.toBe(1);
  });

  it('uses binary equality even when columns use NOCASE', async () => {
    await sql('INSERT INTO stored_records (key, label) VALUES (?, ?), (?, ?)', [
      'lower',
      'alpha',
      'upper',
      'ALPHA',
    ]);
    const store = d1Store(executor, mapping);

    await expect(found(store, { title: 'alpha' }, [], 1)).resolves.toMatchObject([{ id: 'lower' }]);
    await expect(store.count(records, { title: 'alpha' })).resolves.toBe(1);
    await expect(store.get(records, 'LOWER')).resolves.toBeNull();
  });

  it('orders defaults and code points before applying the limit', async () => {
    await sql(
      'INSERT INTO stored_records (key, label, rank) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)',
      ['first', '\u{E000}', null, 'second', '😀', 1, 'third', 'a', 2],
    );
    const store = d1Store(executor, mapping);

    await expect(
      found(store, {}, [{ descending: false, field: 'title' }], 2),
    ).resolves.toMatchObject([{ id: 'third' }, { id: 'first' }]);
    await expect(found(store, {}, [{ descending: false, field: 'rank' }])).resolves.toMatchObject([
      { id: 'second' },
      { id: 'first' },
      { id: 'third' },
    ]);
  });

  it('captures one table-wide signal per insert or update, and a specific deletion', async () => {
    await sql('INSERT INTO stored_records (key, label, enabled) VALUES (?, ?, ?)', [
      'one',
      'hello',
      0,
    ]);
    await sql('UPDATE stored_records SET ignored = ?, label = label WHERE key = ?', [
      'ignored',
      'one',
    ]);
    await sql('UPDATE stored_records SET enabled = ? WHERE key = ?', [1, 'one']);
    await sql('UPDATE stored_records SET key = ? WHERE key = ?', ['two', 'one']);
    await sql('DELETE FROM stored_records WHERE key = ?', ['two']);

    const read = await d1Store(executor, mapping).changes(0, VALUES.manyFields);

    expect(read.changes).toMatchObject([
      {
        after: { active: false, rank: null, title: 'hello' },
        before: null,
        id: '',
        table: 'records',
      },
      { after: { active: false }, before: { active: false }, id: '' },
      { after: { active: true }, before: { active: false }, id: '' },
      { after: { active: true }, before: { active: true }, id: '' },
      { after: null, before: { active: true }, id: 'two' },
    ]);
    expect(read.changes).toHaveLength(5);
    expect(read.epoch).not.toBe('');
  });

  it('captures text and id changes that differ only in case', async () => {
    await sql('INSERT INTO stored_records (key, label) VALUES (?, ?)', ['one', 'alpha']);
    await sql('UPDATE stored_records SET label = ? WHERE key = ?', ['ALPHA', 'one']);
    await sql('UPDATE stored_records SET key = ? WHERE key = ?', ['ONE', 'one']);

    const read = await d1Store(executor, mapping).changes(0, VALUES.manyFields);

    expect(read.changes).toHaveLength(3);
    expect(read.changes[1]).toMatchObject({
      after: { title: 'ALPHA' },
      before: { title: 'alpha' },
      id: '',
    });
    expect(read.changes[2]).toMatchObject({ after: { title: 'ALPHA' }, id: '' });
  });

  it('retains a monotonic head and a missing-range floor after every old row is pruned', async () => {
    await sql('INSERT INTO stored_records (key) VALUES (?), (?)', ['one', 'two']);
    await sql('UPDATE _rs_changes SET at = ?', [VALUES.old]);
    const store = d1Store(executor, mapping);
    const before = await store.changes(0, VALUES.manyFields);

    await pruneChanges(executor, VALUES.recent);
    const empty = await store.changes(0, VALUES.manyFields);
    await sql('INSERT INTO stored_records (key) VALUES (?)', ['three']);
    const next = await store.changes(before.head, VALUES.manyFields);

    expect(empty).toStrictEqual({
      changes: [],
      epoch: before.epoch,
      floor: before.head + 1,
      head: before.head,
    });
    expect(next.changes).toHaveLength(1);
    expect(next.changes[0]?.seq).toBeGreaterThan(before.head);
  });

  it('reads a row of no id as no record, never as one named `null`', async () => {
    // SQLite lets a TEXT PRIMARY KEY of no NOT NULL hold NULL.
    await sql('INSERT INTO stored_records (key, label) VALUES (NULL, ?), (?, ?)', [
      'keyless',
      'one',
      'kept',
    ]);
    const store = d1Store(executor, mapping);

    const listed = await store.find(records, { limit: undefined, orderBy: [], where: {} });
    // SQLite orders the NULL first: it must not take the one place of a limit.
    const first = await store.find(records, { limit: 1, orderBy: [], where: {} });

    expect(listed.map((record) => record.id)).toStrictEqual(['one']);
    expect(first.map((record) => record.id)).toStrictEqual(['one']);
    await expect(store.count(records, {})).resolves.toBe(1);
  });

  it('reads a key no record id can be as no record, before a limit and in a count', async () => {
    // Each sorts before `one`: empty, a character no id has, one past the longest id, and one with
    // a NUL inside, of which SQLite's `length` and `GLOB` read the part before it alone.
    await sql('INSERT INTO stored_records (key) VALUES (?), (?), (?), (?), (?)', [
      '',
      '0@example',
      '0'.repeat(65),
      'a\0invalid',
      'one',
    ]);
    const store = d1Store(executor, mapping);

    await expect(found(store, {}, [], 1)).resolves.toMatchObject([{ id: 'one' }]);
    await expect(found(store)).resolves.toMatchObject([{ id: 'one' }]);
    await expect(store.count(records, {})).resolves.toBe(1);
  });

  it('lets the application delete a row of no id, and logs nothing of it', async () => {
    await sql('INSERT INTO stored_records (key, label) VALUES (NULL, ?)', ['keyless']);
    const store = d1Store(executor, mapping);
    const before = await store.changes(0, VALUES.manyFields);

    await sql('DELETE FROM stored_records WHERE key IS NULL');
    const after = await store.changes(before.head, VALUES.manyFields);

    expect(after.changes).toStrictEqual([]);
    expect(after.head).toBe(before.head);
  });

  it('lets go of no change from between two it keeps, whatever the clock stamped it', async () => {
    await sql('INSERT INTO stored_records (key) VALUES (?), (?), (?)', ['one', 'two', 'three']);
    const store = d1Store(executor, mapping);
    const logged = await store.changes(0, VALUES.manyFields);
    const [first, second, third] = logged.changes.map((change) => change.seq);
    // The database's clock stepped back as the third was written: stamped before the second.
    await sql('UPDATE _rs_changes SET at = ? WHERE seq IN (?, ?)', [VALUES.old, first, third]);
    await sql('UPDATE _rs_changes SET at = ? WHERE seq = ?', [VALUES.recent, second]);

    await pruneChanges(executor, VALUES.recent);
    const kept = await store.changes(0, VALUES.manyFields);

    // The first alone is let go of: a follower behind it starts again, and none reads past a gap.
    expect(kept.changes.map((change) => change.seq)).toStrictEqual([second, third]);
    expect(kept.floor).toBe(second);
  });

  it('keeps one snapshot of head, epoch and bounded changes in each page', async () => {
    await sql('INSERT INTO stored_records (key) VALUES (?), (?)', ['one', 'two']);
    const store = d1Store(executor, mapping);

    const page = await store.changes(0, 1);
    const tail = await store.changes(page.changes[0]?.seq ?? 0, 1);

    expect(page.changes).toHaveLength(1);
    expect(tail.changes).toHaveLength(1);
    expect(page.head).toBe(tail.head);
    expect(page.epoch).toBe(tail.epoch);
    expect(tail.changes[0]?.seq).toBeGreaterThan(page.changes[0]?.seq ?? 0);
  });

  it('keeps its epoch on repeated migrations, replacing triggers when declared fields change', async () => {
    const store = d1Store(executor, mapping);
    const before = await store.changes(0, 1);
    const expanded = database({
      records: table({ ...declared.fields, ignored: text() }, { external: 'main' }),
    });
    for (const statement of changeCaptureSql(expanded, 'main', mapping)) {
      await sql(statement);
    }
    await sql('INSERT INTO stored_records (key) VALUES (?)', ['one']);
    await sql('UPDATE stored_records SET ignored = ? WHERE key = ?', ['new', 'one']);

    const after = await store.changes(0, VALUES.manyFields);

    expect(after.epoch).toBe(before.epoch);
    expect(after.changes).toHaveLength(2);
    expect(after.changes[1]?.after).toMatchObject({ ignored: 'new' });
  });

  it('starts a new epoch when only the log table is recreated', async () => {
    const store = d1Store(executor, mapping);
    const before = await store.changes(0, 1);
    await sql('DROP TABLE _rs_changes');
    for (const statement of changeCaptureSql(declaration, 'main', mapping)) {
      await sql(statement);
    }

    const after = await store.changes(0, 1);

    expect(after.epoch).not.toBe(before.epoch);
    expect(after.head).toBe(0);
    expect(after.floor).toBe(0);
    expect(after.changes).toHaveLength(0);
  });

  it('faults on malformed JSON rather than replacing it with the default', async () => {
    await sql('INSERT INTO stored_records (key, document) VALUES (?, ?)', ['one', '{broken']);

    await expect(d1Store(executor, mapping).get(records, 'one')).rejects.toThrow('not valid JSON');
  });

  it('makes triggers with more fields than one D1 JSON function accepts', async () => {
    const fields = Object.fromEntries(
      Array.from({ length: VALUES.manyFields }, (_, index) => [`field${String(index)}`, text()]),
    );
    const wide = table(fields, { external: 'main' });
    await sql(
      `CREATE TABLE wide_records (id TEXT PRIMARY KEY, ${Object.keys(fields)
        .map((field) => `${field} TEXT`)
        .join(', ')})`,
    );
    const statements = changeCaptureSql(database({ wide_records: wide }), 'main');
    for (const statement of statements) {
      await sql(statement);
    }

    await sql('INSERT INTO wide_records (id, field0, field19) VALUES (?, ?, ?)', [
      'wide',
      'first',
      'last',
    ]);
    const changes = await d1Store(executor).changes(0, VALUES.manyFields);

    expect(changes.changes[0]?.after).toMatchObject({ field0: 'first', field19: 'last' });

    await sql('DROP TABLE wide_records');
  });
});
