import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { compileProject } from '../src/next/compile-on-build.ts';

/**
 * A type-only import runs nothing, so the compile never resolves it as a module; the checker
 * resolves it itself, to read the declared type behind it. A cached compile therefore has to keep
 * which file the checker was given for it, as much as that file's text: a file added that
 * TypeScript takes in the one's place moves the choice with no recorded text changed.
 */
const roots: string[] = [];
const SAFE = 'export type Item = { title: string; stack?: string };\n';
const ERROR = 'export type Item = Error;\n';
const GREETING = 'export const GREETING = "Hello";\n';

function write(root: string, file: string, text: string): void {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text);
}

/** `label` reads `.stack` of what `Item` declares, so the route is shared only where it is no Error. */
const LABEL = [
  "import type { Item } from '@shared/item';",
  "function entries(name: string): [string, Item][] { return [[name, { title: name, stack: 'fixed' }]]; }",
  'export function label(name: string): string {',
  '  return new Map<string, Item>(entries(name)).get(name)?.stack ?? name;',
  '}',
].join('\n');

/**
 * An application whose `label` module imports `Item` as a type alone, through an alias that leads
 * outside the application's root. `files` are the files beside the application, from the root.
 */
function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'reactive-type-only-'));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) write(root, file, text);
  write(root, 'shared/greeting.ts', GREETING);
  write(
    root,
    'app/tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        jsx: 'react-jsx',
        paths: { '@/*': ['./src/*'], '@shared/*': ['../shared/*'] },
      },
    }),
  );
  write(root, 'app/src/domain/label.ts', LABEL);
  write(
    root,
    'app/src/components/hello.reactive.tsx',
    [
      'import { GREETING } from "@shared/greeting";',
      'import { label } from "@/domain/label";',
      'export default function Hello({ name }: { readonly name: string }) {',
      '  return <p>{GREETING}, {label(name)}</p>;',
      '}',
    ].join('\n'),
  );
  write(
    root,
    'app/src/app/[name]/page.tsx',
    [
      'import Hello from "@/components/hello.reactive";',
      'export default async function Page({ params }: { params: Promise<{ name: string }> }) {',
      '  const { name } = await params;',
      '  return <Hello name={name} />;',
      '}',
    ].join('\n'),
  );
  return root;
}

interface RouteAdmission {
  readonly shared: boolean;
}

function admission(app: string): RouteAdmission | undefined {
  const manifest = JSON.parse(readFileSync(path.join(app, '.reactive/manifest.json'), 'utf8')) as {
    readonly routes: readonly RouteAdmission[];
  };
  return manifest.routes[0];
}

/** The application `root` holds, compiled, and compiled again to show nothing is left to do. */
async function initial(root: string): Promise<string> {
  const app = path.join(root, 'app');

  await expect(compileProject({ projectDir: app })).resolves.toMatchObject({ compiled: true });
  await expect(compileProject({ projectDir: app })).resolves.toMatchObject({ compiled: false });

  return app;
}

/** The compile after a change: it must run, and its manifest is the admission now. */
async function recompiled(app: string): Promise<RouteAdmission | undefined> {
  await expect(compileProject({ projectDir: app })).resolves.toMatchObject({ compiled: true });

  return admission(app);
}

describe('type-only imports in a cached compile', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('recompiles when a higher priority file takes the place of the selected declaration', async () => {
    const root = project({ 'shared/item.tsx': SAFE });
    const app = await initial(root);

    expect(admission(app)).toMatchObject({ shared: true });

    write(root, 'shared/item.ts', ERROR);

    await expect(recompiled(app)).resolves.toMatchObject({ shared: false });
    expect(readFileSync(path.join(root, 'shared/item.tsx'), 'utf8')).toBe(SAFE);
  });

  it('recompiles when a file is added at an import the checker could not resolve', async () => {
    const root = project({});
    const app = await initial(root);

    expect(admission(app)).toMatchObject({ shared: false });

    write(root, 'shared/item.ts', SAFE);

    await expect(recompiled(app)).resolves.toMatchObject({ shared: true });
  });

  it('recompiles when a type read through another declaration is taken from another file', async () => {
    const root = project({
      'shared/item.ts': "import type { Base } from './base';\nexport type Item = Base;\n",
      'shared/base.tsx': SAFE.replace('Item', 'Base'),
    });
    const app = await initial(root);

    expect(admission(app)).toMatchObject({ shared: true });

    write(root, 'shared/base.ts', ERROR.replace('Item', 'Base'));

    await expect(recompiled(app)).resolves.toMatchObject({ shared: false });
  });

  it('recompiles when the file a type-only export of a declaration names is shadowed', async () => {
    const root = project({
      'shared/item.ts': "export type { Item } from './base';\n",
      'shared/base.tsx': SAFE,
    });
    const app = await initial(root);
    write(root, 'shared/base.ts', ERROR);

    await expect(recompiled(app)).resolves.toMatchObject({ shared: false });
  });

  it("recompiles when the file a type's import('…') names is shadowed", async () => {
    const root = project({
      'shared/item.ts': "export type Item = import('./base').Base;\n",
      'shared/base.tsx': SAFE.replace('Item', 'Base'),
    });
    const app = await initial(root);
    write(root, 'shared/base.ts', ERROR.replace('Item', 'Base'));

    await expect(recompiled(app)).resolves.toMatchObject({ shared: false });
  });

  it('keeps the compile when nothing it read or chose has changed', async () => {
    const root = project({ 'shared/item.ts': SAFE });
    const app = await initial(root);

    await expect(compileProject({ projectDir: app })).resolves.toMatchObject({ compiled: false });
    expect(admission(app)).toMatchObject({ shared: true });
  });

  it('keeps the compile when files the checker would take after the selected one appear', async () => {
    const root = project({
      'shared/item.ts': "import type { Base } from './base';\nexport type Item = Base;\n",
      'shared/base.ts': SAFE.replace('Item', 'Base'),
    });
    const app = await initial(root);
    write(root, 'shared/item.tsx', ERROR);
    write(root, 'shared/item/index.ts', ERROR);
    write(root, 'shared/base.tsx', ERROR.replace('Item', 'Base'));
    write(root, 'shared/unrelated.ts', ERROR);

    await expect(compileProject({ projectDir: app })).resolves.toMatchObject({ compiled: false });
  });

  it('recompiles when the selected declaration is edited, as before', async () => {
    const root = project({ 'shared/item.ts': SAFE });
    const app = await initial(root);
    write(root, 'shared/item.ts', ERROR);

    await expect(recompiled(app)).resolves.toMatchObject({ shared: false });
  });
});
