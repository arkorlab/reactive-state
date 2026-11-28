import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import type { Engine } from '../src/authority/index.ts';
import type { OperationArgument } from '../src/program.ts';
import { orm } from './support/todo-app/db.ts';
import { opened } from './support/todo-app/engine.ts';
import { mayEdit } from './support/todo-app/permissions.ts';
import { BUILD } from './support/todo-app/programs.ts';
import { memberships, projects, todos } from './support/todo-app/schema.ts';
import {
  completeOpenTodos,
  deleteTodoOf,
  insertTodo,
  moveTodoTo,
} from './support/todo-app/writes.ts';

/**
 * The test application's operations of Drizzle in D1: who may do what, refused in the old
 * application's order — the permission (403) before the input (422) — and the permission that the
 * statement writing holds in its condition, which refuses a write of itself, whatever the
 * operation read before it. Alice owns `p1` and `p2`; Bob, a member of both who may edit them,
 * owns `p3`; Carol is of no project.
 */

type Sent = string | Readonly<Record<string, string>>;

/** A server operation of `actions/todos` by `user`: `ok`, or the status it was refused with. */
async function outcome(engine: Engine, user: string, name: string, args: readonly Sent[]) {
  const { sessionId } = await engine.login(user);
  const sent = args.map((arg): OperationArgument =>
    typeof arg === 'string' ? { json: arg } : { form: Object.entries(arg) },
  );
  try {
    await engine.operate(sessionId, {
      args: sent,
      build: BUILD,
      module: 'actions/todos',
      name,
      operationId: crypto.randomUUID(),
    });
    return 'ok';
  } catch (error) {
    return (error as { readonly status?: unknown }).status;
  }
}

/** Whether `mayEdit` holds of the user and the project, as a statement reads it. */
async function editable(user: string, project: string): Promise<boolean> {
  const [read] = await orm.all<{ readonly allowed: number }>(
    sql`SELECT ${mayEdit(user, project)} AS allowed`,
  );
  return read?.allowed === 1;
}

/** Each call, as the old application answered it, by each user: `ok`, or the status. */
const ANSWERED: readonly (readonly [string, readonly Sent[], unknown, unknown, unknown])[] = [
  ['createTodo', ['p1', { title: 'Made' }], 'ok', 'ok', 403],
  ['createTodo', ['p1', { title: '' }], 422, 422, 403],
  ['createTodo', ['p3', { title: 'Made' }], 403, 'ok', 403],
  ['createTodo', ['p3', { title: '' }], 403, 422, 403],
  ['createTodo', ['gone', { title: '' }], 403, 403, 403],
  ['moveTodo', ['p1', 't1', { targetProjectId: 'p2' }], 'ok', 'ok', 403],
  ['moveTodo', ['p1', 't1', { targetProjectId: 'p3' }], 403, 'ok', 403],
  ['moveTodo', ['p1', 't1', { targetProjectId: '' }], 422, 422, 403],
  ['moveTodo', ['p1', 'gone', { targetProjectId: '' }], 403, 403, 403],
  ['moveTodo', ['p3', 't1', { targetProjectId: '' }], 403, 403, 403],
  ['deleteTodo', ['p1', 't1'], 'ok', 'ok', 403],
  ['deleteTodo', ['p1', 'gone'], 403, 403, 403],
  ['completeProject', ['p1'], 'ok', 'ok', 403],
  ['completeProject', ['p3'], 403, 'ok', 403],
];

/** The same, a row of each user's. */
const CASES = ANSWERED.flatMap(([name, args, ...answers]) =>
  ['alice', 'bob', 'carol'].map((user, at) => [user, name, args, answers[at]] as const),
);

