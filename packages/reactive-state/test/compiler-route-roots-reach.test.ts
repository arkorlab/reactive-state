import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { Modules } from '../src/compiler/modules.ts';
import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * What the roots each served page renders under route middleware are read through: what a module
 * of the application's reaches is read once a compile, however many pages reach it — the root
 * layout, around every page, among them.
 */

const MIDDLEWARE = `import { requireUser, type RouteMiddleware } from '@arkorlab/reactive-state/server';
export default (async (_context, next) => {
  await requireUser();
  return await next();
}) satisfies RouteMiddleware;
`;

const PLAIN = 'export default function Plain() {\n  return <p>plain</p>;\n}\n';

/** The module the fixture's root layout imports, which reaches nothing of the application's. */
const BUTTONS = 'fixture/session-buttons.tsx';

describe('the compiler, of what the pages under route middleware reach', () => {
  const { apps, compile } = compilerApplications();

  async function guarded(files: Readonly<Record<string, string>>): Promise<Application> {
    const app = await application({ 'app/boards/[projectId]/middleware.ts': MIDDLEWARE, ...files });
    apps.push(app);
    return app;
  }

  /** How many times one compile of `app` asks what an import of `BUTTONS` is. */
  function asked(app: Application): number {
    const targetOf = vi.spyOn(Modules.prototype, 'targetOf');
    try {
      const { refusals } = compile(app);

      expect(refusals).toStrictEqual([]);

      const buttons = path.join(app.src, BUTTONS);
      return targetOf.mock.calls.filter(([, importer]) => importer === buttons).length;
    } finally {
      targetOf.mockRestore();
    }
  }

  it('reads what the root layout’s imports reach once, however many pages it wraps', async () => {
    const fewer = await guarded({});
    const more = await guarded({ 'app/plain/page.tsx': PLAIN, 'app/other/page.tsx': PLAIN });

    const asks = asked(fewer);

    expect(asks).toBeGreaterThan(0);
    expect(asked(more)).toBe(asks);
  });
});
