import { and, eq } from 'drizzle-orm';

import { forbidden, requireUser } from '../../../../src/server/index.ts';
import { orm } from '../db.ts';
import { requiredText } from '../input.ts';
import { assertCanEditProject, assertCanEditTodo, mayEdit } from '../permissions.ts';
import { LIMITS, projects } from '../schema.ts';
import { completeOpenTodos, deleteTodoOf, insertTodo, moveTodoTo } from '../writes.ts';

/**
 * The test application's `actions/todos` — a `'use server'` module, as the fixture's is — of its
 * Drizzle in D1. Each refuses in the old application's order: the permission read first (403),
 * then the input (422); then it writes by one statement whose condition holds the permission
 * (`writes.ts`), as D1 holds no transaction its code runs in, and a write of no row was forbidden.
 * A new to-do's id is made here, as the schema makes none.
 */

export async function createTodo(projectId: string, form: FormData): Promise<void> {
  const user = await requireUser();
  await assertCanEditProject(user, projectId);
  const title = requiredText(form, 'title', LIMITS.title);
  const written = await insertTodo(user.id, projectId, { id: crypto.randomUUID(), title });
  if (written === 0) forbidden();
}

export async function deleteTodo(projectId: string, id: string): Promise<void> {
  const user = await requireUser();
  await assertCanEditTodo(user, projectId, id);
  if ((await deleteTodoOf(user.id, projectId, id)) === 0) forbidden();
}

export async function moveTodo(projectId: string, id: string, form: FormData): Promise<void> {
  const user = await requireUser();
  await assertCanEditTodo(user, projectId, id);
  const targetProjectId = requiredText(form, 'targetProjectId', LIMITS.id);
  await assertCanEditProject(user, targetProjectId);
  if ((await moveTodoTo(user.id, { id, projectId }, targetProjectId)) === 0) forbidden();
}

/**
 * Completes every open to-do of the project. A project of none open writes no row either: of no
 * row written, the permission is read again, and refuses where it is gone.
 */
export async function completeProject(projectId: string): Promise<void> {
  const user = await requireUser();
  await assertCanEditProject(user, projectId);
  if ((await completeOpenTodos(user.id, projectId)) > 0) return;
  const [allowed] = await orm
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), mayEdit(user.id, projectId)));
  if (allowed === undefined) forbidden();
}
