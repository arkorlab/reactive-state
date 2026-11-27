import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { onTestFinished } from 'vitest';

import type { ExternalStore } from '../../src/authority/external.ts';
import { Engine } from '../../src/authority/node-engine.ts';
import { type ComponentProgram, PROTOCOL_VERSION } from '../../src/program.ts';
import type { AnyDatabase } from '../../src/server/schema.ts';
import { type DrizzleFollow, followDrizzle, followedDb } from '../../src/sql/index.ts';
import { followInternals, ownStore, readingThrough } from './follow-store.ts';
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
  /** The render itself: its tree, and the frame its fields' values are in. */
  readonly rendered: () => ReturnType<Engine['render']>;
  readonly session: string;
}

/**
 * What an engine of a test follows: a follow, and what the authority reads its log through in place
 * of the follow's own store, where the test gives it — a wrapped store, a faulty one, or one of
 * another connection — made anew as each authority starts.
 */
export interface Following {
  readonly follow: Opened<Readonly<Record<string, unknown>>>['follow'];
  readonly store?: (() => ExternalStore) | undefined;
}

/** What a test gives the component and the engine, of what they take but `evaluate`. */
export type ProgramOptions = Partial<Pick<ComponentProgram, 'updaters' | 'writable'>> & {
  /**
   * The database the engine is given, where it declares more than the followed tables: it reads
   * the follow's log through the follow's store (`databaseFor`).
   */
  readonly database?: AnyDatabase;
  readonly diagnosticsEveryMs?: number;
  readonly timeoutMs?: number;
};

/** The component's id, as a tree names it. */
export const COMPONENT = 'components/drizzle';

/**
 * A PGlite whose tables `ddl` makes — those of `schema`, which its Drizzle reads and writes — with
 * their change log, in `namespace` if given, and its Drizzle, through the client a render's
 * queries are followed by.
 */
export async function openedWith<S extends Readonly<Record<string, unknown>>>(
  schema: S,
  ddl: string,
  namespace?: string,
): Promise<Opened<S>> {
  // A schema of PostgreSQL's tables, which a type of no table yet says not.
  const follow = (
    namespace === undefined ? followDrizzle(schema) : followDrizzle(schema, { namespace })
  ) as DrizzleFollow<S>;
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

/**
 * The database an engine of `setup` is given: the follow's own (`followedDb`), which brings the
 * follow's store, or `declared`, of more tables than the follow's, which reads the follow's log
 * through that store as well — either through `setup.store` where the test gives one.
 */
export function databaseFor(setup: Following, declared?: AnyDatabase): AnyDatabase {
  const db = declared ?? followedDb(setup.follow);
  if (declared === undefined && setup.store === undefined) return db;
  const { follow, store = () => ownStore(follow) } = setup;
  return readingThrough(db, { [followInternals(follow).storeName]: store });
}

/** An engine of one component, whose render `evaluate` is, following `follow`'s tables. */
export async function engineOf(
  setup: Following,
  evaluate: ComponentProgram['evaluate'],
  operations: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {},
  options: ProgramOptions = {},
): Promise<Rendering> {
  const {
    database: declared,
    diagnosticsEveryMs,
    timeoutMs,
    updaters = {},
    writable = [],
  } = options;
  const component: ComponentProgram = {
    buildId: BUILD,
    component: COMPONENT,
    evaluate,
    protocolVersion: PROTOCOL_VERSION,
    updaters,
    writable,
  };
  const engine = new Engine({
    buildId: BUILD,
    database: databaseFor(setup, declared),
    externalPollMs: IDLE_POLL_MS,
    operations,
    programs: [component],
    ...(timeoutMs !== undefined && { timeoutMs }),
    ...(diagnosticsEveryMs !== undefined && { diagnosticsEveryMs }),
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
    rendered: async () => engine.render(session, root),
    session,
  };
}
