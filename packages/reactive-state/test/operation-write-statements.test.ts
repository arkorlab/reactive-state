import { describe, expect, it } from 'vitest';

import { changeLogSql } from '../src/cloudflare/d1-log.ts';
import {
  type Evaluation,
  evaluate,
  type ExternalWriteEnd,
  sentAsWrite,
} from '../src/server/context.ts';
import {
  readsOnly as readsOnlyInPostgres,
  refusedByPostgres,
  sentToPostgres,
  TransactionWrites,
} from '../src/sql/client-writes.ts';
import { logTrigger } from '../src/sql/sqlite/installed.ts';
import {
  readsOnly as readsOnlyInD1,
  refusedByD1,
  sentBy,
  sentToD1,
} from '../src/sql/sqlite/sent.ts';
import { hidesNoRow, writesUncounted } from '../src/sql/sqlite/unwritten.ts';
import { plainReturning, writtenTable } from '../src/sql/sqlite/where.ts';

/**
 * What a server operation's statements tell the authority, by their texts: which may write — in
 * doubt, any — and how each ended, by what the database answered of it.
 */

/** A statement told to the operation: its text, and how it ended once it did. */
interface Told {
  readonly sql: string;
  ended?: ExternalWriteEnd;
}

/** An operation's evaluation that keeps what its statements told it, and runs code in it. */
function operation() {
  const told: Told[] = [];
  const evaluation = {
    externalWrite: (sql: string) => {
      const entry: Told = { sql };
      told.push(entry);
      return (ended: ExternalWriteEnd) => {
        entry.ended = ended;
      };
    },
  } as unknown as Evaluation;
  return {
    told,
    within: async (body: () => unknown): Promise<unknown> => {
      const answered: unknown = await evaluate(evaluation, async () => {
        const value: unknown = await body();
        return value;
      });
      return answered;
    },
  };
}

/** What `promise` was rejected with, or `undefined`. */
async function settled(promise: unknown): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

/** An error of PostgreSQL's of `code`, as `pg` and PGlite answer one. */
function postgresError(code: string): Error {
  return Object.assign(new Error(`refused: ${code}`), { code });
}

/** An error of D1's of `message`, of a cause of its own where given. */
function d1Error(message: string, cause?: string): Error {
  return cause === undefined ? new Error(message) : new Error(message, { cause: new Error(cause) });
}

const UNIQUE = 'D1_ERROR: UNIQUE constraint failed: tasks.id: SQLITE_CONSTRAINT';

/** A statement's send that answers at once, of no promise. */
function answeredAtOnce(): string {
  return 'at once';
}

/**
 * A D1Result whose meta says it changed `changes` rows, wrote `written`, and `changed` the
 * database.
 */
function result(changes: unknown, written: unknown, changed: unknown = false) {
  return {
    meta: { changed_db: changed, changes, rows_written: written },
    results: [],
    success: true,
  };
}

const UPDATE = 'update "tasks" set "title" = ? where "id" = ?';
const RETURNING = 'update "tasks" set "title" = ? where "id" = ? returning "id"';

/** A row of `sqlite_schema` of the table `tasks`, of the type and the text given. */
function schemaRow(type: string, name: string, sql: string) {
  return { name, sql, tbl_name: 'tasks', type };
}

const PLAIN = schemaRow('table', 'tasks', 'CREATE TABLE tasks (id text PRIMARY KEY, title text)');
const AFTER = schemaRow(
  'trigger',
  'audit',
  'CREATE TRIGGER audit AFTER INSERT ON tasks BEGIN SELECT 1; END',
);
const LOG_TRIGGER = {
  ...schemaRow(
    'trigger',
    'on_log',
    'CREATE TRIGGER on_log AFTER INSERT ON _rs_changes BEGIN SELECT 1; END',
  ),
  tbl_name: '_rs_changes',
};
const PRAGMA_BODY = 'BEGIN SELECT * FROM pragma_optimize(65538); SELECT RAISE(IGNORE); END';
const PRAGMA_TRIGGER = schemaRow(
  'trigger',
  'pr',
  `CREATE TRIGGER pr BEFORE INSERT ON tasks ${PRAGMA_BODY}`,
);
const VIEW = {
  ...schemaRow('view', 'opt', 'CREATE VIEW opt AS SELECT * FROM pragma_optimize(65538)'),
  tbl_name: 'opt',
};
/** A trigger shaped as the log's own, whose statement also joins a `pragma_` function. */
const LOG_SHAPED = {
  name: '_rsd_7461736b73_insert',
  sql: 'CREATE TRIGGER "_rsd_7461736b73_insert" AFTER INSERT ON "tasks" BEGIN INSERT INTO _rs_changes SELECT 1, 2 FROM "tasks" AS c JOIN pragma_optimize(1); END',
  tbl_name: 'tasks',
  type: 'trigger',
};
const PRAGMA_CONTENT = {
  ...schemaRow(
    'table',
    'ft',
    "CREATE VIRTUAL TABLE ft USING fts5(optimize, content='pragma_optimize', content_rowid='arg')",
  ),
  tbl_name: 'ft',
};
const PLAIN_CONTENT = {
  ...PRAGMA_CONTENT,
  sql: "CREATE VIRTUAL TABLE ft USING fts5(title, content='tasks', content_rowid='rowid')",
};
/** A row of the log's table, made as `changeLogSql()` writes it. */
const LOG_ROW = { name: '_rs_changes', tbl_name: '_rs_changes', type: 'table' };
const REAL_LOG = {
  ...LOG_ROW,
  sql: (changeLogSql().find((text) => text.includes('_rs_changes (seq')) ?? '').replace(
    ' IF NOT EXISTS',
    '',
  ),
};
const LOG_INDEX = { ...LOG_ROW, name: 'i', type: 'index' };
/** A row of a log's table of the columns given. */
function logTable(columns: string) {
  return { ...LOG_ROW, sql: `CREATE TABLE _rs_changes (${columns})` };
}
const BEFORE = schemaRow(
  'trigger',
  'audit',
  'CREATE TRIGGER audit BEFORE INSERT ON tasks BEGIN SELECT 1; END',
);

