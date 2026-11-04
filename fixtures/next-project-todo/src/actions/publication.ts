'use server';

import { requireUser } from '@/auth';
import { assertOwnsProject } from '@/permissions';
import { db } from '@/db';

export async function publishBoard(projectId: string): Promise<void> {
  await db.transaction(async () => {
    const user = await requireUser();
    await assertOwnsProject(user, projectId);
    await db.projects.update(projectId, { published: true });
  });
}

export async function withdrawBoard(projectId: string): Promise<void> {
  await db.transaction(async () => {
    const user = await requireUser();
    await assertOwnsProject(user, projectId);
    await db.projects.update(projectId, { published: false });
  });
}
