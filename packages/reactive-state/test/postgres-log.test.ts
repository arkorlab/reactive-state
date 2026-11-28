import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { drizzle } from 'drizzle-orm/node-postgres';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import type { Client } from 'pg';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { hostOf } from '../src/authority/database-host.ts';
import { TAIL } from '../src/authority/external.ts';
import { startAuthority } from '../src/authority/index.ts';
import { prepare } from '../src/cli/prepare.ts';
import type { Json, RenderScope } from '../src/program.ts';
import { reactiveDb } from '../src/sql/db.ts';
import { followDrizzle } from '../src/sql/index.ts';
import { keyDigest } from '../src/sql/reads.ts';
import { engineOf } from './support/drizzle.ts';
import {
  clientOf,
  databaseOf,
  poolOf,
  SERVER_TIMEOUT_MS,
  SERVER_URL,
  urlOf,
} from './support/postgres.ts';

/**
 * The log under writers of many sessions, which PGlite has not: what `drizzle-log.test.ts` cannot
 * show. A follower reads while they commit, and every entry must reach it in order, at each
 * isolation level, as a miss here is a page gone stale in silence.
 */

const tasks = pgTable('tasks', { id: text().primaryKey(), n: integer().notNull() });
const notes = pgTable('notes', { id: text().primaryKey(), n: integer().notNull() });
const schema = { notes, tasks };
const DDL = `
  CREATE TABLE tasks (id text PRIMARY KEY, n int NOT NULL);
  CREATE TABLE notes (id text PRIMARY KEY, n int NOT NULL);
  INSERT INTO tasks SELECT g::text, 0 FROM generate_series(1, 400) AS g;
  INSERT INTO notes SELECT g::text, 0 FROM generate_series(1, 400) AS g;
`;
/** How many write at once, and how many transactions each commits. */
const WRITERS = { count: 12, each: 60 } as const;
/** How many of a follower's reads a page holds: more than a run writes, so that none is folded. */
const PAGE = 5000;
/** What a follower waits between reads of a log that had nothing new. */
const IDLE_MS = 1;
/** The sessions that hold an advisory lock of this database. */
const ADVISORY_LOCKS_HELD = `
  SELECT pid FROM pg_locks
  WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
`;
/** The advisory locks held of this database. */
const ADVISORY_LOCKS = ADVISORY_LOCKS_HELD;
/** How many new databases a race of two hosts is run on: it shows itself in about one of two. */
const CAPTURE_ROUNDS = 8;
/** A migration of Drizzle's, as `drizzle-kit` writes its journal. */
const JOURNAL = {
  dialect: 'postgresql',
  entries: [
    { breakpoints: true, idx: 0, tag: '0000_first', version: '7', when: 1_700_000_000_000 },
  ],
  version: '7',
};
/** Well below the 10 seconds a pool leaves a connection idle. */
const LOCK_GONE_MS = 3000;
/** Longer than the store's connection waits for a read. */
const PAST_A_READ_MS = TAIL.readTimeoutMs + 500;
/** What a run leaves the last commit to become visible before the follower stops. */
const SETTLE_MS = 200;

/** What a writer's transaction runs: each statement, with its values. */
type Turn = readonly (readonly [string, readonly string[]])[];

/** A database of `ddl`, of the tables `tables` it follows, its log made. */
async function opened(ddl: string, tables: Readonly<Record<string, unknown>>) {
  const { name, owner } = await databaseOf(ddl);
  const follow = followDrizzle(tables as typeof schema);
  for (const statement of follow.captureSql()) await owner.query(statement);
  return { follow, name, owner };
}

/** A follower of `store`, reading as writers commit, until `stop` is called. */
function following(store: ReturnType<ReturnType<typeof followDrizzle<typeof schema>>['store']>) {
  const seen: number[] = [];
  let cursor = 0;
  let unordered = 0;
  const run = { stopped: false };
  const reading = (async () => {
    while (!run.stopped) {
      const page = await store.changes(cursor, PAGE);
      for (const change of page.changes) {
        if (change.seq <= cursor) unordered += 1;
        cursor = change.seq;
        seen.push(change.seq);
      }
      if (page.changes.length === 0) await sleep(IDLE_MS);
    }
  })();
  return {
    stop: async () => {
      await sleep(SETTLE_MS);
      run.stopped = true;
      await reading;
      return { seen, unordered };
    },
  };
}

