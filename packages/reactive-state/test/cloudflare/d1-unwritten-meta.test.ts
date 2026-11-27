import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * What the D1 binding answers as Miniflare runs it, which is not production's D1, of a write that
 * wrote nothing: the `meta` the package reads, by `changes` and `rows_written` both 0 and
 * `changed_db` false, to end an operation's statement as unwritten.
 */

describe('what D1 answers of a statement that wrote no row', () => {
  beforeEach(async () => {
    await env.REACTIVE_D1.exec('DROP TABLE IF EXISTS unwritten_tasks');
    await env.REACTIVE_D1.exec('CREATE TABLE unwritten_tasks (id TEXT PRIMARY KEY, title TEXT)');
    await env.REACTIVE_D1.prepare('INSERT INTO unwritten_tasks VALUES (?, ?)')
      .bind('a', 'one')
      .run();
  });

  it('answers 0 changes and 0 rows written of an update that matched no row', async () => {
    const { meta } = await env.REACTIVE_D1.prepare(
      'UPDATE unwritten_tasks SET title = ? WHERE id = ?',
    )
      .bind('two', 'absent')
      .run();

    expect(meta).toMatchObject({ changed_db: false, changes: 0, rows_written: 0 });
  });

  it('answers a row written of an update that matched one', async () => {
    const { meta } = await env.REACTIVE_D1.prepare(
      'UPDATE unwritten_tasks SET title = ? WHERE id = ?',
    )
      .bind('two', 'a')
      .run();

    expect(meta.changed_db).toBe(true);
    expect(meta.changes).toBe(1);
    expect(meta.rows_written).toBeGreaterThan(0);
  });

  it('answers no row from `raw` of an update with returning that matched no row', async () => {
    const rows = await env.REACTIVE_D1.prepare(
      'UPDATE unwritten_tasks SET title = ? WHERE id = ? RETURNING id',
    )
      .bind('two', 'absent')
      .raw();

    expect(rows).toStrictEqual([]);
  });
});
