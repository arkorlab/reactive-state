import { forbidden } from '@arkorlab/reactive-state/server';
import type { User } from '@/auth';
import { db } from '@/db';

export async function requireProjectAccess(user: User, projectId: string) {
  const project = await db.projects.get(projectId);
  if (project === null) forbidden();

  const memberships = await db.memberships.findMany({
    where: { projectId, userId: user.id },
  });
  const membership = memberships[0];
  const owner = project.ownerId === user.id;
  if (!owner && membership === undefined) forbidden();

  // Only the selected presentation data crosses the rendering boundary, not a User/session.
  return {
    project: { id: project.id, title: project.title },
    canEdit: owner || membership?.canEdit === true,
    canManageMembers: owner,
  };
}

export async function assertCanEditProject(user: User, projectId: string): Promise<void> {
  const access = await requireProjectAccess(user, projectId);
  if (!access.canEdit) forbidden();
}

export async function assertOwnsProject(user: User, projectId: string): Promise<void> {
  const project = await db.projects.get(projectId);
  if (project === null || project.ownerId !== user.id) forbidden();
}

export async function assertCanReadTodo(
  user: User, projectId: string, todoId: string,
): Promise<void> {
  await requireProjectAccess(user, projectId);
  const todo = await db.todos.get(todoId);
  if (todo === null || todo.projectId !== projectId) forbidden();
}

export async function assertCanEditTodo(
  user: User, projectId: string, todoId: string,
): Promise<void> {
  await assertCanEditProject(user, projectId);
  const todo = await db.todos.get(todoId);
  if (todo === null || todo.projectId !== projectId) forbidden();
}

export async function assertCanManageMembership(
  user: User, projectId: string, membershipId: string,
): Promise<void> {
  await assertOwnsProject(user, projectId);
  const membership = await db.memberships.get(membershipId);
  if (membership === null || membership.projectId !== projectId) forbidden();
}