/** The numbers the log holds, and the marks left of transactions. */
async function logOf(owner: Client) {
  const { rows } = await owner.query<{ seq: number }>(
    'SELECT seq::int AS seq FROM reactive_state.changes ORDER BY seq',
  );
  const marks = await owner.query<{ left: number }>(
    'SELECT count(*)::int AS left FROM reactive_state.marks',
  );
  return { held: rows.map((row) => row.seq), marks: marks.rows[0]?.left };
}

/** `WRITERS.count` writers of `statementsOf` theirs, at `level`: how many transactions committed. */
async function writing(
  name: string,
  level: string,
  statementsOf: (writer: number, turn: number) => Turn,
) {
  const clients = await Promise.all(Array.from({ length: WRITERS.count }, () => clientOf(name)));
  const committed = await Promise.all(
    clients.map(async (client, writer) => {
      let done = 0;
      for (let turn = 0; turn < WRITERS.each; turn += 1) {
        await client.query(`BEGIN ISOLATION LEVEL ${level}`);
        for (const [statement, values] of statementsOf(writer, turn)) {
          await client.query(statement, [...values]);
        }
        await client.query('COMMIT');
        done += 1;
      }
      return done;
    }),
  );
  return committed.reduce((sum, each) => sum + each, 0);
}

/** A pool of the tasks, through what follows it, and the store on a connection of its own. */
async function pooled() {
  const { follow, name, owner } = await opened(DDL, schema);
  const pool = poolOf(name, { max: 4 });
  const tracked = follow.client(pool);
  return { follow, name, orm: drizzle({ client: tracked, schema }), owner, pg: owner, tracked };
}

/** What a render of `read` answers, with the engine that made it. */
async function rendering(setup: Awaited<ReturnType<typeof pooled>>, read: () => unknown) {
  const evaluate = vi.fn(async (_props: Readonly<Record<string, Json>>, $: RenderScope) =>
    $.h('p', null, JSON.stringify(await read())),
  );
  return engineOf(setup, evaluate);
}

/** The table `name` of a writer's own, of the columns of `tasks`. */
function ownTable(name: string) {
  return pgTable(name, { id: text().primaryKey(), n: integer().notNull() });
}

/** What makes the table `name`, of rows to write. */
function ownDdl(name: string) {
  return `CREATE TABLE ${name} (id text PRIMARY KEY, n int NOT NULL); INSERT INTO ${name} SELECT g::text, 0 FROM generate_series(1, 400) AS g;`;
}

/** An application's root, of one migration and a `src/seed.ts` the test counts the calls of. */
function application() {
  const root = mkdtempSync(path.join(tmpdir(), 'reactive-seed-'));
  onTestFinished(() => {
    rmSync(root, { force: true, recursive: true });
  });
  const src = path.join(root, 'src');
  mkdirSync(src);
  mkdirSync(path.join(root, 'drizzle/meta'), { recursive: true });
  writeFileSync(path.join(root, 'drizzle/meta/_journal.json'), JSON.stringify(JOURNAL));
  writeFileSync(path.join(root, 'drizzle/0000_first.sql'), 'CREATE TABLE migrated (id text);');
  writeFileSync(
    path.join(src, 'seed.ts'),
    'export const seed = () => globalThis.seededByTheTest();',
  );
  return { root, src };
}

/** Two of `reactiveDb` on the database `name`, as two processes hold it, closed as the test ends. */
async function twoHosts(name: string) {
  process.env['DATABASE_URL'] = urlOf(name);
  onTestFinished(() => {
    delete process.env['DATABASE_URL'];
  });
  const databases = [await reactiveDb(schema), await reactiveDb(schema)];
  const hosts = databases.flatMap(({ db }) => hostOf(db) ?? []);
  onTestFinished(async () => {
    await Promise.all(hosts.map((host) => host.close()));
  });
  return { databases, hosts };
}

