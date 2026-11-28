import { asc } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { type DatabaseHost, hostDatabase, hostOf } from '../../src/authority/database-host.ts';
import { reactiveDb } from '../../src/cloudflare/db.ts';
import type { AuthorityEnv } from '../../src/cloudflare/env.ts';
import { authorityObject } from '../../src/cloudflare/object.ts';
import { type ComponentProgram, PROTOCOL_VERSION } from '../../src/program.ts';

/**
 * An application of one call (`reactiveDb`), whose object is the compile's
 * (`.reactive/durable-object.mjs`): `authorityObject` of the application alone. Its D1 is the
 * Worker's one (`REACTIVE_D1`), which `reactiveDb` finds itself, and whose log the object makes as
 * it starts. The application's migration of its table is its own, which a test runs first.
 */

export const zcTasks = sqliteTable('zc_tasks', {
  id: text().primaryKey(),
  title: text().notNull(),
});
export const { db: zcDatabase, orm: zcOrm } = await reactiveDb({ zcTasks });

/** The application's migration of its table, which the object reads and does not run. */
export const ZC_MIGRATION =
  'CREATE TABLE zc_tasks (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL)';

export const zcProgram: ComponentProgram = {
  buildId: 'b_zero_config',
  component: 'components/zc-tasks',
  evaluate: async (_props, $) => {
    const rows = await zcOrm.select().from(zcTasks).orderBy(asc(zcTasks.id));
    return $.h('p', null, rows.map((row) => row.title).join(', '));
  },
  protocolVersion: PROTOCOL_VERSION,
  updaters: {},
  writable: [],
};

export const ZeroConfigAuthority = authorityObject({
  buildId: zcProgram.buildId,
  database: zcDatabase,
  programs: [zcProgram],
  sessions: 'asserted',
});

/** How long the log of the slow start's database takes to make. */
const SLOW_OPEN_MS = 300;
/** Whether the slow start's log was made, by its host's own word: before a first call answered? */
export const slowStart = { made: false };

/**
 * `milliseconds` later, of no built-in of Node's: the suite's object bundles none beside its own
 * (`durable-object-bundle.test.ts`).
 */
async function later(milliseconds: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/** A database of `zcTasks` of its own, hosted as its own host but for `open`. */
async function rehosted(open: (host: DatabaseHost) => Promise<void>): Promise<typeof zcDatabase> {
  const { db } = await reactiveDb({ zcTasks });
  const host = hostOf(db);
  if (host === undefined) throw new Error('The database brings no host.');
  hostDatabase(db, { ...host, open: async () => open(host) });
  return db;
}

const slowDatabase = await rehosted(async (host) => {
  await later(SLOW_OPEN_MS);
  await host.open();
  slowStart.made = true;
});
/** A making of the log that never ends. */
async function never(): Promise<void> {
  await new Promise<void>(() => {
    // Never settled.
  });
}

/**
 * What the hung start's database does of the making of its log: never answers it (`hang`), as a D1
 * held behind a deploy's long migration would not; refuses it (`fail`); or makes it. A test lets one
 * be made, and counts the makings.
 */
export const hung: { mode: 'fail' | 'hang' | 'make'; made: number } = { made: 0, mode: 'hang' };

const hungDatabase = await rehosted(async (host) => {
  hung.made += 1;
  if (hung.mode === 'hang') {
    await never();
  } else if (hung.mode === 'fail') {
    throw new Error('The database refused the log.');
  }
  await host.open();
});

/** The application of one call, of a log that takes a while to make. */
export const SlowStartAuthority = authorityObject({
  buildId: zcProgram.buildId,
  database: slowDatabase,
  programs: [zcProgram],
  sessions: 'asserted',
});

/** The application of one call, of a log whose making never ends. */
export const HungStartAuthority = authorityObject({
  buildId: zcProgram.buildId,
  database: hungDatabase,
  programs: [zcProgram],
  sessions: 'asserted',
});

/** Whether the storage of an object `ArmFailsAuthority` makes fails to arm an alarm. */
export const armFails = { on: false };

/**
 * Makes the storage of `ctx` fail to arm an alarm while `armFails.on` is set: what the object does
 * as it starts, where it arms the alarm of its first prune, cannot be made to fail from outside.
 */
function failingToArm(ctx: DurableObjectState): DurableObjectState {
  const { storage } = ctx;
  const arm = storage.setAlarm.bind(storage);
  storage.setAlarm = async (...args: Parameters<typeof arm>) => {
    if (armFails.on) throw new Error('storage');
    return arm(...args);
  };
  return ctx;
}

/** The application of one call, whose object's storage fails to arm its first alarm as it starts. */
export class ArmFailsAuthority extends authorityObject({
  buildId: zcProgram.buildId,
  database: zcDatabase,
  programs: [zcProgram],
  sessions: 'asserted',
}) {
  constructor(ctx: DurableObjectState, env: AuthorityEnv) {
    super(failingToArm(ctx), env);
  }
}
