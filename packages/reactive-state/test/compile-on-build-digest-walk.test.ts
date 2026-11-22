import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { compileProject } from '../src/next/compile-on-build.ts';

/**
 * A compile a build skips for what it read must still see a file added where one of its own walks
 * reads: the walk of the app directory's routes, of the Pages Router's beside it, and of the
 * components. The walk of the compile's inputs leaves some folders out by their names wherever they
 * stand in the application — its packages, its history, what a build or a tool writes — and the
 * walk of the routes leaves none of those out: a page added under one of them was in no digest and
 * in no record of the compile before, the build after it was skipped, and where route middleware is
 * around the new route it was served without it. Inside a tree a walk of the compile's reads whole,
 * the inputs' walk leaves no folder out by its name; outside those trees it leaves them out as
 * before, the packages at the application's root among them.
 */

const PAGE = 'export default function Page() {\n  return <p>page</p>;\n}\n';
const MIDDLEWARE = [
  'export default async function middleware(context: unknown, next: () => Promise<Response>) {',
  '  return next();',
  '}',
  '',
].join('\n');
const HANDLER = 'export default function handler() {}\n';
/**
 * A page of a route of one param, which the component is given: one view for every visitor. In
 * `shared/app/greet/[name]`, beside the application `project` whose component it renders.
 */
const GREETING_PAGE = [
  "import Hello from '../../../../project/src/components/hello.reactive';",
  '',
  'export default async function Page({ params }: { params: Promise<{ name: string }> }) {',
  '  const { name } = await params;',
  '  return <Hello name={name} />;',
  '}',
  '',
].join('\n');
const GREETING = [
  'export default function Hello({ name }: { readonly name: string }) {',
  '  return <p>Hello, {name}</p>;',
  '}',
  '',
].join('\n');
const MODULE = 'export const value = 1;\n';

/** A component of the name `name`, which renders nothing but it. */
function component(name: string): string {
  return `export default function ${name}() {\n  return <p>${name}</p>;\n}\n`;
}

/**
 * Folders the walk of the compile's inputs leaves out by name, wherever they stand outside the
 * trees the compile's own walks read: the packages', and those of a leading dot that a version
 * control, a build, a deployment or a tool writes.
 */
const NAMES = [
  'node_modules',
  '.git',
  '.next',
  '.pnpm-store',
  '.state',
  '.turbo',
  '.variants',
  '.vercel',
  '.wrangler',
  '.yarn',
] as const;

const projects: string[] = [];

/** Writes each of `files`, by its path from `directory`. */
function put(directory: string, files: Readonly<Record<string, string>>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), text);
  }
}

/** An application of one component and one page, route middleware around every route of it. */
function application(files: Readonly<Record<string, string>> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'reactive-state-digest-walk-'));
  projects.push(dir);
  put(dir, {
    'src/app/middleware.ts': MIDDLEWARE,
    'src/app/page.tsx': PAGE,
    'src/components/hello.reactive.tsx': component('Hello'),
    'tsconfig.json': JSON.stringify({
      compilerOptions: { jsx: 'react-jsx', paths: { '@/*': ['./src/*'] } },
    }),
    ...files,
  });
  return dir;
}

/** What the compile of `dir` wrote into its manifest. */
function manifestOf(dir: string): {
  readonly components: Readonly<Record<string, unknown>>;
  readonly routes: readonly { readonly route: string; readonly middleware: readonly string[] }[];
} {
  return JSON.parse(readFileSync(path.join(dir, '.reactive', 'manifest.json'), 'utf8')) as {
    readonly components: Readonly<Record<string, unknown>>;
    readonly routes: readonly { readonly route: string; readonly middleware: readonly string[] }[];
  };
}

/** The routes `dir`'s compile registered, each with the middleware around it. */
function routesOf(dir: string): readonly (readonly [string, readonly string[]])[] {
  return manifestOf(dir).routes.map(({ middleware, route }) => [route, middleware]);
}

/** An application whose pages are in a folder beside it, `shared/app`, and its root. */
function beside(): {
  readonly given: { app: string; projectDir: string };
  readonly shared: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'reactive-state-digest-walk-'));
  projects.push(root);
  const projectDir = path.join(root, 'project');
  put(projectDir, {
    'src/components/hello.reactive.tsx': GREETING,
    'tsconfig.json': JSON.stringify({
      compilerOptions: { jsx: 'react-jsx', paths: { '@/*': ['./src/*'] } },
    }),
  });
  put(root, { 'shared/app/greet/[name]/page.tsx': GREETING_PAGE });
  return { given: { app: '../shared/app', projectDir }, shared: path.join(root, 'shared') };
}