describe.skipIf(SERVER_URL === undefined)('the log on a server of many sessions', () => {
  it.each(['READ COMMITTED', 'REPEATABLE READ'])(
    'reaches a follower whole and in order, of writers of their own rows at %s',
    async (level) => {
      const { follow, name, owner } = await opened(DDL, schema);
      const follower = following(follow.store(await clientOf(name)));

      const committed = await writing(name, level, (writer, turn) => {
        const id = [String(100 + writer * 12 + (turn % 12))];
        return [
          ['UPDATE tasks SET n = n + 1 WHERE id = $1', id],
          ['UPDATE notes SET n = n + 1 WHERE id = $1', id],
        ];
      });
      const { seen, unordered } = await follower.stop();
      const { held, marks } = await logOf(owner);

      expect(committed).toBe(WRITERS.count * WRITERS.each);
      expect(held).toHaveLength(committed * 4);
      expect(seen).toStrictEqual(held);
      expect(unordered).toBe(0);
      expect(marks).toBe(0);
    },
    SERVER_TIMEOUT_MS,
  );

  it(
    'adds no serialization failure of its own, of writers of a table each at SERIALIZABLE',
    async () => {
      const names = Array.from({ length: WRITERS.count }, (_, at) => `own_${String(at)}`);
      const tables = Object.fromEntries(names.map((each) => [each, ownTable(each)]));
      const ddl = names.map((each) => ownDdl(each)).join('');
      const { follow, name, owner } = await opened(ddl, tables);
      const follower = following(follow.store(await clientOf(name)));

      const committed = await writing(name, 'SERIALIZABLE', (writer, turn) => {
        const statement = `UPDATE own_${String(writer)} SET n = n + 1 WHERE id = $1`;
        const id = [String(1 + (turn % 12))];
        return [
          [statement, id],
          [statement, id],
        ];
      });
      const { seen, unordered } = await follower.stop();
      const { held } = await logOf(owner);

      expect(committed).toBe(WRITERS.count * WRITERS.each);
      expect(seen).toStrictEqual(held);
      expect(unordered).toBe(0);
    },
    SERVER_TIMEOUT_MS,
  );

  it(
    'holds no writer or follower behind an open transaction',
    async () => {
      const { follow, name, owner } = await opened(DDL, schema);
      const store = follow.store(owner);
      const [open, other] = await Promise.all([clientOf(name), clientOf(name)]);
      const { head } = await store.changes(0, 10);

      await open.query('BEGIN');
      await open.query("UPDATE tasks SET n = 1 WHERE id = '1'");
      // Each of these would wait for that commit on a log that orders its writers.
      await other.query("UPDATE tasks SET n = 1 WHERE id = '2'");
      const page = await store.changes(head, 10);

      expect(page.changes.map(({ after, before }) => after ?? before)).toStrictEqual([
        { k_id: keyDigest('2') },
        { k_id: keyDigest('2') },
      ]);

      await open.query('COMMIT');

      await expect(store.changes(page.head, 10)).resolves.toMatchObject({
        changes: [{ before: { k_id: keyDigest('1') } }, { after: { k_id: keyDigest('1') } }],
      });
    },
    SERVER_TIMEOUT_MS,
  );

  it(
    'numbers transactions in the order they commit',
    async () => {
      const { follow, name, owner } = await opened(DDL, schema);
      const [first, second] = await Promise.all([clientOf(name), clientOf(name)]);
      await first.query('BEGIN');
      await second.query('BEGIN');
      await first.query("UPDATE tasks SET n = 1 WHERE id = '1'");
      await second.query("UPDATE tasks SET n = 1 WHERE id = '2'");

      await second.query('COMMIT');
      await first.query('COMMIT');

      const { changes } = await follow.store(owner).changes(0, 10);

      expect(
        changes.flatMap(({ after }) => (after === null ? [] : [after?.['k_id']])),
      ).toStrictEqual([keyDigest('2'), keyDigest('1')]);
    },
    SERVER_TIMEOUT_MS,
  );

  it(
    'makes one log of hosts that start at once on a new database',
    async () => {
      const { name, owner } = await databaseOf(DDL);
      const follow = followDrizzle(schema);
      const hosts = await Promise.all([clientOf(name), clientOf(name), clientOf(name)]);

      await Promise.all(
        hosts.map(async (host) => {
          for (const statement of follow.captureSql()) await host.query(statement);
        }),
      );
      await owner.query("UPDATE tasks SET n = 1 WHERE id = '1'");

      await expect(follow.store(owner).changes(0, 10)).resolves.toMatchObject({
        changes: [{ seq: 1 }, { seq: 2 }],
      });
    },
    SERVER_TIMEOUT_MS,
  );

  it(
    'starts beside an open writer of a table whose triggers stand, which it waits on not',
    async () => {
      const { follow, name, owner } = await opened(DDL, schema);
      const writer = await clientOf(name);
      await writer.query('BEGIN');
      await writer.query("UPDATE tasks SET n = 1 WHERE id = '1'");

      // None of these returns if it waits for that commit: nothing here commits it.
      for (const statement of follow.captureSql()) {
        await expect(owner.query(statement)).resolves.toBeDefined();
      }

      await writer.query('COMMIT');
    },
    SERVER_TIMEOUT_MS,
  );

  it(
    'loses no commit to starts and prunes among writers',
    async () => {
      const { follow, name, owner } = await opened(DDL, schema);
      const [reader, pruner, host] = await Promise.all([
        clientOf(name),
        clientOf(name),
        clientOf(name),
      ]);
      const store = follow.store(reader);
      const run = { stopped: false };
      let lowered = 0;
      let last = 0;
      const looping = async (turn: () => Promise<unknown>) => {
        while (!run.stopped) {
          await turn();
          await sleep(IDLE_MS);
        }
      };
      const running = [
        looping(async () => {
          const { head } = await store.changes(last, PAGE);
          if (head < last) lowered += 1;
          last = head;
        }),
        looping(() => follow.prune(pruner, Date.now() - 50)),
        looping(async () => {
          for (const statement of follow.captureSql()) await host.query(statement);
        }),
      ];

      const statement = 'UPDATE tasks SET n = n + 1 WHERE id = $1';
      const turnOf = (writer: number): Turn => [[statement, [String(10 + writer)]]];

      const committed = await writing(name, 'READ COMMITTED', turnOf);
      run.stopped = true;
      await Promise.all(running);
      const { marks } = await logOf(owner);

      expect(committed).toBe(WRITERS.count * WRITERS.each);
      expect(lowered).toBe(0);
      expect(marks).toBe(0);
    },
    SERVER_TIMEOUT_MS,
  );
});

