import { env } from 'cloudflare:workers';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { beforeEach, describe, expect, it } from 'vitest';

import { type Evaluation, evaluate, type TableRead } from '../../src/server/context.ts';
import { followDrizzle } from '../../src/sql/index.ts';

/**
 * A render's first run of a statement text asks D1 for the text's plan, and a statement that writes
 * nothing by its words — one that begins with `SELECT`, a comment before it too, or reads alone
 * (`WITH … SELECT`) — is sent beside that ask, not after it: no D1 call comes before the
 * application's own, which a visitor's first byte waits for.
 */

const projects = sqliteTable('projects', {
  id: text().primaryKey(),
  title: text().notNull(),
});
const tasks = sqliteTable('tasks', {
  id: integer().primaryKey(),
  projectId: text('project_id').notNull(),
  title: text().notNull(),
});
const schema = { projects, tasks };
const db = env.REACTIVE_D1;
/** How long each call of D1 takes, as a database across a network does. */
const DELAY_MS = 25;

/** What happened to D1, in order: the plan's batch and the application's statements, each asked and answered. */
type Event = 'plan answered' | 'plan asked' | 'query answered' | 'query asked';

/** Waits `DELAY_MS`: what a call of D1 takes. */
function sleep(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, DELAY_MS);
  });
}

/**
 * A D1 binding that answers each call of `db`'s after `DELAY_MS`, and tells in `events` when a plan's
 * batch and the application's statements were asked and answered. Its methods are its own: a D1
 * binding's are not callable on a proxy of it.
 */
function slow() {
  const events: Event[] = [];
  const real = new WeakMap<WeakKey, D1PreparedStatement>();
  const statement = (own: D1PreparedStatement): D1PreparedStatement => {
    const made = {
      all: async () => {
        events.push('query asked');
        await sleep();
        const answer = await own.all();
        events.push('query answered');
        return answer;
      },
      bind: (...values: unknown[]) => statement(own.bind(...values)),
    } as unknown as D1PreparedStatement;
    real.set(made, own);
    return made;
  };
  const binding = {
    batch: async (statements: D1PreparedStatement[]) => {
      events.push('plan asked');
      await sleep();
      const answers = await db.batch(statements.map((each) => real.get(each) ?? each));
      events.push('plan answered');
      return answers;
    },
    prepare: (sql: string) => statement(db.prepare(sql)),
  } as unknown as D1Database;
  return { binding, events };
}

/** What a render of `read` noted it read, and the fault it ended with, if any. */
async function render(read: () => Promise<unknown>) {
  const reads: TableRead[] = [];
  const evaluation = {
    readTables: async (taken: () => Promise<readonly TableRead[]>) => {
      reads.push(...(await taken()));
    },
  } as unknown as Evaluation;
  let fault: unknown;
  await evaluate(evaluation, async () => {
    try {
      await read();
    } catch (error) {
      fault = error;
    }
  });
  return { fault, reads };
}

/** `sql`, run by a render of a fresh follow through a D1 that answers slowly. */
async function renderedOf(sql: string) {
  const { binding, events } = slow();
  const client = followDrizzle(schema).client(binding);
  const rendered = await render(() => client.prepare(sql).bind('p1').all());
  return { ...rendered, events };
}

/** How many calls of D1's were answered before the application's statement was asked. */
function serialCallsBefore(events: readonly Event[]): number {
  const asked = events.indexOf('query asked');
  return asked === -1
    ? -1
    : events.slice(0, asked).filter((each) => each.endsWith('answered')).length;
}

/** A text that writes nothing by its words: each is sent beside its plan. */
const BESIDE = [
  ['SELECT', 'SELECT * FROM tasks WHERE project_id = ?'],
  [
    'WITH … SELECT',
    'WITH chosen AS (SELECT id FROM tasks WHERE project_id = ?) SELECT * FROM chosen',
  ],
  [
    'SELECT with a block comment before it',
    '/* the page */ SELECT * FROM tasks WHERE project_id = ?',
  ],
  ['SELECT with a line comment before it', '-- the page\nSELECT * FROM tasks WHERE project_id = ?'],
] as const;

describe("a render's first run of a text, and its plan", () => {
  beforeEach(async () => {
    await db.batch(
      [
        'DROP TABLE IF EXISTS tasks',
        'DROP TABLE IF EXISTS projects',
        'CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL)',
        'CREATE TABLE tasks (id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL)',
        "INSERT INTO tasks (id, project_id, title) VALUES (1, 'p1', 'one'), (2, 'p2', 'two')",
      ].map((statement) => db.prepare(statement)),
    );
  });

  it.each(BESIDE)('sends a %s beside its plan', async (_name, sql) => {
    const { events, fault } = await renderedOf(sql);

    expect(fault).toBeUndefined();
    expect(serialCallsBefore(events)).toBe(0);
  });

  it('notes the tables the plan of a WITH … SELECT names, run beside it, and no other', async () => {
    const { fault, reads } = await renderedOf(BESIDE[1][1]);

    expect(fault).toBeUndefined();
    expect(reads.map((each) => each.table)).toContain('tasks');
    expect(reads.map((each) => each.table)).not.toContain('projects');
  });

  it('sends a WITH a comment is in, which is not read plainly, after its plan', async () => {
    const { events, fault, reads } = await renderedOf(
      '/* the page */ WITH chosen AS (SELECT id FROM tasks WHERE project_id = ?) SELECT * FROM chosen',
    );

    expect(fault).toBeUndefined();
    expect(serialCallsBefore(events)).toBe(1);
    expect(reads.map((each) => each.table)).toContain('tasks');
  });

  it('refuses a text of several statements, a comment before the first too, before any call', async () => {
    const { events, fault } = await renderedOf('/* the page */ SELECT 1; DELETE FROM tasks');

    expect(String(fault)).toMatch(/one statement a text/u);
    expect(events).toStrictEqual([]);
  });

  it('sends a WITH that deletes after its plan, which refuses it before it runs', async () => {
    const { events, fault } = await renderedOf(
      'WITH gone AS (SELECT id FROM tasks WHERE project_id = ?) DELETE FROM tasks WHERE id IN (SELECT id FROM gone)',
    );

    // Never sent: the statement that writes waits for the plan that says it writes.
    expect(String(fault)).toMatch(/writes nothing as it renders/u);
    expect(events).not.toContain('query asked');

    const { results } = await db.prepare('SELECT count(*) AS n FROM tasks').all<{ n: number }>();

    expect(results[0]?.n).toBe(2);
  });
});