/** A binding of D1's shape whose schema read answers `rows`, or fails where given an error. */
function bindingOf(rows: readonly unknown[] | Error) {
  return {
    prepare: () => {
      return {
        bind: () => {
          return {
            all: async () => {
              await Promise.resolve();
              if (rows instanceof Error) throw rows;
              return { results: rows };
            },
          };
        },
      };
    },
  };
}

/** How the statement `sql` ended, sent by `name` with `args`, answered `answer`, of a schema `rows`. */
async function endedOf(
  sql: string,
  name: string,
  answer: unknown,
  given: { readonly args?: readonly unknown[]; readonly rows?: readonly unknown[] | Error } = {},
): Promise<ExternalWriteEnd | undefined> {
  const { args = [], rows = [PLAIN] } = given;
  const { told, within } = operation();
  const statement = sentBy(bindingOf(rows), 'prepare', [sql], () => ({}));

  await within(() => sentBy(statement, name, args, () => Promise.resolve(answer)));

  return told[0]?.ended;
}

/** How a batch of the statements `texts` ended, answered `answer`, of a schema `rows`. */
async function batchEnded(
  texts: readonly string[],
  answer: unknown,
  rows: readonly unknown[] | Error = [PLAIN],
): Promise<ExternalWriteEnd | undefined> {
  const { told, within } = operation();
  const binding = bindingOf(rows);
  const made = texts.map((text) => sentBy(binding, 'prepare', [text], () => ({})));

  await within(() => sentBy(binding, 'batch', [made], () => Promise.resolve(answer)));

  return told[0]?.ended;
}

describe('what a statement of PostgreSQL may write', () => {
  it.each([
    'select 1',
    'SELECT "id" FROM "tasks" WHERE "tasks"."id" = $1',
    'with x as (select 1) select * from x',
    'values (1), (2)',
    'table tasks',
    'show search_path',
    'select 1; select 2;',
    'select "for", "into" from "update"',
    "select 'delete from tasks'",
    '(select "id" from "tasks") union (select "id" from "tasks")',
    'select substring("title" from 1 for 3) from "tasks"',
  ])('reads alone: %s', (sql) => {
    expect(readsOnlyInPostgres(sql)).toBe(true);
  });

  it.each([
    'insert into tasks values ($1)',
    'update tasks set title = $1',
    'delete from tasks',
    'merge into tasks using x on true when matched then delete',
    'select * into copied from tasks',
    'select * from tasks for update',
    'select * from tasks for share',
    'select * from tasks for key share',
    '(select * from tasks for no key update)',
    'with gone as (delete from tasks returning *) select * from gone',
    'select 1; delete from tasks',
    'select 1; truncate tasks',
    'begin',
    'set search_path = x',
    'call refresh()',
    'explain select 1',
    // A string of `\` escapes in one reading, which ends before `delete` in the other.
    String.raw`select 'a\'' , 1; delete from tasks; -- '`,
    "select 'unterminated",
  ])('may write: %s', (sql) => {
    expect(readsOnlyInPostgres(sql)).toBe(false);
  });

  it.each([
    ['23505', true],
    ['22P02', true],
    ['40001', true],
    ['40P01', true],
    ['42P01', true],
    ['25006', true],
    ['P0001', true],
    ['0A000', true],
    ['40003', false],
    ['08006', false],
    ['57P01', false],
    ['XX000', false],
    ['53100', false],
    ['EPIPE', false],
    ['ECONNRESET', false],
  ])('reads an error of code %s as a refusal of the statement: %s', (code, refused) => {
    expect(refusedByPostgres(postgresError(code))).toBe(refused);
  });

  it('reads an error of no code as none', () => {
    expect(refusedByPostgres(new Error('Connection terminated'))).toBe(false);
  });
});

