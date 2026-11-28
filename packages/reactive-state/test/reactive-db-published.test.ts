import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { sql } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';

import { hostOf } from '../src/authority/database-host.ts';
import { reactiveDb } from '../src/sql/db.ts';
import { localD1 } from '../src/sql/sqlite/local-d1.ts';

/**
 * `reactiveDb` of a schema of SQLite's tables in a deployment's Function: the D1 its runtime
 * publishes (`upwind.resources`), in place of a file.
 */

const tasks = sqliteTable('tasks', { id: text().primaryKey(), title: text().notNull() });
const RESOURCES = Symbol.for('upwind.resources');

/** What the process has of where the file is, and of what is published: none, unless a test says. */
const environment = { file: process.env['D1_FILE'] };

/** A binding in D1's shape, of memory, closed as the test ends: a stand-in of a deployment's. */
function deployed() {
  const binding = localD1(':memory:');
  onTestFinished(() => {
    binding.close();
  });
  return { ...binding, exec: () => Promise.reject(new Error('Not asked of here.')) };
}

/** Has the runtime publish `resources`, as a deployment's does, until the test ends. */
function published(
  resources: Readonly<Record<string, { type: string; binding: unknown }>>,
  version = 1,
): void {
  Reflect.set(globalThis, RESOURCES, { resources, version });
  onTestFinished(() => {
    Reflect.deleteProperty(globalThis, RESOURCES);
  });
}

describe('reactiveDb of a schema of SQLite in a deployment', () => {
  beforeEach(() => {
    const made = mkdtempSync(path.join(tmpdir(), 'reactive-published-'));
    process.env['D1_FILE'] = path.join(made, 'd1.sqlite');
    onTestFinished(() => {
      rmSync(made, { force: true, recursive: true });
    });
  });

  afterEach(() => {
    if (environment.file === undefined) delete process.env['D1_FILE'];
    else process.env['D1_FILE'] = environment.file;
  });

  it('reads the D1 the deployment publishes, and opens no file', async () => {
    const binding = deployed();
    published({ DB: { binding, type: 'd1' }, KV: { binding: {}, type: 'kv_namespace' } });

    const { db, orm } = await reactiveDb({ tasks });
    onTestFinished(async () => {
      await hostOf(db)?.close();
    });
    await orm.run(sql`CREATE TABLE tasks (id text PRIMARY KEY, title text NOT NULL)`);
    await orm.insert(tasks).values({ id: 'a', title: 'Deployed' });

    await expect(binding.prepare('SELECT title FROM tasks').first('title')).resolves.toBe(
      'Deployed',
    );
    expect(existsSync(process.env['D1_FILE'] ?? '')).toBe(false);
  });

  it('reads what is published as D1 alone, whatever another binding answers', async () => {
    const binding = deployed();
    published({ AI: { binding: deployed(), type: 'ai' }, DB: { binding, type: 'd1' } });

    const { db, orm } = await reactiveDb({ tasks });
    onTestFinished(async () => {
      await hostOf(db)?.close();
    });
    await orm.run(sql`CREATE TABLE tasks (id text PRIMARY KEY, title text NOT NULL)`);

    await expect(
      binding.prepare("SELECT name FROM sqlite_master WHERE name = 'tasks'").first('name'),
    ).resolves.toBe('tasks');
  });

  it('reads a D1 the runtime publishes as one, whatever its methods answer, as a workflow runtime publishes its own', async () => {
    // A stand-in of a binding of a workflow's runtime, whose proxy answers any method of its name.
    const proxied = new Proxy(deployed(), {
      get: (target, key): unknown =>
        (Reflect.get(target, key) as unknown) ?? (() => Promise.resolve()),
    });
    published({ DB: { binding: proxied, type: 'd1' } });

    const { db } = await reactiveDb({ tasks });

    expect(hostOf(db)).toBeDefined();
  });

  it('reads a shape of another version as nothing published, and opens the file', async () => {
    published({ DB: { binding: deployed(), type: 'd1' } }, 2);

    const { db } = await reactiveDb({ tasks });
    onTestFinished(async () => {
      await hostOf(db)?.close();
    });

    expect(existsSync(process.env['D1_FILE'] ?? '')).toBe(true);
  });

  it('reads the one named of several, and refuses to choose of no name', async () => {
    const named = deployed();
    published({ A: { binding: deployed(), type: 'd1' }, B: { binding: named, type: 'd1' } });

    await expect(reactiveDb({ tasks })).rejects.toThrow("reactiveDb(schema, { binding: 'A' })");

    const { db, orm } = await reactiveDb({ tasks }, { binding: 'B' });
    onTestFinished(async () => {
      await hostOf(db)?.close();
    });
    await orm.run(sql`CREATE TABLE tasks (id text PRIMARY KEY, title text NOT NULL)`);

    await expect(
      named.prepare("SELECT name FROM sqlite_master WHERE name = 'tasks'").first('name'),
    ).resolves.toBe('tasks');
  });

  it('says so of a deployment that publishes no D1, and leaves migrations to its deploy', async () => {
    published({ KV: { binding: {}, type: 'kv_namespace' } });

    await expect(reactiveDb({ tasks })).rejects.toThrow(
      'No D1 database is published to this deployment',
    );

    published({ DB: { binding: deployed(), type: 'd1' } });
    const { db } = await reactiveDb({ tasks });

    await expect(hostOf(db)?.migrate('drizzle')).rejects.toThrow('its own deploy');
  });
});
