import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { compileProject, type ProjectOptions } from '../src/next/compile-on-build.ts';

/**
 * A compile a build skips for what it read must still see what is added where it reads: a
 * components' directory or an app directory that is not under the application's root, as a
 * monorepo's shared `components` is not. A file added to one is no change of the root's, and no file
 * the earlier compile read, so it is the digest of the compile's inputs that has to hold it.
 */

const PAGE = 'export default function Page() {\n  return <p>page</p>;\n}\n';
const MIDDLEWARE = [
  "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
  '',
  'export default ((_context, next) => next()) satisfies RouteMiddleware;',
  '',
].join('\n');
const TSCONFIG = JSON.stringify({
  compilerOptions: { jsx: 'react-jsx', paths: { '@/*': ['./src/*'] } },
});

const workspaces: string[] = [];

/** A component of the name `name`, which renders nothing but it. */
function component(name: string): string {
  return `export default function ${name}() {\n  return <p>${name}</p>;\n}\n`;
}

/** `text` at `file`, its folders made. */
function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A workspace: its application, `project`, and a folder beside it, `shared`, of the repository's. */
function workspace(): { readonly project: string; readonly shared: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'reactive-state-external-'));
  workspaces.push(root);
  const project = path.join(root, 'project');
  write(path.join(project, 'tsconfig.json'), TSCONFIG);
  write(path.join(project, 'package.json'), JSON.stringify({ name: 'project', private: true }));
  return { project, shared: path.join(root, 'shared') };
}

/** The ids of the route middleware the manifest of `project`'s compile lists. */
function middlewareOf(project: string): readonly string[] {
  const manifest = JSON.parse(
    readFileSync(path.join(project, '.reactive/manifest.json'), 'utf8'),
  ) as { readonly middleware: readonly { readonly id: string }[] };
  return manifest.middleware.map((each) => each.id);
}

describe('a compile skipped for what it read', () => {
  /** What a row gives besides the application's root. */
  type Rest = Omit<ProjectOptions, 'projectDir'>;

  afterEach(() => {
    for (const root of workspaces.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it.each([
    {
      id: 'in the components’ directory under the root, as the control',
      options: (): Rest => ({}),
      src: (project: string) => path.join(project, 'src'),
    },
    {
      id: 'in a components’ directory outside the root, named by a path from it',
      options: (): Rest => ({ src: '../shared/components' }),
      src: (project: string) => path.join(project, '../shared/components'),
    },
    {
      id: 'in a components’ directory outside the root, named by its absolute path',
      options: (shared: string): Rest => ({ src: path.join(shared, 'components') }),
      src: (project: string) => path.join(project, '../shared/components'),
    },
    {
      id: 'in a components’ directory under a folder of the root no source is read from',
      options: (): Rest => ({ src: '.state/components' }),
      src: (project: string) => path.join(project, '.state/components'),
    },
  ])('compiles a component added $id', async ({ options, src }) => {
    const { project, shared } = workspace();
    const given: ProjectOptions = { ...options(shared), projectDir: project };
    write(path.join(src(project), 'hello.reactive.tsx'), component('Hello'));
    await compileProject(given);

    write(path.join(src(project), 'world.reactive.tsx'), component('World'));
    const added = await compileProject(given);

    expect(added).toMatchObject({ changed: true, compiled: true });
    expect(existsSync(path.join(project, '.reactive/world.authority.mts'))).toBe(true);
    expect(existsSync(path.join(project, '.reactive/world.root.tsx'))).toBe(true);
  });

  it.each([
    {
      id: 'under the root, as the control',
      app: undefined,
      pages: (project: string) => path.join(project, 'app'),
    },
    {
      id: 'outside the root',
      app: '../shared/app',
      pages: (project: string) => path.join(project, '../shared/app'),
    },
  ])(
    'compiles a route and its middleware added to an app directory $id',
    async ({ app, pages }) => {
      const { project } = workspace();
      const given: ProjectOptions = { projectDir: project, ...(app !== undefined && { app }) };
      write(path.join(project, 'src/hello.reactive.tsx'), component('Hello'));
      write(path.join(pages(project), 'page.tsx'), PAGE);
      await compileProject(given);

      write(path.join(pages(project), 'about/page.tsx'), PAGE);
      write(path.join(pages(project), 'about/middleware.ts'), MIDDLEWARE);
      const added = await compileProject(given);

      expect(added).toMatchObject({ compiled: true });
      expect(middlewareOf(project)).toStrictEqual(['about']);
    },
  );

  it('compiles a component added to a components’ directory that holds the app directory too', async () => {
    const { project, shared } = workspace();
    const given: ProjectOptions = { app: '../shared/app', projectDir: project, src: '../shared' };
    write(path.join(shared, 'hello.reactive.tsx'), component('Hello'));
    write(path.join(shared, 'app/page.tsx'), PAGE);
    await compileProject(given);

    write(path.join(shared, 'world.reactive.tsx'), component('World'));
    const added = await compileProject(given);

    expect(added).toMatchObject({ compiled: true });
    expect(existsSync(path.join(project, '.reactive/world.authority.mts'))).toBe(true);
  });

  it('skips the compile while nothing changed in a directory outside the root, and for a file that is no source', async () => {
    const { project, shared } = workspace();
    const given: ProjectOptions = { projectDir: project, src: '../shared/components' };
    write(path.join(shared, 'components/hello.reactive.tsx'), component('Hello'));
    const first = await compileProject(given);

    const again = await compileProject(given);
    write(path.join(shared, 'components/README.md'), '# Components\n');
    write(path.join(shared, 'components/node_modules/pkg/index.ts'), 'export const x = 1;\n');
    const noted = await compileProject(given);

    expect(first).toMatchObject({ compiled: true });
    expect(again).toMatchObject({ changed: false, compiled: false });
    expect(noted).toMatchObject({ changed: false, compiled: false });
  });
});
