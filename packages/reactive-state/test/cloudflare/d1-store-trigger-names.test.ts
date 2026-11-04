import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import { changeCaptureSql, d1Executor, d1Store } from '../../src/cloudflare/d1-store.ts';
import { database, table, text } from '../../src/server/schema.ts';

const db = database({
  records: table({ title: text() }, { external: 'main' }),
  Records: table({ title: text() }, { external: 'main' }),
  hex_7265636f726473: table({ title: text() }, { external: 'main' }),
});
const mapping = {
  records: { name: 'lower"records' },
  Records: { name: 'upper records' },
  hex_7265636f726473: { name: 'legacy lookalike' },
};
const physical = ['"lower""records"', '"upper records"', '"legacy lookalike"'];
const declared = Object.keys(mapping);
const executor = d1Executor(env.REACTIVE_D1);
const store = d1Store(executor, mapping);

async function install(): Promise<void> {
  for (const statement of changeCaptureSql(db, 'main', mapping)) {
    await executor.all(statement, []);
  }
}

async function writes(): Promise<void> {
  for (const name of physical) {
    await executor.all(`INSERT INTO ${name} VALUES ('one', 'before')`, []);
    await executor.all(`UPDATE ${name} SET title = 'after' WHERE id = 'one'`, []);
    await executor.all(`DELETE FROM ${name} WHERE id = 'one'`, []);
  }
}

describe('case-sensitive declaration names in D1 triggers', () => {
  beforeEach(async () => {
    for (const name of physical) {
      await executor.all(`DROP TABLE IF EXISTS ${name}`, []);
      await executor.all(`CREATE TABLE ${name} (id TEXT PRIMARY KEY, title TEXT)`, []);
    }
    await executor.all('DROP TABLE IF EXISTS _rs_changes', []);
    await executor.all('DROP TABLE IF EXISTS _rs_meta', []);
  });

  it('captures every event for declarations that differ only by case and quoted mapped tables', async () => {
    await install();
    await writes();

    const page = await store.changes(0, 100);

    expect(page.changes.map((change) => change.table)).toStrictEqual(
      declared.flatMap((name) => [name, name, name]),
    );
    expect(page.changes.map((change) => change.id)).toStrictEqual(
      declared.flatMap(() => ['', '', 'one']),
    );
  });

  it('removes legacy triggers and reinstalls without duplicate captures or namespace collisions', async () => {
    await install();
    for (const event of ['insert', 'update', 'delete']) {
      await executor.all(`DROP TRIGGER IF EXISTS "_rs_records_${event}"`, []);
      await executor.all(
        `CREATE TRIGGER "_rs_records_${event}" AFTER ${event} ON ${physical[0]} BEGIN INSERT INTO _rs_changes (tbl, id, at) VALUES ('records', 'legacy', 0); END`,
        [],
      );
    }
    await install();
    await install();
    await writes();

    const page = await store.changes(0, 100);

    expect(page.changes.map((change) => change.table)).toStrictEqual(
      declared.flatMap((name) => [name, name, name]),
    );
    expect(page.changes.map((change) => change.id)).not.toContain('legacy');
  });
});
