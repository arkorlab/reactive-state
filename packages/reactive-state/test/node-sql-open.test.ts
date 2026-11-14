import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { nodeSql } from '../src/authority/node-sql.ts';

/**
 * A database the Node driver cannot open as it opens one: a file SQLite opens, and whose first
 * `PRAGMA` it then refuses, as it refuses any statement of a file that is no SQLite database. The
 * driver lets go of the file again, as the engine does where it refuses what it opened
 * (`node-engine.ts`), rather than hold it until the connection is collected.
 */

describe('a database the Node driver cannot open', () => {
  it('lets go of the file it opened, a file that is no SQLite database', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'reactive-node-sql-'));
    onTestFinished(async () => {
      await rm(directory, { force: true, recursive: true });
    });
    const filename = path.join(directory, 'app.sqlite');
    await writeFile(filename, 'no SQLite database, '.repeat(64));
    // The connection the driver opened, as the statement it runs first is run on it.
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec');
    onTestFinished(() => {
      exec.mockRestore();
    });

    expect(() => nodeSql(filename)).toThrow('file is not a database');

    const [opened] = exec.mock.contexts as readonly unknown[];

    expect(opened).toBeInstanceOf(DatabaseSync);
    expect((opened as DatabaseSync).isOpen).toBe(false);
  });
});
