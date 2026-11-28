import { authorityObject } from '../../src/cloudflare/object.ts';
import { type ComponentProgram, PROTOCOL_VERSION } from '../../src/program.ts';
import { database } from '../../src/server/schema.ts';

/** A component whose render throws, so that the object's `onError` is told of it. */
export const failingProgram: ComponentProgram = {
  buildId: 'b_reporting',
  component: 'components/failing',
  evaluate: () => {
    throw new Error('the render failed');
  },
  protocolVersion: PROTOCOL_VERSION,
  updaters: {},
  writable: [],
};

/** Where the hook notes what it was given: the Worker's D1, which the test reads. */
export const REPORT_TABLE = 'on_error_reports';

/** An object whose hook writes the kind of the event and a variable of its env to D1. */
export const ReportingAuthority = authorityObject(
  {
    buildId: failingProgram.buildId,
    database: database({}),
    programs: [failingProgram],
    sessions: 'asserted',
  },
  {
    onError: async (_error, event, bindings) => {
      const d1 = bindings['REACTIVE_D1'] as D1Database;
      await d1
        .prepare(`INSERT INTO ${REPORT_TABLE} (kind, site) VALUES (?, ?)`)
        .bind(event.kind, String(bindings.REACTIVE_SITE_URL))
        .run();
    },
  },
);
