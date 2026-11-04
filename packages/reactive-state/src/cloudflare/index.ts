/**
 * The authority on Cloudflare: a Durable Object over its own SQLite, which a Worker exports for what
 * an application's compile registered — its components' programs and the `'use server'` modules
 * they import — and its database (`authorityObject`), and an application's server reaches over its
 * binding by one name (`AUTHORITY_OBJECT_NAME`). It runs in workerd with `nodejs_compat`, for
 * `node:crypto` and the `node:async_hooks` the application's code reads the authority through.
 */
export { AUTHORITY_OBJECT_NAME } from '../client/contract.ts';
export type { PublicPage } from '../delivery/site.ts';
export {
  type AuthorityApplication,
  type AuthorityObject,
  authorityObject,
  type AuthorityObjectClass,
  type AuthorityObjectOptions,
  type AuthorityStats,
} from './object.ts';
export type { AuthorityEnv } from './env.ts';
export {
  changeCaptureSql,
  d1Executor,
  type D1Executor,
  d1Store,
  type D1Table,
  type D1Tables,
  pruneChanges,
} from './d1-store.ts';
export type {
  ExternalChange,
  ExternalChanges,
  ExternalQuery,
  ExternalRecord,
  ExternalStore,
  ExternalStores,
  ExternalTable,
} from '../authority/external.ts';
