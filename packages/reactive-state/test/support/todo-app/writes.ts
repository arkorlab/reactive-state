import { and, eq, sql } from 'drizzle-orm';

import { orm } from './db.ts';
import { mayEdit } from './permissions.ts';
import { todos } from './schema.ts';

/**
 * The writes of the test application's operations, each one statement whose condition holds the
 * permission (`mayEdit`), so that no row is written that the user may not write, whatever changed
 * since the operation read the permission: D1 holds no transaction the operation's code runs in.
 * Each answers the rows it wrote, as its `RETURNING` lists them — of none, the authority knows the
 * statement wrote nothing, and a refusal after it is 403.
 */

/** The columns a new to-do is inserted of, in the order its values are given. */
const INSERTED = [todos.id, todos.projectId, todos.title, todos.completed, todos.estimate];

/** Inserts the to-do `id`, open and of no estimate, where the user may edit the project. */
export async function insertTodo(
  userId: string,
  projectId: string,
  todo: { readonly id: string; readonly title: string },
): Promise<number> {
  const columns = sql.join(
    INSERTED.map((column) => sql.identifier(column.name)),
    sql`, `,
  );
  const returned = sql.identifier(todos.id.name);
  const inserted = await orm.all(
    sql`INSERT INTO ${todos} (${columns}) SELECT ${todo.id}, ${projectId}, ${todo.title}, 0, 0 WHERE ${mayEdit(userId, projectId)} RETURNING ${returned}`,
  );
  return inserted.length;
}

/** Deletes the project's to-do `id`, where the user may edit the project. */
export async function deleteTodoOf(userId: string, projectId: string, id: string): Promise<number> {
  const deleted = await orm
    .delete(todos)
    .where(and(eq(todos.id, id), eq(todos.projectId, projectId), mayEdit(userId, projectId)))
    .returning({ id: todos.id });
  return deleted.length;
}

/** Moves the project's to-do `id` to `targetProjectId`, where the user may edit both. */
export async function moveTodoTo(
  userId: string,
  todo: { readonly id: string; readonly projectId: string },
  targetProjectId: string,
): Promise<number> {
  const moved = await orm
    .update(todos)
    .set({ projectId: targetProjectId })
    .where(
      and(
        eq(todos.id, todo.id),
        eq(todos.projectId, todo.projectId),
        mayEdit(userId, todo.projectId),
        mayEdit(userId, targetProjectId),
      ),
    )
    .returning({ id: todos.id });
  return moved.length;
}

/** Completes the project's open to-dos, where the user may edit it. */
export async function completeOpenTodos(userId: string, projectId: string): Promise<number> {
  const completed = await orm
    .update(todos)
    .set({ completed: true })
    .where(
      and(eq(todos.projectId, projectId), eq(todos.completed, false), mayEdit(userId, projectId)),
    )
    .returning({ id: todos.id });
  return completed.length;
}
