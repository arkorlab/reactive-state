import { d1Executor, d1Store } from '../../src/cloudflare/d1-store.ts';
import { authorityObject } from '../../src/cloudflare/object.ts';
import { type ComponentProgram, PROTOCOL_VERSION } from '../../src/program.ts';
import { database, table, text } from '../../src/server/schema.ts';

/** An application's D1-backed authority, with no site to deliver its changes to. */
export const externalDatabase = database({
  items: table({ title: text() }, { external: 'remote' }),
});
export const externalProgram: ComponentProgram = {
  buildId: 'b_external',
  component: 'components/external-record',
  evaluate: async (_props, $) => $.h('p', null, (await externalDatabase.items.get('one'))?.title),
  protocolVersion: PROTOCOL_VERSION,
  updaters: {},
  writable: [],
};

export const ExternalAuthority = authorityObject(
  {
    buildId: externalProgram.buildId,
    database: externalDatabase,
    programs: [externalProgram],
    sessions: 'asserted',
  },
  {
    stores: (bindings) => {
      return {
        remote: d1Store(d1Executor(bindings['REACTIVE_D1'] as D1Database), {
          items: { name: 'external_items' },
        }),
      };
    },
  },
);
