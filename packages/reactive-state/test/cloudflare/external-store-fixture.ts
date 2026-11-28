import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { authorityObject } from '../../src/cloudflare/object.ts';
import { type ComponentProgram, PROTOCOL_VERSION } from '../../src/program.ts';
import { followDrizzle, followedDb } from '../../src/sql/index.ts';

/**
 * An application's D1-backed authority, with no site to deliver its changes to: a table of its
 * Drizzle schema in D1, `items`, followed as the store `remote`. Its object is given no store: the
 * follow brings its own, of the binding a function answers, which the object connects of its
 * environment as its constructor runs.
 */

/** The application's items, which the database holds as `external_items`. */
const items = sqliteTable('external_items', { id: text().primaryKey(), title: text() });

/** The D1 the follow reads through: an object's, as its constructor connects it. */
const externalConnection: { binding?: D1Database | undefined } = {};

export const externalFollow = followDrizzle({ items }, { store: 'remote' });
const externalOrm = drizzle(
  externalFollow.client(() => externalConnection.binding),
  { schema: { items } },
);

export const externalProgram: ComponentProgram = {
  buildId: 'b_external',
  component: 'components/external-record',
  evaluate: async (_props, $) => {
    const [item] = await externalOrm.select().from(items).where(eq(items.id, 'one'));
    return $.h('p', null, item?.title);
  },
  protocolVersion: PROTOCOL_VERSION,
  updaters: {},
  writable: [],
};

/** The application's object, which connects the follow of its environment before it starts. */
export class ExternalAuthority extends authorityObject({
  buildId: externalProgram.buildId,
  database: followedDb(externalFollow),
  programs: [externalProgram],
  sessions: 'asserted',
}) {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    externalConnection.binding = env.REACTIVE_D1;
    super(ctx, env);
  }
}
