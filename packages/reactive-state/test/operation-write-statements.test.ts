import { describe, expect, it } from 'vitest';

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
import {
  readsOnly as readsOnlyInD1,
  refusedByD1,
  sentBy,
  sentToD1,
} from '../src/sql/sqlite/sent.ts';

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
