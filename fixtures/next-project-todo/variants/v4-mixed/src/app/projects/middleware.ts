import type { RouteMiddleware } from '@arkorlab/reactive-state/server';
import { requireUser } from '@/auth';

export default (async (_context, next) => {
  await requireUser();
  const response = await next();
  response.headers.append('X-V4-Middleware', 'projects');
  return response;
}) satisfies RouteMiddleware;
