import { forbidden } from '../../../src/server/index.ts';
import type { User } from './auth.ts';
import { db } from './db.ts';

/**
 * The test application's `@/permissions`, as the fixture's: a project's owner and its members may
 * read it, its owner and the members it lets edit may edit it, and its owner alone may change who
 * may. Each is a read the authority notes, so a change to either renders again what read it.
 */

export async function requireProjectAccess(
  user: User,
  projectId: string,
): Promise<{
  readonly project: { readonly id: string; readonly title: string };
  readonly canEdit: boolean;
  readonly canManageMembers: boolean;
}> {
  const project = await db.projects.get(projectId);
  if (project === null) forbidden();
  const memberships = await db.memberships.findMany({ where: { projectId, userId: user.id } });
  const membership = memberships[0];
  const owner = project.ownerId === user.id;
  if (!owner && membership === undefined) forbidden();
  return {
    canEdit: owner || membership?.canEdit === true,
    canManageMembers: owner,
    project: { id: project.id, title: project.title },
  };
}

export async function assertCanEditProject(user: User, projectId: string): Promise<void> {
  const access = await requireProjectAccess(user, projectId);
  if (!access.canEdit) forbidden();
}

async function assertOwnsProject(user: User, projectId: string): Promise<void> {
  const project = await db.projects.get(projectId);
  if (project?.ownerId !== user.id) forbidden();
}

export async function assertCanReadTodo(
  user: User,
  projectId: string,
  todoId: string,
): Promise<void> {
  await requireProjectAccess(user, projectId);
  const todo = await db.todos.get(todoId);
  if (todo?.projectId !== projectId) forbidden();
}

export async function assertCanEditTodo(
  user: User,
  projectId: string,
  todoId: string,
): Promise<void> {
  await assertCanEditProject(user, projectId);
  const todo = await db.todos.get(todoId);
  if (todo?.projectId !== projectId) forbidden();
}

export async function assertCanManageMembership(
  user: User,
  projectId: string,
  membershipId: string,
): Promise<void> {
  await assertOwnsProject(user, projectId);
  const membership = await db.memberships.get(membershipId);
  if (membership?.projectId !== projectId) forbidden();
}
