import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { openTypeScript } from '../src/compiler/index.ts';
import type { RouteRegistration } from '../src/routing.ts';
import { application, compiledApp, removed, source } from './fixtures/application.ts';

/** The declarations a page exports beside its root, erased types or code that runs. */
const BOARD = 'app/boards/[projectId]/page.tsx';
const TYPES = 'export type PageTypes = { title: string };';

async function boardWith(
  declaration: string,
  types = TYPES,
): Promise<RouteRegistration | undefined> {
  const app = await application({
    [BOARD]: `${await source(BOARD)}\n${declaration}\n`,
    'page-types.ts': types,
  });
  try {
    using api = openTypeScript();
    const compiled = compiledApp(app, api);

    expect(compiled.refusals).toStrictEqual([]);

    const manifest = JSON.parse(
      compiled.outputs.get(path.join(app.out, 'manifest.json')) ?? '{}',
    ) as {
      readonly routes?: readonly RouteRegistration[];
    };
    return manifest.routes?.find((route) => route.route === '/boards/[projectId]');
  } finally {
    await removed(app);
  }
}

describe('the exports beside a route’s root', () => {
  it.each([
    "export type { PageTypes } from '@/page-types';",
    "export type { PageTypes as Props } from '@/page-types';",
    "export type * from '@/page-types';",
    "export type * as Types from '@/page-types';",
    "export { type PageTypes } from '@/page-types';",
    'type Props = { title: string }; export type { Props };',
    'type Props = { title: string }; export { type Props };',
  ])('shares a page whose only extra declaration exports erased types: %s', async (declaration) => {
    await expect(boardWith(declaration)).resolves.toMatchObject({ shared: true });
  });

  it.each([
    "export { title } from '@/page-types';",
    "export * from '@/page-types';",
    "export * as Types from '@/page-types';",
    "export { type PageTypes, title } from '@/page-types';",
  ])('keeps a value export private: %s', async (declaration) => {
    await expect(
      boardWith(declaration, `${TYPES} export const title = 'Board';`),
    ).resolves.toMatchObject({
      shared: false,
    });
  });

  it('keeps the side effects of a module an inline type export still loads private', async () => {
    await expect(
      boardWith("export { type PageTypes } from '@/page-types';", `${TYPES} Date.now();`),
    ).resolves.toMatchObject({ shared: false });
  });
});
