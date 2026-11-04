import type { RouteMiddleware } from '@arkorlab/reactive-state/server';
import { requireUser } from '@/auth';
import { assertOwnsProject } from '@/permissions';

export default (async ({ params }, next) => {
  const user = await requireUser();
  await assertOwnsProject(user, params.projectId);

  const response = await next();
  response.headers.append('X-V4-Middleware', 'publication');
  return response;
}) satisfies RouteMiddleware<{ projectId: string }>;
