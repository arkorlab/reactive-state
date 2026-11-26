import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { openTypeScript } from '../src/compiler/index.ts';
import { PAGE_EXTENSIONS } from '../src/compiler/page-extensions.ts';
import { scanApp } from '../src/compiler/route-scan.ts';
import { application, compiledApp, refusalOf, removed } from './fixtures/application.ts';

/** Turbopack emits and serves numbered metadata routes beyond the JavaScript helper's one digit. */
const PACKAGE = fileURLToPath(new URL('../', import.meta.url));
const NAMES = ['apple-icon', 'icon', 'opengraph-image', 'twitter-image'];
const IMAGE = "export default function Image() { return new Response('image'); }";
const GUARD = [
  "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
  "import { requireUser } from '@/auth';",
  'export default (async (_context, next) => {',
  '  await requireUser();',
  '  return await next();',
  '}) satisfies RouteMiddleware;',
].join('\n');

describe('the metadata image files Next.js serves as routes', () => {
  it.each(NAMES)('scans numeric suffixes of any length for %s', (name) => {
    const root = mkdtempSync(path.join(PACKAGE, '.reactive-state-metadata-'));
    const appDir = path.join(root, 'app');
    const directory = path.join(appDir, 'account');
    mkdirSync(directory, { recursive: true });
    const expected: string[] = [];
    try {
      for (const extension of PAGE_EXTENSIONS) {
        for (const suffix of ['', '1', '9', '10', '12', '123', '12x']) {
          const file = `${name}${suffix}.${extension}`;
          writeFileSync(path.join(directory, file), IMAGE);
          if (suffix !== '12x') {
            expected.push(path.join(directory, file));
          }
        }
      }
      const scanned = scanApp(appDir, path.join(root, '.reactive')).metadata;

      expect(new Set(scanned.map((file) => file.file))).toStrictEqual(new Set(expected));
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it.each(NAMES)('refuses a multi-digit %s route under a guard', async (name) => {
    const file = `app/account/${name}12.tsx`;
    const app = await application({ 'app/account/middleware.ts': GUARD, [file]: IMAGE });
    try {
      using api = openTypeScript();
      const refusal = refusalOf(compiledApp(app, api));

      expect(refusal.fileName).toBe(file);
      expect(refusal.reason).toContain(
        `\`${file}\` is a metadata file written as code under the guard of \`app/account/middleware.ts\``,
      );
    } finally {
      await removed(app);
    }
  });
});
