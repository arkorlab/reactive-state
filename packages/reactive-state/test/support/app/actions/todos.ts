import { requireUser } from '../auth.ts';
import { db } from '../db.ts';
import { requiredText } from '../input.ts';
import { assertCanEditProject, assertCanEditTodo } from '../permissions.ts';

/**
 * The test application's `actions/todos` — a `'use server'` module, as the fixture's is — which the
 * authority runs as a server operation module: each function makes its writes in one transaction,
 * and checks the session's permissions in it.
 */

export async function createTodo(projectId: string, form: FormData): Promise<void> {
  await db.transaction(async () => {
    const user = await requireUser();
    await assertCanEditProject(user, projectId);
    const title = requiredText(form, 'title', 200);
    await db.todos.insert({ projectId, title, completed: false, estimate: 0 });
  });
}

export async function deleteTodo(projectId: string, id: string): Promise<void> {
  await db.transaction(async () => {
    const user = await requireUser();
    await assertCanEditTodo(user, projectId, id);
    await db.todos.delete(id);
  });
}

export async function moveTodo(projectId: string, id: string, form: FormData): Promise<void> {
  await db.transaction(async () => {
    const user = await requireUser();
    await assertCanEditTodo(user, projectId, id);
    const targetProjectId = requiredText(form, 'targetProjectId', 64);
    await assertCanEditProject(user, targetProjectId);
    await db.todos.update(id, { projectId: targetProjectId });
  });
}

export async function completeProject(projectId: string): Promise<void> {
  await db.transaction(async () => {
    const user = await requireUser();
    await assertCanEditProject(user, projectId);
    const todos = await db.todos.findMany({
      where: { projectId, completed: false },
      select: { id: true },
    });
    for (const todo of todos) {
      await db.todos.update(todo.id, { completed: true });
    }
  });
}
