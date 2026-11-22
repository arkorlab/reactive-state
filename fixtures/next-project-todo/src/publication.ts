import { forbidden } from '@arkorlab/reactive-state/server';
import { db } from '@/db';

// Ordinary application authorization, not a cache/public-route declaration.
// This helper reads no session. Its successful result contains only presentation data.
export async function requirePublishedProject(projectId: string) {
  const project = await db.projects.get(projectId);
  if (project === null || project.published !== true) {
    forbidden();
  }

  return { id: project.id, title: project.title };
}
