import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';

import { type Evaluation, evaluate, type TableRead } from '../src/server/context.ts';
import { watchUntracked } from '../src/server/untracked.ts';
import { followDrizzle } from '../src/sql/index.ts';
import { type LocalD1, localD1 } from '../src/sql/sqlite/local-d1.ts';

/**
 * The candidates of an event stream's render of a join, where D1 fails their batch: each source
 * reads its table whole, and none is asked for a while, by the client's own clock — no read of the
 * render's, which the watch does not note, though the render is every visitor's. No render of the
 * authority's is both today, a shared render being no stream's: an evaluation of both is made here,
 * of a file in D1's shape (`localD1`).
 */

const projects = sqliteTable('projects', {
  id: text().primaryKey(),
  title: text().notNull(),
});
const tasks = sqliteTable(
  'tasks',
  {
    id: integer().primaryKey(),
    projectId: text('project_id').notNull(),
    title: text().notNull(),
    code: text().unique(),
  },
  (table) => [index('tasks_project').on(table.projectId)],
);
const schema = { projects, tasks };
const DDL = [
  'CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL)',
  'CREATE TABLE tasks (id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, code TEXT UNIQUE)',
  'CREATE INDEX tasks_project ON tasks (project_id)',
  "INSERT INTO projects VALUES ('p1', 'Launch'), ('p2', 'Ship')",
  "INSERT INTO tasks (id, project_id, title, code) VALUES (1, 'p1', 'one', 'a'), (2, 'p2', 'two', 'b')",
];

/**
 * A database of memory alone of the tables, closed as the test ends, as a D1 that fails each batch
 * of one candidate (`SELECT DISTINCT …`) alone: what it was asked of them.
 */
async function failingCandidates(): Promise<{ binding: LocalD1; candidates: string[] }> {
  const local = localD1(':memory:');
  onTestFinished(() => {
    local.close();
  });
  await local.batch(DDL.map((statement) => local.prepare(statement)));
  const candidates: string[] = [];
  const binding: LocalD1 = {
    ...local,
    batch: async (statements) => {
      const [first] = statements as { readonly sql: string }[];
      if (statements.length !== 1 || first?.sql.startsWith('SELECT DISTINCT') !== true) {
        return local.batch(statements);
      }
      candidates.push(first.sql);
      throw new Error('no candidates');
    },
  };
  return { binding, candidates };
}

/**
 * The tasks of the code `a`, each with its project's title: a join of whose `projects` a candidate
 * names the rows.
 */
function ofCodeA(orm: ReturnType<typeof drizzle<typeof schema>>) {
  return orm
    .select({ title: tasks.title, project: projects.title })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(eq(tasks.code, 'a'));
}

/** What `reads` read of `projects`. */
function projectsIn(reads: readonly TableRead[]): readonly TableRead[] {
  return reads.filter(({ table }) => table === 'projects');
}

/**
 * Renders `read` as a render every visitor shares, an event stream's of `streamed`: what it notes
 * of what it read untracked, and what it read of the tables.
 */
async function sharedRender(
  read: () => Promise<unknown>,
  streamed: boolean,
): Promise<{ readonly noted: readonly string[]; readonly reads: readonly TableRead[] }> {
  const noted: string[] = [];
  const reads: TableRead[] = [];
  const evaluation = {
    readTables: async (taken: () => Promise<readonly TableRead[]>) => {
      reads.push(...(await taken()));
    },
    shared: {
      boundToRequest: (what: string) => {
        noted.push(what);
      },
    },
    streamed,
  } as unknown as Evaluation;
  await evaluate(evaluation, async () => {
    await read();
  });
  return { noted, reads };
}

describe('a shared render of an event stream’s whose candidates D1 fails', () => {
  beforeAll(() => {
    watchUntracked();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('notes nothing of the client’s clock, as it fails and for the while after', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {
      // The client's warning of a batch of candidates that failed, held to below.
    });
    const { binding, candidates } = await failingCandidates();
    const orm = drizzle(followDrizzle(schema).client(binding) as never, { schema });
    const read = () => ofCodeA(orm);
    // A page's render asks the plan, which the stream's renders take.
    const page = await sharedRender(read, false);
    const failed = await sharedRender(read, true);
    const meanwhile = await sharedRender(read, true);

    expect([page.noted, failed.noted, meanwhile.noted]).toStrictEqual([[], [], []]);
    // Asked once: none for a while after it failed.
    expect(candidates).toHaveLength(1);
    expect(projectsIn(failed.reads)).toStrictEqual([{ table: 'projects', where: {} }]);
    expect(projectsIn(meanwhile.reads)).toStrictEqual([{ table: 'projects', where: {} }]);
    expect(warned).toHaveBeenCalledTimes(1);
  });

  it('asks the candidates again past the while, by the clock a spy of `Date.now` moves', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {
      // The client's warning of a batch of candidates that failed.
    });
    const { binding, candidates } = await failingCandidates();
    const orm = drizzle(followDrizzle(schema).client(binding) as never, { schema });
    const read = () => ofCodeA(orm);
    await sharedRender(read, false);
    await sharedRender(read, true);

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    await sharedRender(read, true);

    expect(candidates).toHaveLength(2);
  });
});
