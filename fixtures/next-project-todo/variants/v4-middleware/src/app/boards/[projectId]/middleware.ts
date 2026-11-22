import type { RouteMiddleware } from '@arkorlab/reactive-state/server';
import { requirePublishedProject } from '@/publication';

export default (async ({ params }, next) => {
  await requirePublishedProject(params.projectId);

  const response = await next();
  response.headers.append('X-V4-Middleware', 'boards');
  return response;
}) satisfies RouteMiddleware<{ projectId: string }>;