describe('what a statement of D1 may write', () => {
  it.each([
    'select "id" from "tasks" where "tasks"."id" = ?',
    'SELECT 1;',
    'values (1)',
    'with x as (select 1) select * from x',
  ])('reads alone: %s', (sql) => {
    expect(readsOnlyInD1(sql)).toBe(true);
  });

  it.each([
    'insert into "tasks" ("id") values (?)',
    'update "tasks" set "title" = ?',
    'delete from "tasks"',
    'replace into "tasks" values (?)',
    'with x as (select 1) delete from "tasks"',
    "select * from pragma_table_info('tasks')",
    'pragma table_info(tasks)',
    'select 1; delete from "tasks"',
    'end',
    '/* a comment */ select 1',
  ])('may write: %s', (sql) => {
    expect(readsOnlyInD1(sql)).toBe(false);
  });

  it.each([
    [UNIQUE, undefined, true],
    ['D1_ERROR: no such table: tasks: SQLITE_ERROR', undefined, true],
    ['D1_ERROR: CHECK constraint failed: x: SQLITE_CONSTRAINT', undefined, true],
    ["D1_TYPE_ERROR: Type 'object' not supported for value '[object Object]'", undefined, true],
    ['D1_ERROR: Error', UNIQUE, true],
    ['D1_ERROR: Network connection lost.', undefined, false],
    ['D1_ERROR: internal error; reference = 0123', undefined, false],
    ['D1_ERROR: database is locked: SQLITE_BUSY', undefined, false],
    ['D1_ERROR: disk I/O error: SQLITE_IOERR', undefined, false],
  ])('reads %s (of a cause %s) as a refusal of the statement: %s', (message, cause, refused) => {
    expect(refusedByD1(d1Error(message, cause))).toBe(refused);
  });
});