describe('a compile skipped for what it read, and the folders its inputs’ walk leaves out by name', () => {
  afterEach(() => {
    for (const dir of projects.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  describe('the app directory, which the walk of the routes reads whole but for private folders', () => {
    it.each(NAMES)('registers a page added under `app/%s`, under its middleware', async (name) => {
      const dir = application();
      await compileProject({ projectDir: dir });

      put(dir, { [`src/app/${name}/page.tsx`]: PAGE });
      const added = await compileProject({ projectDir: dir });

      expect(added).toMatchObject({ changed: true, compiled: true });
      expect(routesOf(dir)).toStrictEqual([
        ['/', ['']],
        [`/${name}`, ['']],
      ]);
      // Nothing changed since: the build after it is skipped.
      await expect(compileProject({ projectDir: dir })).resolves.toMatchObject({
        changed: false,
        compiled: false,
      });
    });

    it('compiles again where a middleware is added under one of those folders', async () => {
      const dir = application({ 'src/app/node_modules/inner/page.tsx': PAGE });
      await compileProject({ projectDir: dir });

      expect(routesOf(dir)).toStrictEqual([
        ['/', ['']],
        ['/node_modules/inner', ['']],
      ]);

      put(dir, { 'src/app/node_modules/middleware.ts': MIDDLEWARE });
      const guarded = await compileProject({ projectDir: dir });

      expect(guarded).toMatchObject({ compiled: true });
      expect(routesOf(dir)).toStrictEqual([
        ['/', ['']],
        ['/node_modules/inner', ['', 'node_modules']],
      ]);
    });

    it('registers no route of a page added to a private folder, as before', async () => {
      const dir = application();
      await compileProject({ projectDir: dir });

      put(dir, { 'src/app/_private/page.tsx': PAGE });
      await compileProject({ projectDir: dir });

      expect(routesOf(dir)).toStrictEqual([['/', ['']]]);
    });
  });

  describe('the Pages Router’s directory, which the walk of its routes reads whole', () => {
    it.each(NAMES)(
      'refuses a route added under `pages/api/reactive-state/%s`, which the compile’s own route would be served beside',
      async (name) => {
        const dir = application();
        await compileProject({ projectDir: dir });

        put(dir, { [`src/pages/api/reactive-state/${name}/handler.ts`]: HANDLER });

        await expect(compileProject({ projectDir: dir })).rejects.toThrow(
          `pages/api/reactive-state/${name}/handler.ts:1:1: A route of the application`,
        );
      },
    );
  });

  describe('the components’ directory, whose walk leaves those folders out itself', () => {
    it('compiles no component under one of them, so none added there is one to compile again for', async () => {
      const under = Object.fromEntries(
        NAMES.map((name) => [`src/${name}/extra.reactive.tsx`, component('Extra')] as const),
      );
      const dir = application({ ...under, 'src/.hidden/extra.reactive.tsx': component('Hidden') });
      await compileProject({ projectDir: dir });

      expect(Object.keys(manifestOf(dir).components)).toStrictEqual(['components/hello']);

      put(dir, { 'src/node_modules/package/more.reactive.tsx': component('More') });

      await expect(compileProject({ projectDir: dir })).resolves.toMatchObject({
        compiled: false,
      });
    });
  });

  describe('beside an app directory the walk of the application’s root does not read', () => {
    it('refuses a route of the Pages Router added beside it, where the compile’s own route is served', async () => {
      const { given, shared } = beside();
      await compileProject(given);

      put(shared, { 'pages/api/reactive-state/feed.ts': HANDLER });

      await expect(compileProject(given)).rejects.toThrow(
        'pages/api/reactive-state/feed.ts:1:1: A route of the application',
      );
    });

    it('compiles again once a proxy stands beside it, and shares no route from then on', async () => {
      const { given, shared } = beside();
      const isShared = (): unknown =>
        manifestOf(given.projectDir).routes.find(({ route }) => route === '/greet/[name]');
      await compileProject(given);

      expect(isShared()).toMatchObject({ shared: true });

      put(shared, { 'proxy.ts': 'export function proxy() {}\n' });
      const proxied = await compileProject(given);

      expect(proxied).toMatchObject({ changed: true, compiled: true });
      expect(isShared()).toMatchObject({ shared: false });
      await expect(compileProject(given)).resolves.toMatchObject({ compiled: false });
    });
  });

  describe('outside those trees', () => {
    it('leaves the packages, the history and a build’s folders at the application’s root out, as before', async () => {
      const dir = application();
      await compileProject({ projectDir: dir });

      put(
        dir,
        Object.fromEntries(NAMES.map((name) => [`${name}/package/index.ts`, MODULE] as const)),
      );
      put(dir, { 'src/components/node_modules/package/index.ts': MODULE });

      await expect(compileProject({ projectDir: dir })).resolves.toMatchObject({
        changed: false,
        compiled: false,
      });
    });

    it('leaves what is in the output directory out, where it is inside the app directory too', async () => {
      const dir = application();
      const given = { out: 'src/app/generated', projectDir: dir };
      await compileProject(given);

      put(dir, { 'src/app/generated/node_modules/package/index.ts': MODULE });
      put(dir, { 'src/app/generated/notes.ts': MODULE });

      await expect(compileProject(given)).resolves.toMatchObject({
        changed: false,
        compiled: false,
      });
    });
  });
});