describe('the test application’s operations', () => {
  it.each(CASES)('answers %s’s %s of %j as the old application did', async (...row) => {
    const [user, name, args, answered] = row;
    const engine = await opened();

    await expect(outcome(engine, user, name, args)).resolves.toBe(answered);
  });

  it.each([
    ['the owner', 'alice', 'p1', true],
    ['a member who may edit', 'bob', 'p1', true],
    ['the owner of another', 'alice', 'p3', false],
    ['a user of no project', 'carol', 'p1', false],
    ['a project there is not', 'bob', 'gone', false],
  ] as const)('holds the permission of %s', async (_, user, project, allowed) => {
    await opened();

    await expect(editable(user, project)).resolves.toBe(allowed);
  });

  it('holds no permission of a member it lets not edit', async () => {
    await opened();
    await orm.update(memberships).set({ canEdit: false }).where(eq(memberships.id, 'p1-bob'));

    await expect(editable('bob', 'p1')).resolves.toBe(false);
    await expect(editable('bob', 'p2')).resolves.toBe(true);
  });

  it('holds no permission of a project deleted, its memberships left', async () => {
    await opened();
    await orm.delete(projects).where(eq(projects.id, 'p1'));

    await expect(editable('bob', 'p1')).resolves.toBe(false);
    await expect(editable('alice', 'p1')).resolves.toBe(false);
  });

  it('lets a member who may edit create, and forbids it once she may not', async () => {
    const engine = await opened();
    const create = async () => outcome(engine, 'bob', 'createTodo', ['p1', { title: 'Made' }]);

    await expect(create()).resolves.toBe('ok');

    await orm.update(memberships).set({ canEdit: false }).where(eq(memberships.id, 'p1-bob'));

    await expect(create()).resolves.toBe(403);
  });

  it('forbids a member to create in, or move into, a project deleted, its memberships left', async () => {
    const engine = await opened();
    await orm.delete(projects).where(eq(projects.id, 'p1'));
    const before = await orm.select().from(todos);

    await expect(outcome(engine, 'bob', 'createTodo', ['p1', { title: 'Made' }])).resolves.toBe(
      403,
    );
    await expect(
      outcome(engine, 'bob', 'moveTodo', ['p2', 't3', { targetProjectId: 'p1' }]),
    ).resolves.toBe(403);
    await expect(orm.select().from(todos)).resolves.toStrictEqual(before);
  });

  it('writes no row by a statement whose user may not, whatever was read before it', async () => {
    await opened();
    await orm.delete(projects).where(eq(projects.id, 'p2'));
    const before = await orm.select().from(todos);

    const written = [
      await insertTodo('carol', 'p1', { id: 'new', title: 'Made' }),
      await insertTodo('bob', 'p2', { id: 'new', title: 'Made' }),
      await deleteTodoOf('carol', 'p1', 't1'),
      await moveTodoTo('alice', { id: 't1', projectId: 'p1' }, 'p3'),
      await moveTodoTo('bob', { id: 't1', projectId: 'p1' }, 'p2'),
      await completeOpenTodos('carol', 'p1'),
    ];

    expect(written).toStrictEqual([0, 0, 0, 0, 0, 0]);
    await expect(orm.select().from(todos)).resolves.toStrictEqual(before);
  });

  it('writes the rows of a statement whose user may', async () => {
    await opened();

    const written = [
      await insertTodo('bob', 'p1', { id: 'new', title: 'Made' }),
      await moveTodoTo('bob', { id: 'new', projectId: 'p1' }, 'p3'),
      await deleteTodoOf('bob', 'p3', 'new'),
      await completeOpenTodos('alice', 'p1'),
    ];

    expect(written).toStrictEqual([1, 1, 1, 2]);
  });

  it.each([
    ['200 emoji', 200, 'ok'],
    ['201 emoji', 201, 422],
  ] as const)(
    'creates a to-do of a title of %s as the column takes it',
    async (_, length, answer) => {
      const engine = await opened();
      const title = '😀'.repeat(length);

      await expect(outcome(engine, 'alice', 'createTodo', ['p1', { title }])).resolves.toBe(answer);
    },
  );
});
