import { fileURLToPath } from 'node:url';

import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

/** The application the suites' programs import through `@/` (`test/cloudflare/tsconfig.json`). */
const APPLICATION = fileURLToPath(new URL('test/support/app/', import.meta.url));

/**
 * The newest compatibility date the workerd bundled with the installed Miniflare accepts; nothing
 * the authority relies on changed since.
 */
const TEST_COMPATIBILITY_DATE = '2026-09-11';

/**
 * The authority as a Durable Object, run inside workerd: the suites' Worker exports it for the test
 * application's programs (`test/cloudflare/worker.ts`), and reach it through its binding as an
 * application's server does. `nodejs_compat` is the engine's `node:crypto` and the scope's
 * `node:async_hooks`, as on Cloudflare. The site the change log goes to is a stand-in each suite
 * answers for, through a stubbed `fetch`.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './test/cloudflare/worker.ts',
      miniflare: {
        compatibilityDate: TEST_COMPATIBILITY_DATE,
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: {
          // eslint-disable-next-line unicorn/no-keyword-prefix -- Miniflare's option name.
          AUTHORITY: { className: 'TestAuthority', useSQLite: true },
          // The same application with no view shared (`test/cloudflare/worker.ts`).
          // eslint-disable-next-line unicorn/no-keyword-prefix -- Miniflare's option name.
          UNSHARED: { className: 'UnsharedAuthority', useSQLite: true },
          // The same application signing its users in itself (`test/cloudflare/worker.ts`).
          // eslint-disable-next-line unicorn/no-keyword-prefix -- Miniflare's option name.
          ASSERTED: { className: 'AssertedAuthority', useSQLite: true },
          // The same host reading a database the application owns.
          // eslint-disable-next-line unicorn/no-keyword-prefix -- Miniflare's option name.
          EXTERNAL_AUTHORITY: { className: 'ExternalAuthority', useSQLite: true },
          // The application whose states bind rows of its tables in D1.
          // eslint-disable-next-line unicorn/no-keyword-prefix -- Miniflare's option name.
          D1_ROWS_AUTHORITY: { className: 'RowsAuthority', useSQLite: true },
          // The test application, of an object that knows no site (`test/cloudflare/worker.ts`).
          // eslint-disable-next-line unicorn/no-keyword-prefix -- Miniflare's option name.
          SITELESS: { className: 'SitelessAuthority', useSQLite: true },
          // An application of one call, as the compile's own module makes its object.
          // eslint-disable-next-line unicorn/no-keyword-prefix -- Miniflare's option name.
          ZERO_CONFIG: { className: 'ZeroConfigAuthority', useSQLite: true },
          // The same, with a server operation that awaits.
          // eslint-disable-next-line unicorn/no-keyword-prefix -- Miniflare's option name.
          APART: { className: 'ApartAuthority', useSQLite: true },
          // The same, of a log that takes a while to make, and of one whose making never ends.
          // eslint-disable-next-line unicorn/no-keyword-prefix -- Miniflare's option name.
          SLOW_START: { className: 'SlowStartAuthority', useSQLite: true },
          // eslint-disable-next-line unicorn/no-keyword-prefix -- Miniflare's option name.
          HUNG_START: { className: 'HungStartAuthority', useSQLite: true },
          // An application whose render fails, and an `onError` that notes the env it is given.
          // eslint-disable-next-line unicorn/no-keyword-prefix -- Miniflare's option name.
          REPORTING: { className: 'ReportingAuthority', useSQLite: true },
        },
        d1Databases: ['REACTIVE_D1'],
        bindings: {
          REACTIVE_ACCESS_BYPASS: 'test-access-bypass',
          REACTIVE_ACCESS_BYPASS_HEADER: 'x-test-access-bypass',
          REACTIVE_ENGINE_TOKEN: 'test-engine-token',
          REACTIVE_SITE_URL: 'https://site.test',
        },
      },
    }),
  ],
  resolve: { alias: [{ find: /^@\//u, replacement: APPLICATION }] },
  test: { name: 'reactive-state-workers', include: ['test/cloudflare/**/*.test.ts'] },
});
