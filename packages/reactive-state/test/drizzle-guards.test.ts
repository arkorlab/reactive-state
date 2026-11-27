import { protocol } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { pgSchema, pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import type { ComponentProgram } from '../src/program.ts';
import { generationOf } from '../src/sql/generations.ts';
import { followDrizzle } from '../src/sql/index.ts';
import { engineOf, openedWith } from './support/drizzle.ts';

const tasks = pgTable('tasks', { id: text().primaryKey(), title: text() });
const otherTasks = pgSchema('other').table('tasks', { id: text().primaryKey(), title: text() });
const schema = { otherTasks, tasks };
const DDL = `
  CREATE TABLE tasks (id text PRIMARY KEY, title text);
  INSERT INTO tasks VALUES ('t1', 'First');
  CREATE SCHEMA other;
  CREATE TABLE other.tasks (id text PRIMARY KEY, title text);
  INSERT INTO other.tasks VALUES ('t1', 'Other');
`;

/** A serializer a test puts in a namespace's registry. */
const replacement = (): string => 'replacement';

/** An extension namespace whose methods answer their receiver, as it is and as a promise. */
class SelfReturning {
  readonly query: () => Promise<unknown>;
  readonly rows: () => unknown;

  constructor(query: () => Promise<unknown>, rows: () => unknown) {
    this.query = query;
    this.rows = rows;
  }

  async asyncSelf(): Promise<this> {
    await Promise.resolve();
    return this;
  }

  self(): this {
    return this;
  }
}

/** An object that does its work as it is awaited. */
// eslint-disable-next-line unicorn/no-thenable -- what awaits one is what these tests are of.
const thenable = (work: () => Promise<unknown>) => ({ then: work });

/** A rejected promise whose owner handled that, as an application may on its own connection. */
function handledRejection(reason: string): Promise<never> {
  const failed = Promise.reject(new Error(reason));
  void failed.catch(() => {
    // Handled here, where the owner holds it.
  });
  return failed;
}

/** A promise of a class of its own, as a library may keep on a connection. */
class Task<T> extends Promise<T> {}

describe('the boundaries of a followed PGlite client', { timeout: 20_000 }, () => {
  it('refuses a captured method of a nested extension namespace, though its caller catches it', async () => {
    const setup = await openedWith(schema, DDL);
    const run = vi.fn(async () => setup.pg.query('SELECT title FROM tasks'));
    const original = Object.assign(setup.pg, {
      extension: Object.freeze({ nested: Object.freeze({ query: run }) }),
    });
    const client = setup.follow.client(original);
    const namespace = client.extension.nested;
    const captured = namespace.query;
    const { render } = await engineOf(setup, async (_props, $) => {
      try {
        await captured();
      } catch {
        // The evaluation still carries the refused read.
      }
      return $.h('p', null, 'caught');
    });

    await expect(render()).rejects.toThrow('extension.nested.query');
    expect(run).not.toHaveBeenCalled();

    await captured();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('retains namespace guards through valueOf and methods returning their receiver', async () => {
    const setup = await openedWith(schema, DDL);
    const rows = [{ title: 'outside' }];
    const extension = new SelfReturning(
      vi.fn(async () => setup.pg.query('SELECT title FROM tasks')),
      () => rows,
    );
    const client = setup.follow.client(Object.assign(setup.pg, { extension }));

    expect(client.extension.rows()).toBe(rows);

    const escaped = [
      client.extension.valueOf(),
      client.extension.self(),
      await client.extension.asyncSelf(),
    ] as SelfReturning[];
    const { render } = await engineOf(setup, async (_props, $) => {
      for (const namespace of escaped) {
        try {
          await namespace.query();
        } catch {
          // Each refused call remains the evaluation's fault.
        }
      }
      return $.h('p', null, 'caught');
    });

    await expect(render()).rejects.toThrow('extension.query');
    expect(extension.query).not.toHaveBeenCalled();
  });

  it("settles a render's await of a connection's promise", async () => {
    const setup = await openedWith(schema, DDL);
    const client = setup.follow.client(setup.pg);
    const { render } = await engineOf(setup, async (_props, $) => {
      await client.waitReady;
      return $.h('p', null, 'ready');
    });

    await expect(render()).resolves.toBe('ready');
  });

  it("answers a render the rejection of the connection's `waitReady`", async () => {
    const setup = await openedWith(schema, DDL);
    const client = setup.follow.client(setup.pg);
    Object.assign(setup.pg, { waitReady: handledRejection('never opened') });
    const { render } = await engineOf(setup, async (_props, $) => {
      try {
        await client.waitReady;
      } catch (error) {
        return $.h('p', null, String(error));
      }
      return $.h('p', null, 'settled');
    });

    await expect(render()).resolves.toBe('Error: never opened');
  });

  it.each([
    ['a thenable', thenable],
    ['a promise of a namespace', () => Promise.resolve()],
    [
      'a promise of its own `then`',
      (work: () => Promise<unknown>) => Object.assign(Promise.resolve(), thenable(work)),
    ],
  ])('refuses a render awaiting %s, by the rejection it was handed', async (_name, make) => {
    const setup = await openedWith(schema, DDL);
    const run = vi.fn(async () => setup.pg.query('SELECT title FROM tasks'));
    const client = setup.follow.client(
      Object.assign(setup.pg, { extension: { lazy: make(run) as unknown as Promise<unknown> } }),
    );
    const caught = vi.fn();
    const { render } = await engineOf(setup, async (_props, $) => {
      try {
        await client.extension.lazy;
      } catch (error) {
        caught(error);
      }
      return $.h('p', null, 'caught');
    });

    await expect(render()).rejects.toThrow('extension.lazy.then');
    expect(caught).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a promise an accessor made as the render read it', async () => {
    const setup = await openedWith(schema, DDL);
    const read = vi.fn(async () => setup.pg.query('SELECT title FROM tasks'));
    const extension = {
      get held() {
        return { rows: read() };
      },
      get latest() {
        return read();
      },
    };
    const client = setup.follow.client(Object.assign(setup.pg, { extension }));
    const caught = vi.fn();
    const { render } = await engineOf(setup, async (_props, $) => {
      for (const answer of [client.extension.latest, client.extension.held.rows]) {
        try {
          await answer;
        } catch (error) {
          caught(error);
        }
      }
      return $.h('p', null, 'caught');
    });

    await expect(render()).rejects.toThrow('extension.latest.then');
    expect(caught).toHaveBeenCalledTimes(2);
  });

  it("refuses a promise of the connection's own accessor", async () => {
    const setup = await openedWith(schema, DDL);
    const read = vi.fn(async () => setup.pg.query('SELECT title FROM tasks'));
    Object.defineProperty(setup.pg, 'latest', { configurable: true, get: read });
    const client = setup.follow.client(setup.pg) as typeof setup.pg & {
      readonly latest: Promise<unknown>;
    };
    const caught = vi.fn();
    const { render } = await engineOf(setup, async (_props, $) => {
      try {
        await client.latest;
      } catch (error) {
        caught(error);
      }
      return $.h('p', null, 'caught');
    });

    await expect(render()).rejects.toThrow('latest.then');
    expect(caught).toHaveBeenCalledTimes(1);
  });

  it("keeps a promise's class and members outside a render", async () => {
    const setup = await openedWith(schema, DDL);
    const cancel = vi.fn();
    const extension = {
      own: Object.assign(Promise.resolve(1), { cancel }),
      plain: Promise.resolve(3),
      task: Task.resolve(2),
    };
    const client = setup.follow.client(Object.assign(setup.pg, { extension }));

    expect(client.extension.task).toBeInstanceOf(Task);

    client.extension.own.cancel();

    expect(cancel).toHaveBeenCalledTimes(1);
    await expect(client.extension.own).resolves.toBe(1);
    await expect(client.extension.task).resolves.toBe(2);
    await expect(client.extension.plain).resolves.toBe(3);
  });

  it('faults a render for a refused call it never awaits, with no unhandled rejection', async () => {
    const setup = await openedWith(schema, DDL);
    const run = vi.fn(async () => setup.pg.query('SELECT title FROM tasks'));
    const client = setup.follow.client(
      Object.assign(setup.pg, { extension: { held: Promise.resolve(), query: run } }),
    );
    const { render } = await engineOf(setup, async (_props, $) => {
      const left = [
        client.extension.query(),
        client.exec('SELECT 1'),
        // eslint-disable-next-line unicorn/prefer-await -- a `then` nothing awaits is the case.
        client.extension.held.then(() => 'answered'),
      ];
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      return $.h('p', null, String(left.length));
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    await expect(render()).rejects.toThrow('extension.query');

    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    process.off('unhandledRejection', unhandled);

    expect(unhandled).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a render awaiting a connection with a `then` of its own', async () => {
    const setup = await openedWith(schema, DDL);
    const run = vi.fn(() => Promise.resolve());
    const client = setup.follow.client(Object.assign(setup.pg, thenable(run)));
    const held = { awaited: client as unknown as Promise<unknown> };
    const caught = vi.fn();
    const { render } = await engineOf(setup, async (_props, $) => {
      try {
        await held.awaited;
      } catch (error) {
        caught(error);
      }
      return $.h('p', null, 'caught');
    });

    await expect(render()).rejects.toThrow('`then`');
    expect(caught).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it('retains root client tracking through valueOf', async () => {
    const setup = await openedWith(schema, DDL);
    const client = setup.follow.client(setup.pg);
    const escaped = client.valueOf() as typeof client;
    const { engine, render } = await engineOf(setup, async (_props, $) => {
      const result = await escaped.query<{ title: string }>(
        'SELECT title FROM tasks WHERE id = $1',
        ['t1'],
      );
      return $.h('p', null, result.rows[0]?.title ?? '');
    });

    await expect(render()).resolves.toBe('First');

    await setup.orm.update(tasks).set({ title: 'Changed' }).where(eq(tasks.id, 't1'));
    await engine.poke();

    await expect(render()).resolves.toBe('Changed');
  });

  it('forwards namespace assignments and deletions to the original registry outside renders', async () => {
    const setup = await openedWith(schema, DDL);
    const registry: Record<string, (value: unknown) => string> = { text: () => 'old' };
    const client = setup.follow.client(Object.assign(setup.pg, { registry }));
    client.registry['text'] = replacement;
    client.registry['enum'] = replacement;

    expect(registry['text']).toBe(replacement);
    expect(registry['enum']).toBe(replacement);

    delete client.registry['enum'];

    expect(Object.hasOwn(registry, 'enum')).toBe(false);
  });

  it.each([
    "SELECT set_config('search_path', 'other', true)",
    "SELECT pg_catalog.\"set_config\"('search_path', 'other', true)",
    String.raw`SELECT U&"set\005fconfig"('search_path', 'other', true)`,
  ])('refuses a render that changes its own query context: %s', async (statement) => {
    const setup = await openedWith(schema, DDL);
    const client = setup.follow.client(setup.pg);
    const { render } = await engineOf(setup, async (_props, $) => {
      await client.transaction(async (tx) => {
        try {
          await tx.query(statement);
        } catch {
          // The evaluation still carries the refused read.
        }
      });
      return $.h('p', null, 'caught');
    });

    await expect(render()).rejects.toThrow('query context');
  });

  it('keeps ordinary strings, quoted columns and supported transactions', async () => {
    const setup = await openedWith(schema, DDL);
    const client = setup.follow.client(setup.pg);
    const { render } = await engineOf(setup, async (_props, $) => {
      const result = await client.transaction(async (tx) => {
        return tx.query("SELECT 'set_config(' AS set_config, title FROM tasks WHERE id = $1", [
          't1',
        ]);
      });
      return $.h('p', null, JSON.stringify(result.rows));
    });

    await expect(render()).resolves.toContain('First');
  });

  it('admits ordinary unquoted literal operators using the server keyword categories', async () => {
    const setup = await openedWith(schema, DDL);
    const { render } = await engineOf(setup, async (_props, $) => {
      const found: string[] = [];
      for (const statement of [
        "SELECT title FROM tasks WHERE title LIKE 'F%'",
        "SELECT title FROM tasks WHERE title NOT ILIKE 'other'",
        "SELECT title FROM tasks WHERE title::text LIKE 'F%'",
      ]) {
        const result = await setup.orm.execute<{ title: string }>(sql.raw(statement));
        found.push(result.rows[0]?.title ?? '');
      }
      return $.h('p', null, found.join(','));
    });

    await expect(render()).resolves.toBe('First,First,First');
  });

  it('admits the SIMILAR separator in substring and in an unrelated SQL function body', async () => {
    const statement = `SELECT substring('abc' SIMILAR '%#"b#"%' ESCAPE '#')`;
    const setup = await openedWith(
      schema,
      `${DDL}
      CREATE FUNCTION stored_substring() RETURNS text LANGUAGE sql AS $$ ${statement} $$;
    `,
    );
    const { render } = await engineOf(setup, async (_props, $) => {
      const result = await setup.orm.execute<{ value: string }>(sql.raw(`${statement} AS value`));
      return $.h('p', null, result.rows[0]?.value ?? '');
    });

    await expect(render()).resolves.toBe('b');
  });

  it('admits native DEC aliases in casts and SQL function bodies', async () => {
    const setup = await openedWith(
      schema,
      `${DDL}
      CREATE FUNCTION native_dec() RETURNS numeric LANGUAGE sql AS $$ SELECT CAST(1 AS DEC) $$;
    `,
    );
    const { render } = await engineOf(setup, async (_props, $) => {
      const result = await setup.orm.execute<{ a: string | number; b: string | number }>(
        sql`SELECT 1::dec AS a, CAST(1 AS DEC) AS b`,
      );
      return $.h('p', null, `${String(result.rows[0]?.a)}:${String(result.rows[0]?.b)}`);
    });

    await expect(render()).resolves.toBe('1:1');
  });

  it('admits native scalar JSON PASSING and known RETURNING types, including SQL bodies', async () => {
    const statement = `SELECT json_value('{"a":"v"}'::jsonb, '$.a' PASSING 'v' AS x RETURNING text)`;
    const setup = await openedWith(
      schema,
      `${DDL} CREATE FUNCTION stored_json() RETURNS text LANGUAGE sql AS $$ ${statement} $$;`,
    );
    const { render } = await engineOf(setup, async (_props, $) => {
      const result = await setup.orm.execute<{ value: string }>(sql.raw(`${statement} AS value`));
      return $.h('p', null, result.rows[0]?.value ?? '');
    });

    await expect(render()).resolves.toBe('v');
  });

  it.each([
    `SELECT * FROM json_table('{"v":"a"}', '$' COLUMNS(v text PATH '$.v')) AS x`,
    `SELECT * FROM xmltable('/x' PASSING XMLPARSE(DOCUMENT '<x><v>a</v></x>') COLUMNS v text PATH 'v') AS x`,
  ])('refuses unproven JSON/XML typed table clauses: %s', async (statement) => {
    const setup = await openedWith(schema, DDL);
    const { render } = await engineOf(setup, async (_props, $) => {
      const result = await setup.orm.execute(sql.raw(statement));
      return $.h('p', null, JSON.stringify(result.rows));
    });

    await expect(render()).rejects.toThrow('unproven typed table clause');
  });

  it('invalidates cached reads for an observed context change and change back within a digest interval', async () => {
    const setup = await openedWith(schema, DDL);
    const client = setup.follow.client(setup.pg);
    const evaluate = vi.fn<ComponentProgram['evaluate']>(async (_props, $) => {
      const rows = await client.query<{ title: string }>('SELECT title FROM tasks WHERE id = $1', [
        't1',
      ]);
      return $.h('p', null, rows.rows[0]?.title ?? '');
    });
    const { engine, render } = await engineOf(setup, evaluate);

    await expect(render()).resolves.toBe('First');

    evaluate.mockClear();

    await client.exec('SET search_path = other, public; RESET search_path');
    await engine.poke();

    await expect(render()).resolves.toBe('First');
    expect(evaluate).toHaveBeenCalledWith({}, expect.anything());
  });

  it.each([
    'execProtocol',
    'execProtocolRaw',
    'execProtocolRawStream',
    'execProtocolRawSync',
    'execProtocolStream',
  ])('invalidates cached reads for a context change through %s', async (method) => {
    const setup = await openedWith(schema, DDL);
    const client = setup.follow.client(setup.pg);
    const evaluate = vi.fn<ComponentProgram['evaluate']>(async (_props, $) => {
      const rows = await client.query<{ title: string }>('SELECT title FROM tasks WHERE id = $1', [
        't1',
      ]);
      return $.h('p', null, rows.rows[0]?.title ?? '');
    });
    const { engine, render } = await engineOf(setup, evaluate);

    await expect(render()).resolves.toBe('First');

    evaluate.mockClear();

    const message = protocol.serialize.query('SET search_path = other, public; RESET search_path');
    const methods = client as unknown as Record<
      string,
      (message: Uint8Array, options: { readonly onRawData: () => void }) => unknown
    >;
    await methods[method]?.(message, { onRawData: vi.fn() });
    await engine.poke();

    await expect(render()).resolves.toBe('First');
    expect(evaluate).toHaveBeenCalledWith({}, expect.anything());
  });

  it('answers the synchronous protocol call at once', async () => {
    const setup = await openedWith(schema, DDL);
    const client = setup.follow.client(setup.pg);

    expect(client.execProtocolRawSync(protocol.serialize.query('SELECT 1'))).toBeInstanceOf(
      Uint8Array,
    );
  });

  it('asks a warmed query for its new relation after an observed search path change', async () => {
    const setup = await openedWith(schema, DDL);
    const client = setup.follow.client(setup.pg);
    const { engine, render } = await engineOf(setup, async (_props, $) => {
      const result = await client.query<{ title: string }>(
        'SELECT title FROM tasks WHERE id = $1',
        ['t1'],
      );
      return $.h('p', null, result.rows[0]?.title ?? '');
    });

    await expect(render()).resolves.toBe('First');

    await client.query('SET search_path = other, public');
    await engine.poke();

    await expect(render()).resolves.toBe('Other');

    await setup.orm.update(otherTasks).set({ title: 'Changed' }).where(eq(otherTasks.id, 't1'));
    await engine.poke();

    await expect(render()).resolves.toBe('Changed');
  });

  it.each([
    "SELECT (ROW('p1', 'p2')::pg_temp.staging).y",
    "SELECT (ROW('p1', 'p2')::staging).y",
    "SELECT (CAST(ROW('p1', 'p2') AS staging)).y",
  ])('refuses a direct temporary table row type: %s', async (statement) => {
    const setup = await openedWith(schema, `${DDL} CREATE TEMP TABLE staging (x text, y text);`);
    const { render } = await engineOf(setup, async (_props, $) => {
      const result = await setup.orm.execute(sql.raw(statement));
      return $.h('p', null, JSON.stringify(result.rows));
    });

    await expect(render()).rejects.toThrow('temporary table row type');
  });

  it('refuses known string-body SQL functions that reference a temporary table row type', async () => {
    const setup = await openedWith(
      schema,
      `${DDL}
      CREATE TEMP TABLE staging (x text, y text);
      CREATE FUNCTION hidden_type() RETURNS text LANGUAGE sql IMMUTABLE AS $$
        SELECT (ROW('p1', 'p2')::pg_temp.staging).y
      $$;
    `,
    );
    const { render } = await engineOf(setup, async (_props, $) => {
      const result = await setup.orm.execute(sql`SELECT hidden_type()`);
      return $.h('p', null, JSON.stringify(result.rows));
    });

    await expect(render()).rejects.toThrow('temporary table row type');
  });

  it.each([
    ['CREATE DOMAIN pg_temp.code AS text', "SELECT 'p1'::pg_temp.code AS v"],
    ['CREATE DOMAIN pg_temp.code AS text', "SELECT 'p1'::code AS v"],
    ["CREATE TYPE pg_temp.mood AS ENUM ('p1')", "SELECT 'p1'::mood AS v"],
    ['CREATE TYPE pg_temp.pair AS (x text, y text)', "SELECT (ROW('p0', 'p1')::pair).y AS v"],
    [
      'CREATE TEMP TABLE staging (x text, y text); CREATE DOMAIN pg_temp.paired AS pg_temp.staging',
      "SELECT (ROW('p0', 'p1')::pg_temp.staging).y AS v",
    ],
    [
      'CREATE TEMP VIEW recent AS SELECT * FROM tasks',
      "SELECT (ROW('t9', 'p1')::recent).title AS v",
    ],
    ['CREATE TEMP TABLE status (x text, y text)', "SELECT (ROW('p0', 'p1')::status).y AS v"],
    [
      'CREATE TEMP TABLE staging (x text, y text); CREATE TYPE pg_temp.wrap AS (s pg_temp.staging)',
      "SELECT (ROW('p0', 'p1')::staging).y AS v",
    ],
  ])(
    'admits a temporary type whose changes the schema count follows: %s',
    async (made, statement) => {
      const setup = await openedWith(
        schema,
        `${DDL} CREATE TYPE status AS ENUM ('open'); ${made};`,
      );
      const { render } = await engineOf(setup, async (_props, $) => {
        const result = await setup.orm.execute(sql.raw(statement));
        return $.h('p', null, JSON.stringify(result.rows));
      });

      await expect(render()).resolves.toContain('p1');
    },
  );

  it.each([
    'CREATE TEMP TABLE holder (s staging)',
    "CREATE TEMP TABLE holder (s text CHECK ((ROW(s, s)::staging).x <> ''))",
    "CREATE SCHEMA IF NOT EXISTS reactive_state; CREATE DOMAIN reactive_state.e AS text DEFAULT (('(a,b)'::pg_temp.staging).x)",
  ])(
    'refuses a temporary table row type no counted domain, range, function or composite type is of: %s',
    async (holder) => {
      const setup = await openedWith(
        schema,
        `${DDL} CREATE TEMP TABLE staging (x text, y text); ${holder};`,
      );
      const { render } = await engineOf(setup, async (_props, $) => {
        const result = await setup.orm.execute(
          sql`SELECT (ROW('p0', 'p1')::pg_temp.staging).y AS v`,
        );
        return $.h('p', null, JSON.stringify(result.rows));
      });

      await expect(render()).rejects.toThrow('temporary table row type');
    },
  );

  it('refuses a temporary table row type a domain of the log schema is of, a keyword its name', async () => {
    const setup = await openedWith(
      schema,
      `${DDL}
      CREATE TEMP TABLE staging (x text, y text);
      CREATE SCHEMA "user";
      CREATE DOMAIN "user".e AS text DEFAULT (('(a,b)'::pg_temp.staging).x);
    `,
      'user',
    );
    const { render } = await engineOf(setup, async (_props, $) => {
      const result = await setup.orm.execute(sql`SELECT (ROW('p0', 'p1')::pg_temp.staging).y AS v`);
      return $.h('p', null, JSON.stringify(result.rows));
    });

    await expect(render()).rejects.toThrow('temporary table row type');
  });

  it('refuses a temporary table row type again once nothing it names is of it', async () => {
    const setup = await openedWith(
      schema,
      `${DDL}
      CREATE TEMP TABLE staging (x text, y text);
      CREATE DOMAIN pg_temp.paired AS pg_temp.staging;
    `,
    );
    const { engine, render } = await engineOf(setup, async (_props, $) => {
      const result = await setup.orm.execute(sql`SELECT (ROW('p0', 'p1')::pg_temp.staging).y AS v`);
      return $.h('p', null, JSON.stringify(result.rows));
    });

    await expect(render()).resolves.toContain('p1');

    await setup.pg.query('DROP DOMAIN pg_temp.paired');
    await engine.poke();

    await expect(render()).rejects.toThrow('temporary table row type');
  });

  it.each([
    "SELECT title FROM tasks FETCH FIRST '1' ROWS ONLY",
    "SELECT title FROM tasks OFFSET '0' ROWS FETCH NEXT '1' ROWS ONLY",
    "SELECT title, count(*) OVER (ORDER BY id ROWS '1' PRECEDING) FROM tasks",
    "SELECT title, count(*) OVER (ORDER BY id DESC ROWS '1' PRECEDING) FROM tasks",
    "SELECT title, count(*) OVER w FROM tasks WINDOW w AS (ORDER BY id ROWS '1' PRECEDING)",
    "SELECT title FROM tasks WHERE U&'F!0069rst' UESCAPE '!' = title",
    "SELECT title FROM tasks WHERE xmlexists('//a' PASSING BY REF '<a/>')",
    "SELECT type FROM tasks AS t(name, type) WHERE t.name LIKE 't%' AND t.type LIKE 'F%'",
    "SELECT type FROM tasks AS t(name, type) WHERE type ILIKE 'f%'",
    "SELECT type FROM tasks AS t(name, type) WHERE name NOT LIKE 'x%'",
    "SELECT type, json_object(name VALUE 'x')::text FROM tasks AS t(name, type)",
    "SELECT type, count(*) OVER (ORDER BY name ROWS '1' PRECEDING) FROM tasks AS t(name, type)",
    "SELECT title FROM tasks WHERE title::character varying LIKE 'F%'",
    "SELECT title FROM tasks WHERE CASE WHEN true THEN title END LIKE 'F%'",
  ])('admits the literal of a clause that only a keyword precedes: %s', async (statement) => {
    const setup = await openedWith(schema, DDL);
    const { render } = await engineOf(setup, async (_props, $) => {
      const result = await setup.orm.execute(sql.raw(statement));
      return $.h('p', null, JSON.stringify(result.rows));
    });

    await expect(render()).resolves.toContain('First');
  });

  it("admits a render beside a string-body function that writes a keyword's column", async () => {
    const setup = await openedWith(
      schema,
      `${DDL}
      CREATE TABLE notes (name text);
      CREATE FUNCTION touch() RETURNS void LANGUAGE sql AS $$
        UPDATE notes SET name = 'x' WHERE name LIKE 'y'
      $$;
    `,
    );
    const { render } = await engineOf(setup, async (_props, $) => {
      const result = await setup.orm.select().from(tasks);
      return $.h('p', null, result[0]?.title ?? '');
    });

    await expect(render()).resolves.toBe('First');
  });

  it.each(['keys', 'gone', 'n'])(
    "admits a render beside a staging table of a word of the log's own functions: %s",
    async (name) => {
      const setup = await openedWith(schema, `${DDL} CREATE TEMP TABLE ${name} (x text);`);
      const other = followDrizzle(schema, { namespace: 'log_two' });
      for (const statement of other.captureSql()) await setup.pg.query(statement);
      const { render } = await engineOf(setup, async (_props, $) => {
        const result = await setup.orm.select().from(tasks);
        return $.h('p', null, result[0]?.title ?? '');
      });

      await expect(render()).resolves.toBe('First');
    },
  );

  it.each([
    "CREATE FUNCTION public.ddl_count() RETURNS text LANGUAGE sql AS $$ SELECT (ROW('p1', 'p2')::pg_temp.staging).y $$",
    "CREATE SCHEMA IF NOT EXISTS reactive_state; CREATE FUNCTION reactive_state.ddl_count(a integer) RETURNS text LANGUAGE sql AS $$ SELECT (ROW('p1', 'p2')::pg_temp.staging).y $$",
    `CREATE SCHEMA audit;
     CREATE FUNCTION audit.note_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN NULL; END $$;
     CREATE EVENT TRIGGER audit_note ON ddl_command_end EXECUTE FUNCTION audit.note_ddl();
     CREATE FUNCTION audit.ddl_count() RETURNS text LANGUAGE sql AS $$ SELECT (ROW('p1', 'p2')::pg_temp.staging).y $$`,
  ])("reads the body of an application's function of a log function's name: %s", async (made) => {
    const setup = await openedWith(
      schema,
      `${DDL} CREATE TEMP TABLE staging (x text, y text); ${made};`,
    );
    const { render } = await engineOf(setup, async (_props, $) => {
      const result = await setup.orm.select().from(tasks);
      return $.h('p', null, result[0]?.title ?? '');
    });

    await expect(render()).rejects.toThrow('temporary table row type');
  });

  it('admits ordinary reads beside a temporary staging table', async () => {
    const setup = await openedWith(
      schema,
      `${DDL} CREATE TEMP TABLE staging (LIKE tasks INCLUDING ALL);`,
    );
    const { render } = await engineOf(setup, async (_props, $) => {
      const result = await setup.orm.select().from(tasks);
      return $.h('p', null, result[0]?.title ?? '');
    });

    await expect(render()).resolves.toBe('First');
  });

  it('admits unrelated permanent enum and domain casts in string-body SQL functions', async () => {
    const setup = await openedWith(
      schema,
      `${DDL}
      CREATE TYPE ignored_status AS ENUM ('ok');
      CREATE DOMAIN ignored_domain AS text;
      CREATE FUNCTION uncalled_enum() RETURNS ignored_status LANGUAGE sql AS $$ SELECT 'ok'::ignored_status $$;
      CREATE FUNCTION uncalled_domain() RETURNS ignored_domain LANGUAGE sql AS $$ SELECT 'ok'::ignored_domain $$;
    `,
    );
    const { render } = await engineOf(setup, async (_props, $) => {
      const result = await setup.orm.select().from(tasks);
      return $.h('p', null, result[0]?.title ?? '');
    });

    await expect(render()).resolves.toBe('First');
  });

  it.each([
    [1, 'First'],
    [2, 'First'],
  ])(
    'plans a render again once the query context changes as it is planned: %i times',
    async (changes, title) => {
      const setup = await openedWith(schema, DDL);
      const exec = setup.pg.exec.bind(setup.pg);
      let left = changes;
      vi.spyOn(setup.pg, 'exec').mockImplementation(async (...args) => {
        const answered = await exec(...args);
        if (left > 0 && args[0].includes('"builtinTypes"')) {
          left -= 1;
          generationOf('reactive_state').generation += 1;
        }
        return answered;
      });
      const { render } = await engineOf(setup, async (_props, $) => {
        const result = await setup.orm.select().from(tasks);
        return $.h('p', null, result[0]?.title ?? '');
      });

      await expect(render()).resolves.toBe(title);
    },
  );

  it('refuses a render whose query context changes each time it is planned', async () => {
    const setup = await openedWith(schema, DDL);
    const exec = setup.pg.exec.bind(setup.pg);
    vi.spyOn(setup.pg, 'exec').mockImplementation(async (...args) => {
      const answered = await exec(...args);
      if (args[0].includes('"builtinTypes"')) generationOf('reactive_state').generation += 1;
      return answered;
    });
    const { render } = await engineOf(setup, async (_props, $) => {
      const result = await setup.orm.select().from(tasks);
      return $.h('p', null, result[0]?.title ?? '');
    });

    await expect(render()).rejects.toThrow('changed each time a render was being planned');
  });

  it('admits a transaction while the first main-connection catalog is waiting for its mutex', async () => {
    const setup = await openedWith(schema, DDL);
    const client = setup.follow.client(setup.pg);
    const { promise: mainPlanned, resolve: planned } = Promise.withResolvers<undefined>();
    const { promise: transactionStarted, resolve: started } = Promise.withResolvers<undefined>();
    const exec = setup.pg.exec.bind(setup.pg);
    vi.spyOn(setup.pg, 'exec').mockImplementation(async (...args) => {
      if (args[0].includes('"builtinTypes"')) {
        planned(undefined);
        await transactionStarted;
      }
      return exec(...args);
    });
    const { render } = await engineOf(setup, async (_props, $) => {
      const main = client.query('SELECT title FROM tasks');
      await mainPlanned;
      const transaction = client.transaction(async (tx) => {
        started(undefined);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = { ms: 5000 } as const;
        try {
          return await Promise.race([
            tx.query('SELECT id FROM tasks'),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                reject(new Error('Catalog planning deadlocked across a transaction.'));
              }, deadline.ms);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      });
      await Promise.all([main, transaction]);
      return $.h('p', null, 'read');
    });

    await expect(render()).resolves.toBe('read');
  });

  it.each([
    "SELECT (ROW('p1', 'p2')::staging).y",
    "SELECT CASE staging '(p1,p2)'::text WHEN '(p1,p2)' THEN 'same' ELSE 'different' END",
    `SELECT json_value('{"v":"(p1,p2)"}'::jsonb, '$.v' RETURNING staging)::text`,
    `SELECT v::text FROM json_to_record('{"v":{"x":"p1","y":"p2"}}') AS x(v staging)`,
    `SELECT v::text FROM json_to_record('{"v":{"x":"p1","y":"p2"}}') x(v staging)`,
    `SELECT v::text FROM ROWS FROM(json_to_record('{"v":{"x":"p1","y":"p2"}}') AS (v staging)) AS x`,
  ])(
    'refuses an unknown row type introduced after the first catalog without re-reading that catalog: %s',
    async (nextStatement) => {
      const setup = await openedWith(schema, DDL);
      let statement = 'SELECT title FROM tasks';
      const { engine, render } = await engineOf(setup, async (_props, $) => {
        const result = await setup.orm.execute(sql.raw(statement));
        return $.h('p', null, JSON.stringify(result.rows));
      });

      await expect(render()).resolves.toContain('First');

      await setup.pg.query('CREATE TEMP TABLE staging (x text, y text)');
      statement = nextStatement;
      await setup.orm.update(tasks).set({ title: 'Changed' }).where(eq(tasks.id, 't1'));
      await engine.poke();

      await expect(render()).rejects.toThrow('unknown cast type');
    },
  );

  it('counts a temporary row type shadowing a built-in type after the first catalog', async () => {
    const setup = await openedWith(schema, DDL);
    const evaluate = vi.fn<ComponentProgram['evaluate']>(async (_props, $) => {
      const result = await setup.orm.select().from(tasks);
      return $.h('p', null, result[0]?.title ?? '');
    });
    const { engine, render } = await engineOf(setup, evaluate);

    await expect(render()).resolves.toBe('First');

    evaluate.mockClear();
    await setup.pg.query('CREATE TEMP TABLE text (x int, y int)');
    await engine.poke();

    await expect(render()).resolves.toBe('First');
    expect(evaluate).toHaveBeenCalledWith({}, expect.anything());
  });

  it('refuses a late temporary type named double, whose bare name is no builtin alias', async () => {
    const setup = await openedWith(schema, DDL);
    let statement = 'SELECT title FROM tasks';
    const { engine, render } = await engineOf(setup, async (_props, $) => {
      const result = await setup.orm.execute(sql.raw(statement));
      return $.h('p', null, JSON.stringify(result.rows));
    });

    await expect(render()).resolves.toContain('First');

    await setup.pg.query('CREATE TEMP TABLE double (x text)');
    statement = "SELECT ROW('1')::double";
    await setup.orm.update(tasks).set({ title: 'Changed' }).where(eq(tasks.id, 't1'));
    await engine.poke();

    await expect(render()).rejects.toThrow('unknown cast type');
  });

  it.each([
    'CREATE TABLE partitioned (id text, title text); CREATE TABLE inherited (extra text) INHERITS (tasks)',
    "CREATE TABLE partitioned (id text, title text) PARTITION BY LIST (id); CREATE TABLE inherited PARTITION OF partitioned FOR VALUES IN ('t1')",
  ])(
    'refuses inherited and partition scans that statement capture cannot follow: %s',
    async (extra) => {
      const inherited = pgTable('inherited', { id: text(), title: text() });
      const partitioned = pgTable('partitioned', { id: text(), title: text() });
      const setup = await openedWith({ ...schema, inherited, partitioned }, `${DDL} ${extra};`);
      const { render } = await engineOf(setup, async (_props, $) => {
        const result = await setup.orm.select().from(inherited);
        return $.h('p', null, JSON.stringify(result));
      });

      await expect(render()).rejects.toThrow('inheritance or partition');
    },
  );
});