describe.skipIf(SERVER_URL === undefined)('a pool on a server of many sessions', () => {
  it(
    'renders beside a transaction open on a row, and writes another',
    async () => {
      const setup = await pooled();
      const open = await clientOf(setup.name);
      const { render } = await rendering(setup, () => setup.orm.select().from(tasks).limit(1));
      await open.query('BEGIN');
      await open.query("UPDATE tasks SET n = 9 WHERE id = '1'");

      // Neither returns if it waits for that commit: nothing here commits it.
      await expect(render()).resolves.toBeDefined();
      await expect(
        setup.tracked.query("UPDATE tasks SET n = 9 WHERE id = '2'"),
      ).resolves.toBeDefined();

      await open.query('ROLLBACK');
    },
    SERVER_TIMEOUT_MS,
  );

  it(
    'tells a host that listens of a commit of another session, once',
    async () => {
      const setup = await pooled();
      const { engine, render } = await rendering(setup, async () => {
        const { rows } = await setup.tracked.query<{ n: number }>(
          "SELECT n FROM tasks WHERE id = '1'",
        );
        return rows;
      });

      await expect(render()).resolves.toContain('"n":0');

      // As the package's README sets it up. The engine polls once a minute here.
      const listening = await clientOf(setup.name);
      const heard = vi.fn();
      const marked = vi.fn();
      // A notice of the sender's own, sent after the commit's: the server delivers one session's
      // notices in the order they were sent, so what the log's channel says of the commit has been
      // said by the time this one is heard.
      const marker = `${setup.follow.channel}_heard`;
      listening.on('notification', (message) => {
        (message.channel === marker ? marked : heard)();
      });
      await listening.query(`LISTEN ${setup.follow.channel}`);
      await listening.query(`LISTEN ${marker}`);

      await setup.owner.query("UPDATE tasks SET n = 7 WHERE id = '1'");
      await setup.owner.query(`NOTIFY ${marker}`);

      await vi.waitFor(() => {
        expect(marked).toHaveBeenCalledTimes(1);
      });

      expect(heard).toHaveBeenCalledTimes(1);

      await engine.poke();

      await expect(render()).resolves.toContain('"n":7');
    },
    SERVER_TIMEOUT_MS,
  );

  it(
    'wakes the authority of `reactiveDb`, of a commit of another session',
    async () => {
      const { name, owner } = await databaseOf(DDL);
      process.env['DATABASE_URL'] = urlOf(name);
      onTestFinished(() => {
        delete process.env['DATABASE_URL'];
      });
      const { db } = await reactiveDb(schema);
      const authority = await startAuthority({ buildId: 'b_server', database: db, programs: [] });
      onTestFinished(() => authority.close());
      const poke = vi.spyOn(authority.engine, 'poke');

      await owner.query("UPDATE tasks SET n = 7 WHERE id = '1'");

      await vi.waitFor(() => {
        expect(poke).toHaveBeenCalledTimes(1);
      });
    },
    SERVER_TIMEOUT_MS,
  );

  it(
    'migrates a new database and runs the seed of one of two hosts that start at once',
    async () => {
      const { name, owner } = await databaseOf(DDL);
      const { databases, hosts } = await twoHosts(name);
      const { root, src } = application();
      const seed = vi.fn(() => sleep(SETTLE_MS));
      vi.stubGlobal('seededByTheTest', seed);
      onTestFinished(() => {
        vi.unstubAllGlobals();
      });

      await Promise.all(databases.map(({ db }) => prepare(db, root, src)));

      expect(seed).toHaveBeenCalledTimes(1);
      await expect(owner.query('SELECT 1 FROM migrated')).resolves.toBeDefined();
      expect(hosts).toHaveLength(2);

      // Let go of at once, not as the pool closes an idle connection, which holds the next start.
      await expect
        .poll(async () => (await owner.query(ADVISORY_LOCKS)).rowCount, { timeout: LOCK_GONE_MS })
        .toBe(0);
    },
    SERVER_TIMEOUT_MS,
  );

  it(
    'notes the seed though the connection that held the lock was lost',
    async () => {
      const { name, owner } = await databaseOf(DDL);
      const { hosts } = await twoHosts(name);
      const [host] = hosts;
      vi.spyOn(console, 'error').mockImplementation(vi.fn());
      const seed = vi.fn(async () => {
        await owner.query(`SELECT pg_terminate_backend(pid) FROM (${ADVISORY_LOCKS_HELD}) AS held`);
      });

      await host?.alone(() => host.seed(seed));
      await host?.alone(() => host.seed(seed));

      expect(seed).toHaveBeenCalledTimes(1);
    },
    SERVER_TIMEOUT_MS,
  );

  it(
    'makes its note under the lock the log is made under, as the two make one schema',
    async () => {
      for (let round = 0; round < CAPTURE_ROUNDS; round += 1) {
        const { name } = await databaseOf(DDL);
        const { hosts } = await twoHosts(name);
        const [making, noting] = hosts;
        const first = vi.fn<() => Promise<void>>();

        await expect(Promise.all([making?.open(), noting?.seed(first)])).resolves.toBeDefined();
      }
    },
    SERVER_TIMEOUT_MS,
  );

  it(
    "makes the log and prunes it past a read's deadline, as each may wait on a writer",
    async () => {
      const { name, owner } = await databaseOf(DDL);
      process.env['DATABASE_URL'] = urlOf(name);
      onTestFinished(() => {
        delete process.env['DATABASE_URL'];
      });
      const { db } = await reactiveDb(schema);

      await owner.query("BEGIN; UPDATE tasks SET n = 7 WHERE id = '1'");
      const starting = startAuthority({ buildId: 'b_server', database: db, programs: [] });
      await sleep(PAST_A_READ_MS);
      await owner.query('COMMIT');
      const authority = await starting;
      onTestFinished(() => authority.close());

      await owner.query('BEGIN; LOCK TABLE reactive_state.head IN ACCESS EXCLUSIVE MODE');
      const pruned = hostOf(db)?.prune();
      await sleep(PAST_A_READ_MS);
      await owner.query('COMMIT');

      await expect(pruned).resolves.toBeUndefined();
    },
    SERVER_TIMEOUT_MS,
  );

  it(
    'runs no statement of a text of several as a render plans it',
    async () => {
      const setup = await pooled();
      const { render } = await rendering(setup, () =>
        setup.tracked.query('SELECT 1; DELETE FROM tasks'),
      );

      await expect(render()).rejects.toThrow(/a text of several statements/u);
      await expect(setup.owner.query('SELECT 1 FROM tasks')).resolves.toMatchObject({
        rowCount: 400,
      });
    },
    SERVER_TIMEOUT_MS,
  );

  it(
    "reads none of what another connection's transaction has not committed",
    async () => {
      const setup = await pooled();
      const { render } = await rendering(setup, async () => {
        const { rows } = await setup.tracked.query<{ n: number }>(
          "SELECT n FROM tasks WHERE id = '1'",
        );
        return rows;
      });
      const held = await setup.tracked.connect();
      onTestFinished(() => {
        held.release();
      });
      await held.query('BEGIN');
      await held.query("UPDATE tasks SET n = 7 WHERE id = '1'");

      await expect(render()).resolves.toContain('"n":0');

      await held.query('ROLLBACK');
    },
    SERVER_TIMEOUT_MS,
  );
});
