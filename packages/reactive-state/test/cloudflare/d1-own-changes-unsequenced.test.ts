import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { followDrizzle } from '../../src/sql/index.ts';
import { ownChanges } from '../../src/sql/sqlite/own-changes.ts';
import { changesOf, ownSchema, tablesOf } from '../support/own-changes-cases.ts';

/**
 * A D1 binding whose answers count each statement's own changes (`ownChanges`), of a database of
 * Miniflare's that has never held a table of `AUTOINCREMENT`, so of no `sqlite_sequence`: a file of
 * its own, as the database outlives each test of a file and `sqlite_sequence` outlives its tables.
 */

const db = env.REACTIVE_D1;
const INSERT = "INSERT INTO own_tasks (id, project_id, title) VALUES (?, 'p', 't')";

describe('ownChanges of a D1 database of no sqlite_sequence', () => {
  it('runs a write as it is, and counts the very next once a log is made', async () => {
    await expect(
      db
        .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'sqlite_sequence'")
        .first('n'),
    ).resolves.toBe(0);

    await db.batch(tablesOf('own_').map((statement) => db.prepare(statement)));
    const counted = ownChanges(db);

    const first = await counted.prepare(INSERT).bind(1).run();
    await db.batch(
      followDrizzle(ownSchema)
        .captureSql()
        .map((statement) => db.prepare(statement)),
    );
    const second = await counted.prepare(INSERT).bind(2).run();
    const plain = await db.prepare(INSERT).bind(3).run();

    expect(changesOf([first, second, plain])).toStrictEqual([1, 1, 2]);
  });
});
