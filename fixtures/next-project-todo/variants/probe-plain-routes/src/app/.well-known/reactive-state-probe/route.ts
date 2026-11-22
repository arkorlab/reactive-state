import { connection } from 'next/server';

// A route under a folder of a leading dot, as `.well-known` is, which Next.js serves as any other:
// under the app's middleware, it is delivered through the middleware as any route under it is.
export async function GET(): Promise<Response> {
  await connection();
  return new Response('well-known');
}
