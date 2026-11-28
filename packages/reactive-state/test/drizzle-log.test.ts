import { pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { followDrizzle } from '../src/sql/index.ts';
import { keyDigest } from '../src/sql/reads.ts';
import { type Opened, openedWith } from './support/drizzle.ts';
import { ownStore, storeThrough } from './support/follow-store.ts';

/**
 * The log as a transaction writes it: what its statements changed is held until it commits, then
 * numbered at once, under a lock no writer holds before its commit. No statement of a writer reads
 * the log or takes a row of it, so writers of many sessions wait on nothing but the commit before
 * them. That needs many sessions to show, which a PGlite has not.
 */

const tasks = pgTable('tasks', { id: text().primaryKey(), title: text().notNull() });
const DDL = 'CREATE TABLE tasks (id text PRIMARY KEY, title text NOT NULL)';
const schema = { tasks };
/** Each test makes a PGlite of its own, as long as a second and more under load. */
const TEST_TIMEOUT_MS = 20_000;
/**
 * More than the log holds of one transaction, in statements of a row of this title's, and how long
 * those statements may take of a PGlite under load.
 */
const PAST_HOLD = { rows: 3000, timeoutMs: 60_000, title: 'x'.repeat(10) } as const;

type Setup = Opened<typeof schema>;

/** The log's entries, each by the row it names, or by `''` of the table alone. */
async function entriesOf(setup: Setup) {
  const { changes } = await ownStore(setup.follow).changes(0, 10_000);
  return changes.map((change) => change.after?.['k_id'] ?? change.before?.['k_id'] ?? '');
}

/** What the log's own bookkeeping holds: the rows of its marks, and how many entries it keeps. */
async function countsOf({ pg }: Setup) {
  const { rows } = await pg.query<{ marks: string; entries: string }>(
    'SELECT (SELECT count(*) FROM reactive_state.marks)::text AS marks, (SELECT count(*) FROM reactive_state.changes)::text AS entries',
  );
  return rows[0];
}

/** A row's version of the head: another once any statement wrote or locked it. */
async function headVersionOf({ pg }: Setup) {
  const { rows } = await pg.query<{ version: string }>(
    'SELECT xmin::text || xmax::text AS version FROM reactive_state.head',
  );
  return rows[0]?.version;
}

describe("the log of a transaction's writes", () => {
  it(
    'holds entries until the commit, and writes no row of the log before it',
    async () => {
      const setup = await openedWith(schema, DDL);
      const head = await headVersionOf(setup);

      await setup.pg.exec('BEGIN');
      await setup.pg.query("INSERT INTO tasks VALUES ('a', 'one')");
      await setup.pg.query("INSERT INTO tasks VALUES ('b', 'two')");

      await expect(countsOf(setup)).resolves.toMatchObject({ entries: '0' });
      await expect(headVersionOf(setup)).resolves.toBe(head);

      await setup.pg.exec('COMMIT');

      await expect(entriesOf(setup)).resolves.toStrictEqual([keyDigest('a'), keyDigest('b')]);
      await expect(countsOf(setup)).resolves.toStrictEqual({ entries: '2', marks: '0' });
      await expect(headVersionOf(setup)).resolves.toBe(head);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'numbers an update of a row before and after, in the order they were written',
    async () => {
      const setup = await openedWith(schema, DDL);

      await setup.pg.exec("BEGIN; INSERT INTO tasks VALUES ('a', 'one')");
      await setup.pg.exec("UPDATE tasks SET id = 'b' WHERE id = 'a'; COMMIT");

      const { changes } = await ownStore(setup.follow).changes(0, 10);

      expect(changes.map(({ after, before, seq }) => [seq, after, before])).toStrictEqual([
        [1, { k_id: keyDigest('a') }, null],
        [2, null, { k_id: keyDigest('a') }],
        [3, { k_id: keyDigest('b') }, null],
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps none of a transaction rolled back, and its number is no gap a follower reads',
    async () => {
      const setup = await openedWith(schema, DDL);
      await setup.pg.query("INSERT INTO tasks VALUES ('a', 'one')");
      const store = ownStore(setup.follow);
      const before = await store.changes(0, 10);

      await setup.pg.exec("BEGIN; INSERT INTO tasks VALUES ('b', 'two'); ROLLBACK");

      await expect(store.changes(0, 10)).resolves.toStrictEqual(before);
      await expect(countsOf(setup)).resolves.toStrictEqual({ entries: '1', marks: '0' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps what a savepoint kept, though the first statement of the transaction is rolled back',
    async () => {
      const setup = await openedWith(schema, DDL);

      await setup.pg.exec(`
        BEGIN;
        SAVEPOINT first;
        INSERT INTO tasks VALUES ('a', 'one');
        ROLLBACK TO first;
        INSERT INTO tasks VALUES ('b', 'two');
        SAVEPOINT second;
        INSERT INTO tasks VALUES ('c', 'three');
        ROLLBACK TO second;
        SAVEPOINT third;
        INSERT INTO tasks VALUES ('d', 'four');
        RELEASE third;
        COMMIT;
      `);

      await expect(entriesOf(setup)).resolves.toStrictEqual([keyDigest('b'), keyDigest('d')]);
      await expect(countsOf(setup)).resolves.toMatchObject({ marks: '0' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps the writes of a function that caught an error of its own',
    async () => {
      const setup = await openedWith(schema, DDL);

      await setup.pg.exec(`
        DO $$
        BEGIN
          INSERT INTO tasks VALUES ('a', 'one');
          BEGIN
            INSERT INTO tasks VALUES ('b', 'two');
            INSERT INTO tasks VALUES ('a', 'taken');
          EXCEPTION WHEN unique_violation THEN NULL;
          END;
        END $$
      `);

      await expect(entriesOf(setup)).resolves.toStrictEqual([keyDigest('a')]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'numbers each write of a transaction whose constraints were set to run at once',
    async () => {
      const setup = await openedWith(schema, DDL);

      await setup.pg.exec(`
        BEGIN;
        INSERT INTO tasks VALUES ('a', 'one');
        SET CONSTRAINTS ALL IMMEDIATE;
        INSERT INTO tasks VALUES ('b', 'two');
        INSERT INTO tasks VALUES ('c', 'three');
        COMMIT;
      `);

      await expect(entriesOf(setup)).resolves.toStrictEqual([
        keyDigest('a'),
        keyDigest('b'),
        keyDigest('c'),
      ]);
      await expect(countsOf(setup)).resolves.toStrictEqual({ entries: '3', marks: '0' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps none of what constraints run at once numbered, in a savepoint rolled back, and holds the rest',
    async () => {
      const setup = await openedWith(schema, DDL);

      await setup.pg.exec(`
        BEGIN;
        INSERT INTO tasks VALUES ('a', 'one');
        SAVEPOINT late;
        SET CONSTRAINTS ALL IMMEDIATE;
        INSERT INTO tasks VALUES ('b', 'two');
        ROLLBACK TO late;
        INSERT INTO tasks VALUES ('c', 'three');
        COMMIT;
      `);

      await expect(entriesOf(setup)).resolves.toStrictEqual([keyDigest('a'), keyDigest('c')]);
      await expect(countsOf(setup)).resolves.toMatchObject({ marks: '0' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "takes the log's lock after the application's deferred constraints, which may take long",
    async () => {
      const setup = await openedWith(
        schema,
        `${DDL};
        CREATE TABLE seen (locked boolean NOT NULL);
        CREATE FUNCTION checked() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          INSERT INTO seen SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid());
          RETURN NULL;
        END $$;
        CREATE CONSTRAINT TRIGGER checked AFTER INSERT ON tasks DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION checked();`,
      );

      // The second statement's check is queued after the transaction's mark.
      await setup.pg.exec(`
        BEGIN;
        INSERT INTO tasks VALUES ('a', 'one');
        INSERT INTO tasks VALUES ('b', 'two');
        COMMIT;
      `);

      await expect(setup.pg.query('SELECT locked FROM seen')).resolves.toMatchObject({
        rows: [{ locked: false }, { locked: false }],
      });
      await expect(entriesOf(setup)).resolves.toStrictEqual([keyDigest('a'), keyDigest('b')]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "numbers what the application's deferred trigger wrote as the transaction commits",
    async () => {
      const setup = await openedWith(
        schema,
        `${DDL};
        CREATE FUNCTION copied() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.id NOT LIKE 'copy%' THEN INSERT INTO tasks VALUES ('copy' || NEW.id, NEW.title); END IF;
          RETURN NULL;
        END $$;
        CREATE CONSTRAINT TRIGGER copied AFTER INSERT ON tasks DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION copied();`,
      );

      await setup.pg.query("INSERT INTO tasks VALUES ('a', 'one')");

      await expect(entriesOf(setup)).resolves.toStrictEqual([keyDigest('a'), keyDigest('copya')]);
      await expect(countsOf(setup)).resolves.toMatchObject({ marks: '0' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'leaves nothing of a commit that failed once it was numbered, but a gap of its numbers',
    async () => {
      const setup = await openedWith(
        schema,
        `${DDL};
        CREATE TABLE audit (id text);
        CREATE FUNCTION refused() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          RAISE EXCEPTION 'refused';
        END $$;
        CREATE CONSTRAINT TRIGGER refused AFTER INSERT ON audit DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION refused();
        CREATE FUNCTION audited() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          INSERT INTO audit VALUES (NEW.id);
          RETURN NULL;
        END $$;
        CREATE CONSTRAINT TRIGGER audited AFTER INSERT ON tasks DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW WHEN (NEW.id = 'b') EXECUTE FUNCTION audited();`,
      );
      const store = ownStore(setup.follow);
      await setup.pg.query("INSERT INTO tasks VALUES ('first', 'one')");

      // The audit's refusal is queued behind the mark that numbers the entries.
      await setup.pg.exec("BEGIN; INSERT INTO tasks VALUES ('a', 'one')");
      await setup.pg.exec("INSERT INTO tasks VALUES ('b', 'two')");

      await expect(setup.pg.exec('COMMIT')).rejects.toThrow('refused');

      await setup.pg.query("INSERT INTO tasks VALUES ('c', 'three')");

      await expect(store.changes(1, 10)).resolves.toMatchObject({
        changes: [{ after: { k_id: keyDigest('c') }, seq: 4 }],
        floor: 1,
        head: 4,
      });
      await expect(countsOf(setup)).resolves.toStrictEqual({ entries: '2', marks: '0' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'tells the whole table once a transaction held all it holds, and grows by no more',
    async () => {
      const setup = await openedWith(schema, DDL);

      await setup.pg.exec(`
        BEGIN;
        DO $$ BEGIN
          FOR i IN 1..${String(PAST_HOLD.rows)} LOOP
            INSERT INTO tasks VALUES (i::text, '${PAST_HOLD.title}');
          END LOOP;
        END $$;
        COMMIT;
      `);

      const entries = await entriesOf(setup);

      // Rows up to what it holds, then the table alone, whichever statements came after.
      expect(entries.length).toBeLessThan(PAST_HOLD.rows);
      expect(entries.filter((entry) => entry === '')).toHaveLength(1);
      expect(entries.at(-1)).toBe('');
    },
    PAST_HOLD.timeoutMs,
  );

  it.each(['RESET ALL', "SET LOCAL reactive_state.held = 'x'"])(
    'renders everything again where `%s` took what a transaction held',
    async (taken) => {
      const setup = await openedWith(schema, DDL);
      const store = ownStore(setup.follow);
      const { epoch } = await store.changes(0, 10);

      await setup.pg.exec(`BEGIN; INSERT INTO tasks VALUES ('a', 'one'); ${taken}; COMMIT`);

      const read = await store.changes(0, 10);

      expect(read.epoch).not.toBe(epoch);
      await expect(countsOf(setup)).resolves.toStrictEqual({ entries: '0', marks: '0' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'writes the entries of a role that holds no right of the log',
    async () => {
      const setup = await openedWith(schema, DDL);
      await setup.pg.exec(`
        CREATE ROLE writer;
        GRANT SELECT, INSERT, DELETE, TRUNCATE ON tasks TO writer;
        SET ROLE writer;
        INSERT INTO tasks VALUES ('a', 'one');
        BEGIN;
        DELETE FROM tasks;
        COMMIT;
        TRUNCATE tasks;
        RESET ROLE;
      `);

      await expect(entriesOf(setup)).resolves.toStrictEqual([keyDigest('a'), keyDigest('a'), '']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'numbers what a role wrote though the transaction left the role before its commit',
    async () => {
      const setup = await openedWith(schema, DDL);
      await setup.pg.exec(`
        CREATE ROLE writer;
        CREATE ROLE other;
        GRANT INSERT ON tasks TO writer;
        BEGIN;
        SET LOCAL ROLE writer;
        INSERT INTO tasks VALUES ('a', 'one');
        SET LOCAL ROLE other;
        COMMIT;
      `);

      await expect(entriesOf(setup)).resolves.toStrictEqual([keyDigest('a')]);
    },
    TEST_TIMEOUT_MS,
  );

  it.each(['hold(NULL)', "hold('[]')", "note('public', 'tasks')"])(
    "lets a role that may use the log's schema call no %s",
    async (call) => {
      const setup = await openedWith(schema, DDL);
      await setup.pg.exec(`
        CREATE ROLE reader;
        GRANT USAGE ON SCHEMA reactive_state TO reader;
        SET ROLE reader;
      `);

      await expect(setup.pg.query(`SELECT reactive_state.${call}`)).rejects.toThrow(
        'permission denied',
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'numbers what a transaction wrote before it turned to the role of a replica',
    async () => {
      const setup = await openedWith(schema, DDL);

      await setup.pg.exec(`
        BEGIN;
        INSERT INTO tasks VALUES ('a', 'one');
        SET LOCAL session_replication_role = replica;
        COMMIT;
      `);

      await expect(entriesOf(setup)).resolves.toStrictEqual([keyDigest('a')]);
      await expect(countsOf(setup)).resolves.toStrictEqual({ entries: '1', marks: '0' });
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    ['of the session', "SET reactive_state.held = 'x'; INSERT INTO tasks VALUES ('a', 'one')"],
    [
      'of the transaction',
      "BEGIN; SET LOCAL reactive_state.held = '[]'; INSERT INTO tasks VALUES ('a', 'one'); COMMIT",
    ],
    ['that names the table', `SET reactive_state.held = '["public", "tasks"]'; TRUNCATE tasks`],
  ])(
    'takes no word of a setting %s that holds no entry of this transaction',
    async (_what, statements) => {
      const setup = await openedWith(schema, DDL);

      await setup.pg.exec(statements);

      await expect(entriesOf(setup)).resolves.toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'fails the commit of a transaction turned read-only, of which nothing lands',
    async () => {
      const setup = await openedWith(schema, DDL);
      await setup.pg.exec("BEGIN; INSERT INTO tasks VALUES ('a', 'one')");
      await setup.pg.exec('SET TRANSACTION READ ONLY');

      await expect(setup.pg.exec('COMMIT')).rejects.toThrow('read-only transaction');

      await setup.pg.exec('ROLLBACK');

      await expect(setup.pg.query('SELECT 1 FROM tasks')).resolves.toMatchObject({ rows: [] });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'writes each log a table is followed by, of a namespace each',
    async () => {
      const setup = await openedWith(schema, DDL);
      const second = followDrizzle(schema, { namespace: 'log_two' });
      for (const statement of second.captureSql()) await setup.pg.query(statement);

      await setup.pg.query("INSERT INTO tasks VALUES ('a', 'one')");

      await expect(entriesOf(setup)).resolves.toStrictEqual([keyDigest('a')]);

      const { changes } = await storeThrough(second, setup.pg).changes(0, 10);

      expect(changes.map((change) => change.after?.['k_id'])).toStrictEqual([keyDigest('a')]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'notifies its channel once a transaction, as it commits',
    async () => {
      const setup = await openedWith(schema, DDL);
      const heard: string[] = [];
      await setup.pg.listen(setup.follow.channel, (payload) => {
        heard.push(payload);
      });

      await setup.pg.exec(`
        BEGIN;
        INSERT INTO tasks VALUES ('a', 'one');
        INSERT INTO tasks VALUES ('b', 'two');
        COMMIT;
      `);

      await expect.poll(() => heard).toStrictEqual(['2']);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the head of the log', () => {
  it(
    'reads as the last number kept, in the read that reads the entries',
    async () => {
      const setup = await openedWith(schema, DDL);
      const store = ownStore(setup.follow);

      await expect(store.changes(0, 10)).resolves.toMatchObject({ floor: 0, head: 0 });

      await setup.pg.query("INSERT INTO tasks VALUES ('a', 'one'), ('b', 'two')");

      await expect(store.changes(0, 10)).resolves.toMatchObject({ floor: 1, head: 2 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reads past a gap of the numbers a failed commit took',
    async () => {
      const setup = await openedWith(schema, DDL);
      await setup.pg.query("INSERT INTO tasks VALUES ('a', 'one')");
      // Taken and never written, as of a commit that failed once it was numbered.
      await setup.pg.query("SELECT nextval('reactive_state.changes_seq')");
      await setup.pg.query("INSERT INTO tasks VALUES ('b', 'two')");

      const read = await ownStore(setup.follow).changes(1, 10);

      expect(read.floor).toBe(1);
      expect(read.head).toBe(3);
      expect(read.changes.map(({ seq }) => seq)).toStrictEqual([3]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'tells a follower of entries let go of by a delete of no prune',
    async () => {
      const setup = await openedWith(schema, DDL);
      await setup.pg.query("INSERT INTO tasks VALUES ('a', 'one'), ('b', 'two'), ('c', 'three')");

      await setup.pg.query('DELETE FROM reactive_state.changes WHERE seq <= 2');

      await expect(ownStore(setup.follow).changes(1, 10)).resolves.toMatchObject({
        floor: 3,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders everything again, and numbers past the log, once a read finds the sequence behind it',
    async () => {
      const setup = await openedWith(schema, DDL);
      const store = ownStore(setup.follow);
      await setup.pg.query("INSERT INTO tasks VALUES ('a', 'one'), ('b', 'two'), ('c', 'three')");
      await setup.follow.prune(setup.pg, Date.now() + 60_000);
      await setup.pg.query("INSERT INTO tasks VALUES ('d', 'four'), ('e', 'five')");
      const { epoch } = await store.changes(5, 10);
      // A subscriber promoted: the entries came, and the sequence did not.
      await setup.pg.query("SELECT setval('reactive_state.changes_seq', 1, false)");

      // Below what a follower has read: this entry alone cannot tell it.
      await setup.pg.query("INSERT INTO tasks VALUES ('f', 'six')");

      await expect(store.changes(5, 10)).resolves.toMatchObject({ changes: [], head: 5 });
      await expect(store.changes(5, 10)).resolves.not.toMatchObject({ epoch });

      await setup.pg.query("INSERT INTO tasks VALUES ('g', 'seven')");

      await expect(store.changes(5, 10)).resolves.toMatchObject({ changes: [{ seq: 6 }], head: 6 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'finds the sequence behind the log at the number of its last entry, which the next would take',
    async () => {
      const setup = await openedWith(schema, DDL);
      const store = ownStore(setup.follow);
      await setup.pg.query("INSERT INTO tasks VALUES ('a', 'one'), ('b', 'two')");
      await setup.pg.query("SELECT setval('reactive_state.changes_seq', 1)");

      await store.changes(0, 10);
      await setup.pg.query("INSERT INTO tasks VALUES ('c', 'three')");

      await expect(store.changes(2, 10)).resolves.toMatchObject({ changes: [{ seq: 3 }] });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'stays at the last entry pruned, whose floor follows it, and takes no number back',
    async () => {
      const setup = await openedWith(schema, DDL);
      const store = ownStore(setup.follow);
      await setup.pg.query("INSERT INTO tasks VALUES ('a', 'one'), ('b', 'two')");

      await setup.follow.prune(setup.pg, Date.now() + 60_000);

      await expect(store.changes(0, 10)).resolves.toMatchObject({
        changes: [],
        floor: 3,
        head: 2,
      });

      await setup.pg.query("INSERT INTO tasks VALUES ('c', 'three')");

      await expect(store.changes(2, 10)).resolves.toMatchObject({
        changes: [{ seq: 3 }],
        floor: 3,
        head: 3,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'prunes as a role of no right of the log but what reads it',
    async () => {
      const setup = await openedWith(schema, DDL);
      await setup.pg.query("INSERT INTO tasks VALUES ('a', 'one')");
      await setup.pg.exec(`
        CREATE ROLE reader;
        GRANT USAGE ON SCHEMA reactive_state TO reader;
        GRANT SELECT ON reactive_state.changes, reactive_state.head TO reader;
        SET ROLE reader;
      `);

      await setup.follow.prune(setup.pg, Date.now() + 60_000);

      await expect(ownStore(setup.follow).changes(0, 10)).resolves.toMatchObject({
        changes: [],
        floor: 2,
        head: 1,
      });
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the statements of a log already there', () => {
  it(
    'keep a log of a counter row, whose numbers go on past it',
    async () => {
      const setup = await openedWith(schema, DDL);
      await setup.pg.query("INSERT INTO tasks VALUES ('a', 'one')");
      await setup.pg.exec(`
        ALTER TABLE reactive_state.head RENAME COLUMN pruned TO seq;
        UPDATE reactive_state.head SET seq = 5;
        DROP SEQUENCE reactive_state.changes_seq;
      `);

      await expect(ownStore(setup.follow).changes(0, 10)).rejects.toThrow('follow.captureSql()');

      for (const statement of setup.follow.captureSql()) await setup.pg.query(statement);
      await setup.pg.query("INSERT INTO tasks VALUES ('b', 'two')");

      await expect(ownStore(setup.follow).changes(5, 10)).resolves.toMatchObject({
        changes: [{ seq: 6 }],
        head: 6,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'bring the numbers past a log whose entries came without them, as a subscription copies them',
    async () => {
      const setup = await openedWith(schema, DDL);
      await setup.pg.query(
        `INSERT INTO reactive_state.changes ("seq", "schema_name", "table_name") VALUES (40, 'public', 'tasks')`,
      );

      for (const statement of setup.follow.captureSql()) await setup.pg.query(statement);
      await setup.pg.query("INSERT INTO tasks VALUES ('a', 'one')");

      await expect(ownStore(setup.follow).changes(40, 10)).resolves.toMatchObject({
        changes: [{ seq: 41 }],
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'bring the numbers past the first entry, of a sequence that has answered none',
    async () => {
      const setup = await openedWith(schema, DDL);
      await setup.pg.query(
        `INSERT INTO reactive_state.changes ("seq", "schema_name", "table_name") VALUES (1, 'public', 'tasks')`,
      );

      for (const statement of setup.follow.captureSql()) await setup.pg.query(statement);

      await expect(setup.pg.query("INSERT INTO tasks VALUES ('a', 'one')")).resolves.toBeDefined();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'take no number back from a log whose numbers are ahead of its entries',
    async () => {
      const setup = await openedWith(schema, DDL);
      await setup.pg.query("SELECT setval('reactive_state.changes_seq', 9)");

      for (const statement of setup.follow.captureSql()) await setup.pg.query(statement);
      await setup.pg.query("INSERT INTO tasks VALUES ('a', 'one')");

      await expect(ownStore(setup.follow).changes(0, 10)).resolves.toMatchObject({
        changes: [{ seq: 10 }],
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'take no lock of the numbers where they are ahead of the log, which a commit may hold',
    async () => {
      const setup = await openedWith(schema, DDL);
      await setup.pg.query("INSERT INTO tasks VALUES ('a', 'one')");
      const [statement = ''] = setup.follow.captureSql();

      await setup.pg.exec('BEGIN');
      await setup.pg.query(statement);
      const { rows } = await setup.pg.query(
        "SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()",
      );
      await setup.pg.exec('ROLLBACK');

      // The start's own, of the statements two hosts run one after the other.
      expect(rows).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'make again the trigger that numbers entries, taken away or turned off',
    async () => {
      const setup = await openedWith(schema, DDL);
      await setup.pg.exec('ALTER TABLE reactive_state.marks DISABLE TRIGGER ALL');

      for (const statement of setup.follow.captureSql()) await setup.pg.query(statement);
      await setup.pg.query("INSERT INTO tasks VALUES ('a', 'one')");

      await expect(entriesOf(setup)).resolves.toStrictEqual([keyDigest('a')]);

      await setup.pg.exec('DROP TRIGGER settle ON reactive_state.marks');

      for (const statement of setup.follow.captureSql()) await setup.pg.query(statement);
      await setup.pg.query("INSERT INTO tasks VALUES ('b', 'two')");

      await expect(entriesOf(setup)).resolves.toStrictEqual([keyDigest('a'), keyDigest('b')]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'leaves the marks deletable where a publication of all tables publishes deletes',
    async () => {
      const setup = await openedWith(schema, DDL);
      await setup.pg.exec('CREATE PUBLICATION everything FOR ALL TABLES');

      await expect(setup.pg.query("INSERT INTO tasks VALUES ('a', 'one')")).resolves.toBeDefined();
      await expect(entriesOf(setup)).resolves.toStrictEqual([keyDigest('a')]);
    },
    TEST_TIMEOUT_MS,
  );
});
