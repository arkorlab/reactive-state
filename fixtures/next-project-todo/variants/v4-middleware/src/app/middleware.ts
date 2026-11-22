import type { RouteMiddleware } from '@arkorlab/reactive-state/server';

export default (async (_context, next) => {
  // An actual request's envelope, never part of a reusable render artifact.
  const requestId = crypto.randomUUID();
  const response = await next();
  response.headers.set('X-V4-Request', requestId);
  response.headers.append('X-V4-Middleware', 'root');
  return response;
}) satisfies RouteMiddleware;