describe('what an operation is told of its statements', () => {
  it('is told nothing of a statement outside an operation, which runs as it is', async () => {
    await expect(
      sentAsWrite(
        'insert',
        () => Promise.resolve('answered'),
        () => true,
      ),
    ).resolves.toBe('answered');
  });

  it('is told of a write before it goes, and that it landed once answered', async () => {
    const { told, within } = operation();
    const order: unknown[] = [];

    await within(() => {
      return sentToD1(['insert into "tasks" values (?)'], () => {
        order.push(told.map((each) => ({ ...each })));
        return Promise.resolve('answered');
      });
    });

    expect(order).toStrictEqual([[{ sql: 'insert into "tasks" values (?)' }]]);
    expect(told).toStrictEqual([{ ended: 'landed', sql: 'insert into "tasks" values (?)' }]);
  });

  it('is told nothing of a read', async () => {
    const { told, within } = operation();

    await within(() => sentToD1(['select 1'], () => Promise.resolve('answered')));
    await within(() => sentToPostgres('query', ['select 1'], () => Promise.resolve('answered')));

    expect(told).toStrictEqual([]);
  });

  it.each([
    [['insert into "tasks" values (?)'], UNIQUE, 'none'],
    [['insert into "tasks" values (?)', 'update "tasks" set "title" = ?'], UNIQUE, 'none'],
    [['insert or fail into "tasks" values (?)'], UNIQUE, 'unknown'],
    [['insert or/**/fail into "tasks" values (?), (?)'], UNIQUE, 'unknown'],
    [['insert or -- the conflict\n fail into "tasks" values (?)'], UNIQUE, 'unknown'],
    [[undefined], UNIQUE, 'unknown'],
    [['insert into "tasks" values (?)'], 'D1_ERROR: Network connection lost.', 'unknown'],
  ])('is told that D1 statements %j ended %s of an error: %s', async (texts, message, ended) => {
    const { told, within } = operation();

    await settled(within(() => sentToD1(texts, () => Promise.reject(d1Error(message)))));

    expect(told.map((each) => each.ended)).toStrictEqual([ended]);
  });

  it.each([
    ['insert into tasks values (1)', 'none'],
    ['insert into tasks values (1); insert into tasks values (2)', 'unknown'],
    ['insert into tasks values (1)\ninsert into tasks values (2)', 'unknown'],
  ])('is told that `exec` of %s ended %s of a refusal', async (sql, ended) => {
    const { told, within } = operation();

    await settled(within(() => sentBy({}, 'exec', [sql], () => Promise.reject(d1Error(UNIQUE)))));

    expect(told.map((each) => each.ended)).toStrictEqual([ended]);
  });

  it('is told of a write on a line of its own of an `exec`, which D1 runs line by line', async () => {
    const { told, within } = operation();

    await within(() =>
      sentBy({}, 'exec', ['SELECT 1\nDELETE FROM tasks'], () => Promise.resolve({})),
    );

    expect(told.map((each) => each.sql)).toStrictEqual(['SELECT 1; DELETE FROM tasks']);
  });

  it('is told the text of a session’s statement, and of nothing it did not send', async () => {
    const { told, within } = operation();
    const made = {};
    const bound = {};

    await within(() => {
      sentBy({}, 'prepare', ['insert into "tasks" values (?)'], () => made);
      sentBy(made, 'bind', [1], () => bound);
      sentBy({}, 'getBookmark', [], () => 'bookmark');
      return sentBy(bound, 'run', [], () => Promise.resolve('answered'));
    });

    expect(told).toStrictEqual([{ ended: 'landed', sql: 'insert into "tasks" values (?)' }]);
  });

  describe('of what D1 answered of a statement', () => {
    it.each([
      ['run', result(0, 0), 'none'],
      ['run', result(0, 0, true), 'landed'],
      ['run', result(0, 0, 'false'), 'landed'],
      ['all', result(0, 0), 'none'],
      ['run', result(1, 1), 'landed'],
      ['run', result(0, 1), 'landed'],
      ['run', result(1, 0), 'landed'],
      ['run', result(0, undefined), 'landed'],
      ['run', result('0', '0'), 'landed'],
      ['run', { results: [] }, 'landed'],
      ['run', undefined, 'landed'],
    ])('ends `%s` of %j %s', async (name, answer, ended) => {
      await expect(endedOf(UPDATE, name, answer)).resolves.toBe(ended);
    });

    it.each([
      [[result(0, 0), result(0, 0)], 'none'],
      [[result(0, 0), result(1, 1)], 'landed'],
      [[], 'landed'],
      [[result(0, 0)], 'landed'],
    ])('ends a batch answered %j %s', async (answer, ended) => {
      await expect(batchEnded([UPDATE, UPDATE], answer)).resolves.toBe(ended);
    });

    it.each([
      [RETURNING, 'raw', { answer: [], args: [] }, 'none'],
      [RETURNING, 'raw', { answer: [[1]], args: [] }, 'landed'],
      [RETURNING, 'raw', { answer: [['id']], args: [{ columnNames: true }] }, 'landed'],
      [RETURNING, 'first', { answer: null, args: [] }, 'none'],
      [RETURNING, 'first', { answer: { id: 1 }, args: [] }, 'landed'],
      [RETURNING, 'first', { answer: null, args: ['id'] }, 'landed'],
      [UPDATE, 'raw', { answer: [], args: [] }, 'landed'],
      [UPDATE, 'first', { answer: null, args: [] }, 'landed'],
      [
        'update "tasks" set "title" = \'returning\' where "id" = ?',
        'raw',
        { answer: [], args: [] },
        'landed',
      ],
      [
        'update "tasks" set "title" = ? where "id" in (select 1 returning)',
        'raw',
        { answer: [], args: [] },
        'landed',
      ],
      [
        'insert into "tasks" values (?) on conflict do nothing returning "id"',
        'raw',
        { answer: [], args: [] },
        'landed',
      ],
      [
        'insert or ignore into "tasks" values (?) returning "id"',
        'first',
        { answer: null, args: [] },
        'landed',
      ],
      ['insert into "tasks" values (?) returning "id"', 'raw', { answer: [], args: [] }, 'none'],
      [`${UPDATE} /* returning */`, 'raw', { answer: [], args: [] }, 'landed'],
      [
        'update "tasks" set "title" = ? where "id" = ? RETURNING *',
        'raw',
        { answer: [], args: [] },
        'none',
      ],
    ])('ends %s by `%s` answered %j %s', async (sql, name, { answer, args }, ended) => {
      await expect(endedOf(sql, name, answer, { args })).resolves.toBe(ended);
    });

    it.each([
      'create table x (id)',
      'drop table tasks',
      'alter table tasks add c',
      'pragma foreign_keys',
    ])('ends %s landed of zero changes, which count no row', async (sql) => {
      await expect(endedOf(sql, 'run', result(0, 0))).resolves.toBe('landed');
    });

    it('ends a batch landed where one of its statements counts no row', async () => {
      await expect(
        batchEnded([UPDATE, 'create table x (id)'], [result(0, 0), result(0, 0)]),
      ).resolves.toBe('landed');
    });

    it('ends landed, and once, where the check of the answer throws', async () => {
      const { told, within } = operation();
      const answer = result(0, 0);

      await expect(
        within(() => {
          return sentToD1(
            [UPDATE],
            () => Promise.resolve(answer),
            true,
            () => {
              throw new Error('unreadable');
            },
          );
        }),
      ).resolves.toBe(answer);

      expect(told.map((each) => each.ended)).toStrictEqual(['landed']);
    });

    it('ends a `WITH … UPDATE` of zero changes none', async () => {
      await expect(
        endedOf('with x as (select 1) update "tasks" set "title" = ?', 'run', result(0, 0)),
      ).resolves.toBe('none');
    });

    it.each([
      'WITH replace AS (SELECT 1) SELECT * FROM pragma_optimize(65538)',
      "WITH x AS (SELECT 1) SELECT replace(a, 'b', 'c') FROM x",
      'update tasks set a = (select count(*) from pragma_optimize())',
      'with x as (select 1 update tasks set a = 1',
      'with x as select 1 update tasks set a = 1',
    ])('ends %s landed of zero changes, which count no row', async (sql) => {
      await expect(endedOf(sql, 'run', result(0, 0))).resolves.toBe('landed');
    });

    it.each([
      'WITH "replace" AS (SELECT 1) UPDATE tasks SET a = 1',
      'WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM x WHERE n < 3), y AS MATERIALIZED (SELECT 1) DELETE FROM tasks WHERE id IN (SELECT n FROM x)',
      'WITH x AS NOT MATERIALIZED (SELECT 1) INSERT INTO tasks SELECT * FROM x',
    ])('ends %s of zero changes none', async (sql) => {
      await expect(endedOf(sql, 'run', result(0, 0))).resolves.toBe('none');
    });

    it.each([
      ['without a trigger or view', [PLAIN], 'none'],
      ['with a plain trigger', [PLAIN, BEFORE], 'none'],
      ['with a trigger that names a pragma function', [PLAIN, PRAGMA_TRIGGER], 'landed'],
      ['with a failed read', new Error('no'), 'landed'],
    ])('ends a zero-count `run` %s %s', async (_what, rows, ended) => {
      await expect(endedOf(UPDATE, 'run', result(0, 0), { rows })).resolves.toBe(ended);
    });

    it.each([
      ['without a trigger or view', [PLAIN], 'none'],
      ['with a view that names a pragma function', [PLAIN, VIEW], 'landed'],
      ['with a failed read', new Error('no'), 'landed'],
    ])('ends a zero-count batch %s %s', async (_what, rows, ended) => {
      await expect(batchEnded([UPDATE], [result(0, 0)], rows)).resolves.toBe(ended);
    });

    it('ends a nonzero `run` landed without a read of the schemas', async () => {
      await expect(
        endedOf(UPDATE, 'run', result(1, 1), { rows: new Error('not read') }),
      ).resolves.toBe('landed');
    });

    it.each([
      ['returning *', true],
      ['returning "id", "title" as t', true],
      ['returning id x, tasks.*', true],
      ['returning "tasks"."id" AS "i";', true],
      ['returning raise(ignore)', false],
      ['returning "id", raise(ignore) as gone', false],
      ['returning (select 1)', false],
      ['returning "id" + 1', false],
      ['returning 1', false],
      ["returning 'x'", false],
      ['returning ?', false],
      ['returning id order by id', false],
      ['returning id limit 1', false],
      ['returning a.b.c', false],
      ['returning id,', false],
      ['returning', false],
    ])('reads the list of an update %s as plain: %s', (tail, plain) => {
      expect(plainReturning(`update tasks set a = 1 ${tail}`)).toBe(plain);
    });

    it('reads a statement with no RETURNING as no plain list', () => {
      expect(plainReturning('update tasks set a = 1')).toBe(false);
    });

    it.each([
      ['update tasks set a = 1 returning raise(ignore)', 'landed'],
      ['update tasks set a = 1 returning "id", raise(ignore) as gone', 'landed'],
      ['update tasks set a = 1 returning "id"', 'none'],
      ['update tasks set a = 1 returning *', 'none'],
    ])('ends %s by `raw` of no row %s', async (sql, ended) => {
      await expect(endedOf(sql, 'raw', [])).resolves.toBe(ended);
    });

    it('ends an `exec` landed, whatever it answers', async () => {
      const { told, within } = operation();

      await within(() =>
        sentBy({}, 'exec', ['update tasks set title = 1'], () => Promise.resolve(result(0, 0))),
      );

      expect(told[0]?.ended).toBe('landed');
    });
  });

  describe('of the table an empty RETURNING is read against', () => {
    it.each([
      ['insert into tasks values (1)', 'tasks'],
      ['INSERT OR IGNORE INTO "tasks" (id) values (1)', 'tasks'],
      ['insert into tasks as x values (1)', 'tasks'],
      ['replace into tasks values (1)', 'tasks'],
      ['update or fail tasks set a = 1', 'tasks'],
      ['update "tasks" set a = 1', 'tasks'],
      ['delete from tasks where id = 1', 'tasks'],
      ['with x(a) as (select (1)) update tasks set a = 1', 'tasks'],
      ['with recursive x(a) as (select 1) delete from "tasks"', 'tasks'],
      ['with "replace" as (select 1) update tasks set a = 1', 'tasks'],
      [
        'with recursive x(n) as (select 1), y as materialized (select 1) delete from tasks',
        'tasks',
      ],
      ['with x as not materialized (select 1) insert into tasks select * from x', 'tasks'],
      ['with replace as (select 1) select * from tasks', undefined],
      ['with x as (select 1 update tasks set a = 1', undefined],
      ['update main.tasks set a = 1', 'tasks'],
      ['update "main"."tasks" set a = 1', 'tasks'],
      ['delete from "a""b"', 'a"b'],
      ['update temp.tasks set a = 1', undefined],
      ['update "other"."tasks" set a = 1', undefined],
      ['select 1', undefined],
      ['insert tasks values (1)', undefined],
    ])('reads %s as a write of %s', (sql, table) => {
      expect(writtenTable(sql)).toBe(table);
    });
  });

  describe('of what a table’s schema proves of an empty RETURNING', () => {
    it('reads a trigger that joins a pragma function as not the log’s own', () => {
      expect(logTrigger(LOG_SHAPED)).toBe(false);
    });

    it.each([
      ['a trigger that names a pragma function', [PRAGMA_TRIGGER], true],
      ['it in upper case', [{ ...PRAGMA_TRIGGER, sql: PRAGMA_TRIGGER.sql.toUpperCase() }], true],
      [
        'it quoted',
        [
          {
            ...PRAGMA_TRIGGER,
            sql: 'CREATE TRIGGER t AFTER INSERT ON tasks BEGIN SELECT * FROM "pragma_optimize"(1); END',
          },
        ],
        true,
      ],
      [
        'it in a string',
        [
          {
            ...PRAGMA_TRIGGER,
            sql: "CREATE TRIGGER t AFTER INSERT ON tasks BEGIN SELECT 'pragma_x'; END",
          },
        ],
        true,
      ],
      ['a temp trigger that names it', [{ ...PRAGMA_TRIGGER, home: 'temp' }], true],
      ['a view that names it', [VIEW], true],
      ['a virtual table whose content names it', [PRAGMA_CONTENT], true],
      ['a virtual table of plain content', [PLAIN_CONTENT], false],
      [
        'a virtual table in other spacing',
        [
          {
            ...PRAGMA_CONTENT,
            sql: PRAGMA_CONTENT.sql.replace('CREATE VIRTUAL', 'create\n  virtual'),
          },
        ],
        true,
      ],
      [
        'a table with a generated column, a pragma name and a dash string',
        [
          {
            ...PLAIN,
            sql: "CREATE TABLE notes (a INTEGER, pragma_note TEXT DEFAULT '--', b INTEGER AS (a + 1) VIRTUAL)",
          },
        ],
        false,
      ],
      [
        'a table with a generated column and a pragma name',
        [
          {
            ...PLAIN,
            sql: 'CREATE TABLE notes (a INTEGER, pragma_note TEXT, b INTEGER AS (a + 1) VIRTUAL)',
          },
        ],
        false,
      ],
      ['a trigger of the log’s shape that joins one', [LOG_SHAPED], true],
      ['a trigger of no text', [{ ...BEFORE, sql: null }], true],
      ['a row not read', ['x'], true],
      ['a plain trigger', [BEFORE, AFTER], false],
      ['a plain view', [{ ...VIEW, sql: 'CREATE VIEW opt AS SELECT 1' }], false],
      ['a table that names it', [{ ...PLAIN, sql: 'CREATE TABLE tasks (pragma_a)' }], false],
    ])('reads %s as a writer of uncounted rows, or not', (_what, rows, writes) => {
      expect(writesUncounted(rows)).toBe(writes);
    });

    it.each([
      ['a plain table', [PLAIN], true],
      ['a trigger that runs after', [PLAIN, AFTER], true],
      [
        'a conflict clause',
        [
          schemaRow(
            'table',
            'tasks',
            'CREATE TABLE tasks (id text PRIMARY KEY ON CONFLICT IGNORE)',
          ),
        ],
        false,
      ],
      [
        'a conflict clause in any case',
        [schemaRow('table', 'tasks', 'create table tasks (id text not null on Conflict ignore)')],
        false,
      ],
      [
        'a virtual table',
        [schemaRow('table', 'tasks', 'CREATE VIRTUAL TABLE tasks USING fts5(a)')],
        false,
      ],
      ['a trigger that runs before', [PLAIN, BEFORE], false],
      [
        'a trigger of no time',
        [
          PLAIN,
          schemaRow('trigger', 'audit', 'CREATE TRIGGER audit INSERT ON tasks BEGIN SELECT 1; END'),
        ],
        false,
      ],
      ['no row of the table', [AFTER], false],
      ['two rows of the table', [PLAIN, PLAIN], false],
      ['a raise in the log’s table', [PLAIN, logTable('x CHECK (x = 1 OR raise(ignore))')], false],
      [
        'a raise in an index on the log',
        [
          PLAIN,
          REAL_LOG,
          { ...LOG_INDEX, sql: 'CREATE INDEX i ON _rs_changes (at) WHERE RAISE(1)' },
        ],
        false,
      ],
      [
        'a raise in the written table’s check',
        [{ ...PLAIN, sql: 'CREATE TABLE tasks (id CHECK (raise(ignore)))' }],
        false,
      ],
      [
        'a conflict clause in the log’s table',
        [PLAIN, logTable('seq INTEGER PRIMARY KEY ON CONFLICT REPLACE')],
        false,
      ],
      ['the log’s real table', [PLAIN, REAL_LOG], true],
      ['a temp table of the name', [PLAIN, { ...PLAIN, home: 'temp' }], false],
      ['a temp trigger', [PLAIN, { ...AFTER, home: 'temp' }], false],
      ['a trigger on the log', [PLAIN, LOG_TRIGGER], false],
      ['a main row of the schema read', [{ ...PLAIN, home: 'main' }], true],
      ['a trigger that names a pragma function', [PLAIN, PRAGMA_TRIGGER], false],
      ['a view that names it', [PLAIN, VIEW], false],
      ['a virtual table that names it', [PLAIN, PRAGMA_CONTENT], false],
      ['a virtual table of plain content', [PLAIN, PLAIN_CONTENT], true],
    ])('answers of %s', (_what, rows, proven) => {
      expect(hidesNoRow(rows, 'TASKS')).toBe(proven);
    });

    it.each([
      ['a plain table', [PLAIN], 'none'],
      ['a trigger that runs after', [PLAIN, AFTER], 'none'],
      ['a trigger that runs before', [PLAIN, BEFORE], 'landed'],
      ['a failed read', new Error('no'), 'landed'],
      ['an unexpected answer', ['x'], 'landed'],
    ])('ends an empty RETURNING by `raw` of %s as its schema says', async (_what, rows, ended) => {
      await expect(endedOf(RETURNING, 'raw', [], { rows })).resolves.toBe(ended);
    });

    it('ends landed where the binding that made the statement cannot be read', async () => {
      const { told, within } = operation();
      const statement = sentBy({}, 'prepare', [RETURNING], () => ({}));

      await within(() => sentBy(statement, 'raw', [], () => Promise.resolve([])));

      expect(told[0]?.ended).toBe('landed');
    });
  });

  it('is told of a statement answered at once that its outcome is unknown', async () => {
    const { told, within } = operation();

    await within(() => sentAsWrite('insert', answeredAtOnce, () => true));

    expect(told).toStrictEqual([{ ended: 'unknown', sql: 'insert' }]);
  });

  it.each([
    ['insert into tasks values ($1)', '23505', 'none'],
    ['insert into tasks values ($1)', '08006', 'unknown'],
    ['insert into tasks values (1); insert into tasks values (2)', '23505', 'unknown'],
    ['call add_then_fail()', 'P0001', 'unknown'],
    ["do $$ begin insert into tasks values ('t2'); commit; end $$", '23505', 'unknown'],
  ])('is told that `query` of %s ended %s of an error of code %s', async (sql, code, ended) => {
    const { told, within } = operation();

    await settled(
      within(() => sentToPostgres('query', [sql], () => Promise.reject(postgresError(code)))),
    );

    expect(told.map((each) => each.ended)).toStrictEqual([ended]);
  });

  it.each([
    ['query', ['savepoint s1']],
    ['query', ['set transaction read only']],
    ['query', ['ROLLBACK;']],
    ['query', ['abort']],
    ['exec', ['rollback']],
    ['listen', ['channel']],
    ['close', []],
  ])('is told nothing of `%s` of %j', async (name, args) => {
    const { told, within } = operation();

    await within(() => sentToPostgres(name, args, () => Promise.resolve('answered')));

    expect(told).toStrictEqual([]);
  });

  it('is told of a rollback that is not alone in its text', async () => {
    const { told, within } = operation();

    await within(() => {
      return sentToPostgres('query', ['rollback; insert into tasks values (1)'], () =>
        Promise.resolve('answered'),
      );
    });

    expect(told).toStrictEqual([
      { ended: 'landed', sql: 'rollback; insert into tasks values (1)' },
    ]);
  });

  it('is told of what runs no text of its own, as a write', async () => {
    const { told, within } = operation();

    await within(() =>
      sentToPostgres('sql', [['insert ', ''], 1], () => Promise.resolve('answered')),
    );
    await within(() =>
      sentToPostgres('execProtocol', [new Uint8Array()], () => Promise.resolve('answered')),
    );

    expect(told).toStrictEqual([
      { ended: 'landed', sql: '(sql)' },
      { ended: 'landed', sql: '(execProtocol)' },
    ]);
  });

  it('is told of a transaction’s writes as they go, and of their end as it ends', async () => {
    const { told, within } = operation();
    let before: unknown;

    await within(() => {
      const writes = new TransactionWrites();
      sentToPostgres('query', ['select 1'], () => 'read', writes);
      sentToPostgres('query', ['insert into tasks values ($1)'], () => 'written', writes);
      before = told.map((each) => ({ ...each }));
      writes.committing();
      return writes.through(Promise.resolve('committed'), () => false);
    });

    expect(before).toStrictEqual([{ sql: 'insert into tasks values ($1)' }]);
    expect(told).toStrictEqual([
      { ended: 'landed', sql: 'insert into tasks values ($1)' },
      { ended: 'landed', sql: 'COMMIT' },
    ]);
  });

  it.each([
    ['its code’s throw rolled it back', true, new Error('no room'), 'none'],
    ['PostgreSQL refused its commit', false, postgresError('23505'), 'none'],
    ['its commit had no answer', false, postgresError('08006'), 'unknown'],
  ])('is told a transaction’s writes ended as %s', async (_what, rolledBack, error, ended) => {
    const { told, within } = operation();

    await settled(
      within(() => {
        const writes = new TransactionWrites();
        writes.sent('insert into tasks values ($1)');
        return writes.through(Promise.reject(error), () => rolledBack);
      }),
    );

    expect(told.map((each) => each.ended)).toStrictEqual([ended]);
  });

  it('is told nothing of the commit of a transaction that wrote nothing', async () => {
    const { told, within } = operation();

    await within(() => {
      const writes = new TransactionWrites();
      writes.sent('select 1');
      writes.committing();
      return writes.through(Promise.resolve('committed'), () => false);
    });

    expect(told).toStrictEqual([]);
  });

  describe('of an attempt that sends no more', () => {
    /** An operation's evaluation that refuses every statement told to it. */
    const refusing = {
      externalWrite: () => {
        throw new Error('The operation sends no more statements.');
      },
    } as unknown as Evaluation;
    /**
     * What `body` answers in that evaluation, or throws there: `evaluate` is async, and a throw
     * of `body` would be its promise's rejection, so the outcome is kept as it happens.
     */
    const inRefusing = async (
      body: () => unknown,
    ): Promise<{ answered?: unknown; thrown?: unknown; threw: boolean }> => {
      const kept: { answered?: unknown; thrown?: unknown; threw: boolean } = { threw: false };
      await evaluate(refusing, () => {
        try {
          kept.answered = body();
        } catch (error) {
          kept.thrown = error;
          kept.threw = true;
        }
        return Promise.resolve();
      });
      return kept;
    };

    it.each([
      ['D1', () => sentToD1(['insert into "tasks" values (?)'], () => Promise.resolve('sent'))],
      ['D1 `exec`', () => sentBy({}, 'exec', ['insert into tasks values (1)'], () => 'sent')],
      ['PGlite', () => sentToPostgres('query', ['insert into tasks values (1)'], () => 'sent')],
      [
        'a transaction',
        () => {
          return sentToPostgres(
            'query',
            ['insert into tasks values (1)'],
            () => 'sent',
            new TransactionWrites(),
          );
        },
      ],
    ])('answers the refusal of a statement of %s as a rejection', async (_what, sent) => {
      const { answered: answer } = await inRefusing(sent);

      expect(answer).toBeInstanceOf(Promise);
      await expect(answer).rejects.toThrow('sends no more statements');
    });

    it('answers the refusal of a statement through the callback a `pg` query was handed', async () => {
      const called = Promise.withResolvers<unknown>();
      const { answered: answer } = await inRefusing(() => {
        return sentToPostgres(
          'query',
          [
            'insert into tasks values ($1)',
            [1],
            (error: unknown) => {
              called.resolve(error);
            },
          ],
          () => 'sent',
        );
      });

      expect(answer).toBeUndefined();
      await expect(called.promise).resolves.toMatchObject({
        message: expect.stringContaining('sends no more statements'),
      });
    });

    it('throws the refusal of a statement of the protocol’s call that answers at once', async () => {
      const { threw, thrown } = await inRefusing(() =>
        sentToPostgres('execProtocolRawSync', [new Uint8Array()], () => 'sent'),
      );

      expect(threw).toBe(true);
      expect(String(thrown)).toContain('sends no more statements');
    });
  });
});
