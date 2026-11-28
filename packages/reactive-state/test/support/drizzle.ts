import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { onTestFinished } from 'vitest';

import { Engine } from '../../src/authority/node-engine.ts';
import { type ComponentProgram, PROTOCOL_VERSION } from '../../src/program.ts';
import { database } from '../../src/server/schema.ts';
import { type DrizzleFollow, followDrizzle } from '../../src/sql/index.ts';
import { textOf } from './frames.ts';

/**
 * An application's tables in a PGlite of its own, followed by an engine of one component: what the
 * tests of `./drizzle` render, write and read the change log of.
 */

const BUILD = 'b_drizzle';
/** Long enough that only `poke()` reads the log in a test. */
const IDLE_POLL_MS = 60_000;

/** A PGlite of the application's tables, what follows them, and its Drizzle. */
export interface Opened<S extends Readonly<Record<string, unknown>>> {
  readonly follow: DrizzleFollow<S>;
  readonly orm: PgliteDatabase<S> & { readonly $client: PGlite };
  readonly pg: PGlite;
}

/** An engine of one component: renders of it as text, and operations of one session. */
export interface Rendering {
  readonly engine: Engine;
  readonly operate: (module: string, name: string) => ReturnType<Engine['operate']>;
  readonly render: () => Promise<string>;
}

/**
 * A PGlite whose tables `ddl` makes — those of `schema`, which its Drizzle reads and writes — with
 * their change log, and its Drizzle, through the client a render's queries are followed by.
 */
export async function openedWith<S extends Readonly<Record<string, unknown>>>(
  schema: S,
  ddl: string,
): Promise<Opened<S>> {
  // A schema of PostgreSQL's tables, which a type of no table yet says not.
  const follow = followDrizzle(schema) as DrizzleFollow<S>;
  const pg = await PGlite.create();
  onTestFinished(async () => {
    await pg.close();
  });
  await pg.exec(ddl);
  for (const statement of follow.captureSql()) {
    await pg.query(statement);
  }
  const client = follow.client(pg);
  const orm = drizzle({ client, schema });
  return { follow, orm, pg };
}

/** An engine of one component, whose render `evaluate` is, following `follow`'s tables. */
export async function engineOf(
  setup: Pick<Opened<Readonly<Record<string, unknown>>>, 'follow' | 'pg'>,
  evaluate: ComponentProgram['evaluate'],
  operations: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {},
): Promise<Rendering> {
  const component: ComponentProgram = {
    buildId: BUILD,
    component: 'components/drizzle',
    evaluate,
    protocolVersion: PROTOCOL_VERSION,
    updaters: {},
    writable: [],
  };
  const engine = new Engine({
    buildId: BUILD,
    database: database(setup.follow.tables),
    externalPollMs: IDLE_POLL_MS,
    operations,
    programs: [component],
    stores: { [setup.follow.storeName]: setup.follow.store(setup.pg) },
  });
  onTestFinished(async () => {
    await engine.close();
  });
  await engine.poke();
  const session = (await engine.login('alice')).sessionId;
  const root = { build: BUILD, component: component.component, props: {} };
  return {
    engine,
    operate: async (module: string, name: string) => {
      return engine.operate(session, {
        args: [],
        build: BUILD,
        module,
        name,
        operationId: crypto.randomUUID(),
      });
    },
    render: async () => textOf((await engine.render(session, root)).tree),
  };
}
