import { env } from 'cloudflare:workers';
// Of a static import alone: a bundle of no code splitting inlines an `import()`, and names its own
// file of it, which a deployment's audit refuses as a module no runtime provides.
import { drizzle } from 'drizzle-orm/d1';

import { type DatabaseHost, hostOf, LOG } from '../authority/database-host.ts';
import type { AnyDatabase } from '../server/schema.ts';
import type { ReactiveDb, ReactiveDbOptions } from '../sql/db.ts';
import { ownInternals } from '../sql/follow-internals.ts';
import { hostedDb } from '../sql/followed.ts';
import { followDrizzle } from '../sql/index.ts';
import { boundD1 } from '../sql/sqlite/bound-d1.ts';
import { d1Hosted } from '../sql/sqlite/d1-host.ts';
import type { DrizzleD1Follow } from '../sql/sqlite/follow.ts';
import { ownChanges } from '../sql/sqlite/own-changes.ts';

/**
 * `./db` in a Worker (`workerd`), as an authority's Durable Object bundles it: the application's
 * D1, of the Worker's own bindings (`boundD1`), whose log the object makes as it starts and prunes
 * from its alarm. Nothing of Node's is in it — no server, no PGlite, no file — as a Worker has none
 * of them, and its bundle would hold each of them whole.
 */

/** What a Worker runs not, of a host of Node's: what runs before an authority starts. */
function notInAWorker(what: string): Promise<never> {
  return Promise.reject(
    new Error(
      `A Worker runs no ${what}: run it before the deploy, of a host of Node's (\`reactive dev\`, \`migrate\` of \`./db\`, \`wrangler d1 migrations apply\`).`,
    ),
  );
}

/**
 * The application's tables of its Drizzle `schema`, of SQLite's, to read and write with `orm`, and
 * `db` for the authority: the whole of the application's `@/db`, of the D1 the Worker is bound —
 * its one, or `options.binding`'s.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- a promise, as Node's `reactiveDb` answers one: a refusal is its rejection.
export async function reactiveDb<S extends Readonly<Record<string, unknown>>>(
  schema: S,
  options: ReactiveDbOptions = {},
): Promise<ReactiveDb<S>> {
  const { binding: name, ...followed } = options;
  const follow = followDrizzle(schema, followed) as unknown as
    | DrizzleD1Follow<S>
    | { readonly channel: string };
  if ('channel' in follow) {
    throw new TypeError(
      "A Worker holds no database of a schema of PostgreSQL's tables: `reactiveDb` of one opens a server or PGlite, of Node's. A Worker's is of SQLite's tables, its D1.",
    );
  }
  const d1 = follow;
  const binding = boundD1(env as unknown as Readonly<Record<string, unknown>>, name);
  const host: DatabaseHost = {
    ...d1Hosted(binding, d1, LOG.keptMs),
    alone: (work) => work(),
    close: () => Promise.resolve(),
    listen: () => Promise.resolve(),
    migrate: () => notInAWorker('migration'),
    seed: () => notInAWorker('seed'),
  };
  const db = hostedDb(d1, host, () => ownInternals(d1).storeOf(binding));
  // A write answers its own changes, not the rows the log's triggers wrote beside them.
  const orm = drizzle(d1.client(ownChanges(binding)) as never, { schema });
  return { db, orm } as unknown as ReactiveDb<S>;
}

/** What `./db`'s `migrate` is in a Worker: a refusal, as its migrations run before the deploy. */
export async function migrate(db: AnyDatabase, folder: string): Promise<void> {
  if (hostOf(db) === undefined) {
    throw new TypeError('migrate() takes the `db` of `reactiveDb`.');
  }
  await notInAWorker(`migration (${folder})`);
}
