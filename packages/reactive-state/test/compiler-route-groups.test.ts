import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { openTypeScript } from '../src/compiler/index.ts';
import { matchedRouteOf, scanApp, unplacedSegment } from '../src/compiler/route-scan.ts';
import { application, compiledApp, output, removed } from './fixtures/application.ts';

/** Complete parenthesized segments are route groups even where an interception marker opens them. */
const PACKAGE = fileURLToPath(new URL('../', import.meta.url));
const GROUPS = ['(.)', '(.)foo)'];
const PAGE = 'export default function Page() { return <p>Account</p>; }';
const HANDLER = 'export function GET() { return new Response("Account"); }';
const GUARD = [
  "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
  "import { requireUser } from '@/auth';",
  'export default (async (_context, next) => {',
  '  await requireUser();',
  '  return await next();',
  '}) satisfies RouteMiddleware;',
].join('\n');

describe('route groups beginning with interception markers', () => {
  it.each(GROUPS)('scans %s as a group without recording an interception', (group) => {
    const root = mkdtempSync(path.join(PACKAGE, '.reactive-state-groups-'));
    const appDir = path.join(root, 'app');
    const directory = `${group}/account/[tenant]`;
    mkdirSync(path.join(appDir, directory, 'api'), { recursive: true });
    writeFileSync(path.join(appDir, directory, 'page.tsx'), PAGE);
    writeFileSync(path.join(appDir, directory, 'api/route.ts'), HANDLER);
    try {
      const scanned = scanApp(appDir, path.join(root, '.reactive'));

      expect(scanned.pages[0]?.route).toStrictEqual({
        params: ['tenant'],
        route: '/account/[tenant]',
      });
      expect(scanned.handlers[0]?.served).toStrictEqual({
        params: ['tenant'],
        route: '/account/[tenant]/api',
      });
      expect(scanned.intercepted.size).toBe(0);
      expect(matchedRouteOf(directory)).toBe('/account/[tenant]');
      expect(unplacedSegment(directory)).toBeUndefined();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it.each(['(.)', '(.)foo)'])('registers guarded plain routes below %s', async (group) => {
    const app = await application({
      [`app/${group}/account/middleware.ts`]: GUARD,
      [`app/${group}/account/page.tsx`]: PAGE,
      [`app/${group}/account/api/route.ts`]: HANDLER,
    });
    try {
      using api = openTypeScript();
      const compiled = compiledApp(app, api);
      const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
        readonly routes: readonly {
          readonly route: string;
          readonly middleware: readonly string[];
        }[];
      };

      expect(compiled.refusals).toStrictEqual([]);
      expect(manifest.routes).toContainEqual(
        expect.objectContaining({ route: '/account', middleware: [`${group}/account`] }),
      );
      expect(manifest.routes).toContainEqual(
        expect.objectContaining({ route: '/account/api', middleware: [`${group}/account`] }),
      );
    } finally {
      await removed(app);
    }
  });
});
