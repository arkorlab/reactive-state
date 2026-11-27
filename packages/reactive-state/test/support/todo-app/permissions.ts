import { and, eq, exists, or, type SQL, sql } from 'drizzle-orm';

import { forbidden, type User } from '../../../src/server/index.ts';
import { orm } from './db.ts';
import { projectOfTodo } from './reads.ts';
import { memberships, projects } from './schema.ts';

/**
 * The test application's `@/permissions`, of its Drizzle: a project's owner and its members may
 * read it, its owner and the members it lets edit may edit it, and its owner alone may change who
 * may. A render's checks are reads of the rows they name, which the authority notes, so a change to
 * either renders again what read it. An operation reads them first too, to refuse as the old
 * application did, before it checks its input; D1 holds no transaction its code runs in, so the
 * statement that writes holds the permission in its condition as well (`mayEdit`), and one that
 * wrote no row was forbidden.
 */

/** What the session's user may do of a project, and the project. */
export interface ProjectAccess {
  readonly project: { readonly id: string; readonly title: string };
  readonly canEdit: boolean;
  readonly canManageMembers: boolean;
}

/**
 * Whether `userId` may edit the project `projectId`, as a condition of a statement: the project is
 * there, and its owner is the user, or a membership of the user's lets the user edit it. A
 * membership left of a project deleted lets no one edit it.
 */
export function mayEdit(userId: string, projectId: string): SQL {
  const editing = and(
    eq(memberships.projectId, projectId),
    eq(memberships.userId, userId),
    eq(memberships.canEdit, true),
  );
  const member = exists(
    orm
      .select({ one: sql`1` })
      .from(memberships)
      .where(editing),
  );
  const allowed = and(eq(projects.id, projectId), or(eq(projects.ownerId, userId), member));
  return exists(
    orm
      .select({ one: sql`1` })
      .from(projects)
      .where(allowed),
  );
}

export async function requireProjectAccess(user: User, projectId: string): Promise<ProjectAccess> {
  const [project] = await orm.select().from(projects).where(eq(projects.id, projectId));
  if (project === undefined) forbidden();
  const [membership] = await orm
    .select({ canEdit: memberships.canEdit })
    .from(memberships)
    .where(and(eq(memberships.projectId, projectId), eq(memberships.userId, user.id)));
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

export async function assertCanReadTodo(
  user: User,
  projectId: string,
  todoId: string,
): Promise<void> {
  await requireProjectAccess(user, projectId);
  if ((await projectOfTodo(todoId)) !== projectId) forbidden();
}

export async function assertCanEditTodo(
  user: User,
  projectId: string,
  todoId: string,
): Promise<void> {
  await assertCanEditProject(user, projectId);
  if ((await projectOfTodo(todoId)) !== projectId) forbidden();
}

export async function assertCanManageMembership(
  user: User,
  projectId: string,
  membershipId: string,
): Promise<void> {
  const [project] = await orm
    .select({ ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (project?.ownerId !== user.id) forbidden();
  const [membership] = await orm
    .select({ projectId: memberships.projectId })
    .from(memberships)
    .where(eq(memberships.id, membershipId));
  if (membership?.projectId !== projectId) forbidden();
}
