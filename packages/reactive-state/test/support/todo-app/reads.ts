import { and, asc, eq, sql } from 'drizzle-orm';

import { orm } from './db.ts';
import { memberships, todos } from './schema.ts';

/**
 * What the test application's components read of its tables beyond a row's access check: the
 * project's to-dos, by title, its totals and its members. Each is one statement, as a render reads
 * no snapshot across two: the two totals, which `db.todos.count` read twice of one snapshot, are
 * counted together.
 */

/** The ids of the project's to-dos the filter shows, by title, then id. */
export async function todoIdsOf(projectId: string, filter: string): Promise<readonly string[]> {
  const project = eq(todos.projectId, projectId);
  const where = filter === 'all' ? project : and(project, eq(todos.completed, filter === 'done'));
  const found = await orm
    .select({ id: todos.id })
    .from(todos)
    .where(where)
    .orderBy(asc(todos.title), asc(todos.id));
  return found.map((todo) => todo.id);
}

/** The ids and titles of the project's to-dos, by title, then id. */
export async function todoChoicesOf(
  projectId: string,
): Promise<readonly { readonly id: string; readonly title: string }[]> {
  return orm
    .select({ id: todos.id, title: todos.title })
    .from(todos)
    .where(eq(todos.projectId, projectId))
    .orderBy(asc(todos.title), asc(todos.id));
}

/** The project's open and completed to-dos, counted by one statement. */
export async function totalsOf(
  projectId: string,
): Promise<{ readonly completed: number; readonly remaining: number }> {
  const [totals] = await orm
    .select({
      completed: sql<number>`count(*) FILTER (WHERE ${todos.completed} = 1)`,
      remaining: sql<number>`count(*) FILTER (WHERE ${todos.completed} = 0)`,
    })
    .from(todos)
    .where(eq(todos.projectId, projectId));
  return { completed: totals?.completed ?? 0, remaining: totals?.remaining ?? 0 };
}

/** The ids of the project's memberships, in order. */
export async function membershipIdsOf(projectId: string): Promise<readonly string[]> {
  const found = await orm
    .select({ id: memberships.id })
    .from(memberships)
    .where(eq(memberships.projectId, projectId))
    .orderBy(asc(memberships.id));
  return found.map((membership) => membership.id);
}

/** The project of the to-do `id`, or none of a to-do there is not. */
export async function projectOfTodo(id: string): Promise<string | undefined> {
  const [todo] = await orm
    .select({ projectId: todos.projectId })
    .from(todos)
    .where(eq(todos.id, id));
  return todo?.projectId;
}
