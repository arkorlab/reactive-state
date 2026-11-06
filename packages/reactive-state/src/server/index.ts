/**
 * What an application's own modules — its `@/db`, `@/auth`, `@/permissions` and its `'use server'`
 * operations — are written with, for the authority to run them: the database declaration and what
 * it reads and writes, the session's user, and the refusal. Everything here that reads is read
 * inside the authority alone, while it renders a component or runs a server operation; anywhere
 * else it throws.
 *
 * Runtime-neutral: the authority runs in Node and in a Durable Object (with `nodejs_compat`, for
 * `node:async_hooks`). The browser never imports it.
 */

import { AuthorityError } from '../authority/errors.ts';
import type { User } from '../program.ts';
import { HTTP_FORBIDDEN } from '../status.ts';
import { currentEvaluation } from './context.ts';

export {
  type AnyDatabase,
  boolean,
  type Database,
  database,
  type Field,
  type FieldType,
  integer,
  json,
  MAX_TEXT_LENGTH,
  type Order,
  type Query,
  type RecordOf,
  type Seed,
  type Select,
  type Selected,
  type Table,
  table,
  type TableHandle,
  text,
  type Where,
  type Writable,
} from './schema.ts';
export type { FieldRef, Json, User, Value } from '../program.ts';

/**
 * The session's user, as the authority signed it in; the authority's own refusal (401) when the
 * request has no session, or one that has ended.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- asynchronous to the application, as a session read is
export async function requireUser(): Promise<User> {
  return currentEvaluation('requireUser').user();
}

/**
 * The session's user, or `null` where the request has none. It reads the session as `requireUser`
 * does: a component that calls it renders for the request, whatever it answers — a page every
 * visitor shares is never rendered with it, `null` included.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- asynchronous to the application, as a session read is
export async function currentUser(): Promise<User | null> {
  return currentEvaluation('currentUser').optionalUser();
}

/**
 * A route middleware: `export default` of a `middleware.ts` under the application's app directory,
 * around every route under the directory it stands in. It is handed the request and the route's
 * params as the server resolved them, and `next`, which answers the route's response — the shared
 * artifact, or the page rendered for the request — once, and runs nothing below it if not called.
 * What it does before `next` the framework runs where the route's preconditions are checked
 * (rendering, writes, the event stream); what it does after `next`, to each response alone.
 */
export type RouteMiddleware<
  Params extends Readonly<Record<string, string>> = Readonly<Record<string, string>>,
> = (
  context: Readonly<{
    /** The request as it arrived. Reading what changes the response makes the route the request's. */
    request: Request;
    /**
     * The params of the route the server resolved, never what the client claims of one: each as
     * Next.js hands a page its params — the path's segment decoded and encoded again
     * (`caf%C3%A9`, `a%2Fb`) — before `next` and after it alike.
     */
    params: Readonly<Params>;
  }>,
  next: () => Promise<Response>,
) => Promise<Response>;

/**
 * Refuses the session what it asked for: the authority answers 403. Thrown as a component renders,
 * it renders nothing in the component's place — the page's root, the whole page — and thrown by a
 * server operation, it refuses the operation. Anything else a component throws is a fault, which
 * the page reads again rather than loses its access over.
 */
export function forbidden(message = 'Your current access does not allow this.'): never {
  throw new AuthorityError(message, { code: 'FORBIDDEN', status: HTTP_FORBIDDEN });
}
