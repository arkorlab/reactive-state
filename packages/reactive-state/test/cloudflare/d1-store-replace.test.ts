import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import { Dependencies } from '../../src/authority/dependencies.ts';
import { ExternalFollower } from '../../src/authority/external.ts';
import { changeCaptureSql, d1Executor, d1Store } from '../../src/cloudflare/d1-store.ts';
import { database, definitionOf, table, text } from '../../src/server/schema.ts';

/** The declaration cannot know every physical UNIQUE constraint the application's table has. */
const declared = table({ group: text(), title: text() }, { external: 'main' });
const db = database({ records: declared });
const records = { name: 'records', table: declared };
const mapping = { records: { name: 'replace_records' } };
const store = d1Store(d1Executor(env.REACTIVE_D1), mapping);

/** A statement, as one of the application's existing writers executes it. */
async function sql(statement: string, params: readonly unknown[] = []): Promise<void> {
  await env.REACTIVE_D1.prepare(statement)
    .bind(...params)
    .run();
}

/** The setting and write share one transaction, as D1's PRAGMA scope requires. */
async function withoutRecursiveTriggers(
  statement: string,
  params: readonly unknown[],
): Promise<void> {
  await env.REACTIVE_D1.batch([
    env.REACTIVE_D1.prepare('PRAGMA recursive_triggers = OFF'),
    env.REACTIVE_D1.prepare(statement).bind(...params),
  ]);
}

function follower(): ExternalFollower {
  return new ExternalFollower(store, definitionOf(db).tables);
}

describe('a D1 log capturing replacement writers', () => {
  beforeEach(async () => {
    await sql('DROP TABLE IF EXISTS replace_records');
    await sql('DROP TABLE IF EXISTS _rs_changes');
    await sql('DROP TABLE IF EXISTS _rs_meta');
    await sql(
      'CREATE TABLE replace_records (id TEXT PRIMARY KEY, "group" TEXT, title TEXT, physical_key TEXT UNIQUE)',
    );
    for (const statement of changeCaptureSql(db, 'main', mapping)) await sql(statement);
  });

  it('invalidates a query when a key-only change omitted both row images', async () => {
    await sql('INSERT INTO replace_records VALUES (?, ?, ?, ?)', ['one', 'old', 'first', 'unique']);
    const log = follower();
    await log.changed();
    const dependencies = new Dependencies();
    dependencies.query('records', { group: 'old' });
    await sql('DROP TRIGGER _rs2_7265636f726473_update');
    await sql('UPDATE replace_records SET "group" = ? WHERE id = ?', ['new', 'one']);
    await sql('INSERT INTO _rs_changes (tbl,id,before,after,at) VALUES (?, ?, NULL, NULL, 0)', [
      'records',
      'one',
    ]);

    const changed = await log.changed();

    await expect(store.count(records, { group: 'old' })).resolves.toBe(0);
    expect(changed).toMatchObject([{ unknown: 'fields', id: 'one' }]);
    expect(dependencies.changedBy(changed)).toBe(true);
  });

  it('invalidates the predicate a primary-key replacement left', async () => {
    await sql('INSERT INTO replace_records VALUES (?, ?, ?, ?)', ['one', 'old', 'first', 'unique']);
    const log = follower();
    await log.changed();
    const dependencies = new Dependencies();
    dependencies.query('records', { group: 'old' });
    await withoutRecursiveTriggers('INSERT OR REPLACE INTO replace_records VALUES (?, ?, ?, ?)', [
      'one',
      'new',
      'second',
      'unique',
    ]);

    const changed = await log.changed();

    await expect(store.count(records, { group: 'old' })).resolves.toBe(0);
    expect(changed).toHaveLength(1);
    expect(dependencies.changedBy(changed)).toBe(true);
  });

  it('invalidates the prior id silently deleted by a different-id unique replacement', async () => {
    await sql('INSERT INTO replace_records VALUES (?, ?, ?, ?)', ['old', 'old', 'first', 'unique']);
    const log = follower();
    await log.changed();
    const dependencies = new Dependencies();
    dependencies.record('records', 'old');
    await withoutRecursiveTriggers('REPLACE INTO replace_records VALUES (?, ?, ?, ?)', [
      'new',
      'new',
      'second',
      'unique',
    ]);

    const changed = await log.changed();

    await expect(store.get(records, 'old')).resolves.toBeNull();
    expect(changed).toHaveLength(1);
    expect(dependencies.changedBy(changed)).toBe(true);
  });

  it('captures an UPDATE OR REPLACE that changes only an undeclared unique column', async () => {
    await sql('INSERT INTO replace_records VALUES (?, ?, ?, ?), (?, ?, ?, ?)', [
      'old',
      'old',
      'first',
      'a',
      'new',
      'new',
      'second',
      'b',
    ]);
    const log = follower();
    await log.changed();
    const dependencies = new Dependencies();
    dependencies.record('records', 'old');
    await withoutRecursiveTriggers(
      'UPDATE OR REPLACE replace_records SET physical_key = ? WHERE id = ?',
      ['a', 'new'],
    );

    const changed = await log.changed();

    await expect(store.get(records, 'old')).resolves.toBeNull();
    expect(changed).toHaveLength(1);
    expect(dependencies.changedBy(changed)).toBe(true);
  });

  it('keeps explicit deletions specific to their prior record and predicates', async () => {
    await sql('INSERT INTO replace_records VALUES (?, ?, ?, ?), (?, ?, ?, ?)', [
      'old',
      'old',
      'first',
      'a',
      'other',
      'other',
      'second',
      'b',
    ]);
    const log = follower();
    await log.changed();
    const deleted = new Dependencies();
    deleted.record('records', 'old');
    const unaffected = new Dependencies();
    unaffected.record('records', 'other');
    unaffected.query('records', { group: 'other' });
    await sql('DELETE FROM replace_records WHERE id = ?', ['old']);

    const changed = await log.changed();

    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ id: 'old', before: { group: 'old' }, after: null });
    expect(deleted.changedBy(changed)).toBe(true);
    expect(unaffected.changedBy(changed)).toBe(false);
  });

  it('captures a generated declared column changed through an undeclared source column', async () => {
    await sql('DROP TABLE replace_records');
    await sql(
      'CREATE TABLE replace_records (id TEXT PRIMARY KEY, "group" TEXT, first_name TEXT, last_name TEXT, title TEXT GENERATED ALWAYS AS (first_name || \' \' || last_name) STORED)',
    );
    const statements = changeCaptureSql(db, 'main', mapping);
    for (const statement of statements) await sql(statement);
    await sql(
      'INSERT INTO replace_records (id, "group", first_name, last_name) VALUES (?, ?, ?, ?)',
      ['one', 'team', 'old', 'name'],
    );
    const log = follower();
    await log.changed();
    const dependencies = new Dependencies();
    dependencies.query('records', { title: 'old name' });

    await sql('UPDATE replace_records SET first_name = ? WHERE id = ?', ['new', 'one']);
    const changed = await log.changed();

    await expect(store.get(records, 'one')).resolves.toMatchObject({
      values: { title: 'new name' },
    });
    expect(changed).toHaveLength(1);
    expect(dependencies.changedBy(changed)).toBe(true);
  });
});
