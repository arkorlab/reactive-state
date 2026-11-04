import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { compileProject, DIGEST_FILE } from '../src/next/compile-on-build.ts';

/** A cached compile keeps the exact module choices from its original admission. */
const roots: string[] = [];
const SAFE = 'export const GREETING = "Hello";\n';
const UNSAFE = 'export const GREETING = String(Date.now());\n';

function write(root: string, file: string, text: string): void {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text);
}

function project(files: Readonly<Record<string, string>>, targets = ['../shared/*']): string {
  const root = mkdtempSync(path.join(tmpdir(), 'reactive-resolution-'));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) write(root, file, text);
  write(
    root,
    'app/tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        jsx: 'react-jsx',
        paths: { '@/*': ['./src/*'], '@shared/*': targets },
      },
    }),
  );
  write(
    root,
    'app/src/components/hello.reactive.tsx',
    [
      'import { GREETING } from "@shared/greeting";',
      'export default function Hello({ name }: { readonly name: string }) {',
      '  return <p>{GREETING}, {name}</p>;',
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

async function initial(root: string): Promise<string> {
  const app = path.join(root, 'app');

  await expect(compileProject({ projectDir: app })).resolves.toMatchObject({ compiled: true });
  await expect(compileProject({ projectDir: app })).resolves.toMatchObject({ compiled: false });

  return app;
}

interface RouteAdmission {
  readonly shared: boolean;
  readonly private?: string;
}

/** A fresh compile reports the current admission after the selected external helper changes. */
async function recompiledRoute(app: string): Promise<RouteAdmission | undefined> {
  await expect(compileProject({ projectDir: app })).resolves.toMatchObject({ compiled: true });

  const manifest = JSON.parse(readFileSync(path.join(app, '.reactive/manifest.json'), 'utf8')) as {
    readonly routes: readonly RouteAdmission[];
  };

  return manifest.routes[0];
}

describe('external module resolution cache inputs', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('reclassifies a newly preferred ts file while the old tsx stays unchanged', async () => {
    const root = project({ 'shared/greeting.tsx': SAFE });
    const app = await initial(root);
    const oldDigest = readFileSync(path.join(app, '.reactive', DIGEST_FILE), 'utf8');
    write(root, 'shared/greeting.ts', UNSAFE);

    await expect(recompiledRoute(app)).resolves.toMatchObject({
      shared: false,
      private: expect.stringContaining('an input nothing tracks'),
    });
    expect(readFileSync(path.join(root, 'shared/greeting.tsx'), 'utf8')).toBe(SAFE);
    expect(readFileSync(path.join(app, '.reactive', DIGEST_FILE), 'utf8')).not.toBe(oldDigest);
  });

  it('rebuilds identity when a safe higher priority candidate appears', async () => {
    const root = project({ 'shared/greeting.tsx': SAFE });
    const app = await initial(root);
    const before = readFileSync(path.join(app, '.reactive/manifest.json'), 'utf8');
    write(root, 'shared/greeting.ts', 'export const GREETING = "Hi";\n');

    await expect(compileProject({ projectDir: app })).resolves.toMatchObject({
      compiled: true,
      changed: true,
    });
    expect(readFileSync(path.join(app, '.reactive/manifest.json'), 'utf8')).not.toBe(before);
    await expect(compileProject({ projectDir: app })).resolves.toMatchObject({ compiled: false });
  });

  it('reclassifies a file added ahead of an existing directory index', async () => {
    const root = project({ 'shared/greeting/index.ts': SAFE });
    const app = await initial(root);
    write(root, 'shared/greeting.ts', UNSAFE);

    await expect(recompiledRoute(app)).resolves.toMatchObject({
      shared: false,
      private: expect.stringContaining('an input nothing tracks'),
    });
  });

  it('reclassifies a new TypeScript substitution of an external relative js import', async () => {
    const root = project({
      'shared/greeting.ts': 'export { GREETING } from "./word.js";\n',
      'shared/word.js': SAFE,
    });
    const app = await initial(root);
    write(root, 'shared/word.ts', UNSAFE);

    await expect(recompiledRoute(app)).resolves.toMatchObject({
      shared: false,
      private: expect.stringContaining('an input nothing tracks'),
    });
  });

  it('reclassifies a newly present earlier alias fallback target', async () => {
    const root = project({ 'shared/greeting.ts': SAFE }, ['../preferred/*', '../shared/*']);
    const app = await initial(root);
    write(root, 'preferred/greeting.ts', UNSAFE);

    await expect(recompiledRoute(app)).resolves.toMatchObject({
      shared: false,
      private: expect.stringContaining('an input nothing tracks'),
    });
  });

  it('reclassifies a changed external directory main while old read files stay unchanged', async () => {
    const root = project({
      'shared/greeting/index.ts': SAFE,
      'shared/greeting/unsafe.ts': UNSAFE,
      'shared/greeting/package.json': JSON.stringify({ main: './index.ts' }),
    });
    const app = await initial(root);
    write(root, 'shared/greeting/package.json', JSON.stringify({ main: './unsafe.ts' }));

    await expect(recompiledRoute(app)).resolves.toMatchObject({
      shared: false,
      private: expect.stringContaining('an input nothing tracks'),
    });
  });

  it('reclassifies a retargeted external symlink with the same bridge text', async () => {
    const bridge = 'export { GREETING } from "./word";\n';
    const root = project({
      'shared/one/bridge.ts': bridge,
      'shared/two/bridge.ts': bridge,
      'shared/one/word.ts': SAFE,
      'shared/two/word.ts': UNSAFE,
    });
    symlinkSync('./one/bridge.ts', path.join(root, 'shared/greeting.ts'));
    const app = await initial(root);
    rmSync(path.join(root, 'shared/greeting.ts'));
    symlinkSync('./two/bridge.ts', path.join(root, 'shared/greeting.ts'));

    await expect(recompiledRoute(app)).resolves.toMatchObject({
      shared: false,
      private: expect.stringContaining('an input nothing tracks'),
    });
  });

  it('keeps unrelated external additions cached and still invalidates changed read text', async () => {
    const root = project({ 'shared/greeting.ts': SAFE });
    const app = await initial(root);
    write(root, 'shared/unrelated.ts', UNSAFE);

    await expect(compileProject({ projectDir: app })).resolves.toMatchObject({ compiled: false });

    write(root, 'shared/greeting.ts', UNSAFE);

    await expect(recompiledRoute(app)).resolves.toMatchObject({
      shared: false,
      private: expect.stringContaining('an input nothing tracks'),
    });
  });

  it('reclassifies when a nearer external tsconfig changes a dependency alias', async () => {
    const root = project({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { paths: { '@word': ['./shared/one'] } },
      }),
      'shared/greeting.ts': 'export { GREETING } from "@word";\n',
      'shared/one.ts': SAFE,
      'shared/two.ts': UNSAFE,
    });
    const app = await initial(root);
    write(
      root,
      'shared/tsconfig.json',
      JSON.stringify({ compilerOptions: { paths: { '@word': ['./two'] } } }),
    );

    await expect(recompiledRoute(app)).resolves.toMatchObject({
      shared: false,
      private: expect.stringContaining('an input nothing tracks'),
    });
  });

  it('keeps newly added lower priority candidates cached', async () => {
    const root = project({ 'shared/greeting.ts': SAFE });
    const app = await initial(root);
    write(root, 'shared/greeting.tsx', UNSAFE);
    write(root, 'shared/greeting/index.ts', UNSAFE);

    await expect(compileProject({ projectDir: app })).resolves.toMatchObject({ compiled: false });
  });

  it('keeps a symlink spelling change to the same canonical file cached', async () => {
    const root = project({ 'shared/one/greeting.ts': SAFE });
    symlinkSync('./one/greeting.ts', path.join(root, 'shared/greeting.ts'));
    const app = await initial(root);
    rmSync(path.join(root, 'shared/greeting.ts'));
    symlinkSync('./one/../one/greeting.ts', path.join(root, 'shared/greeting.ts'));

    await expect(compileProject({ projectDir: app })).resolves.toMatchObject({ compiled: false });
  });

  it('recompiles when the formerly selected file is removed', async () => {
    const root = project({ 'shared/greeting.ts': SAFE, 'shared/greeting.tsx': UNSAFE });
    const app = await initial(root);
    rmSync(path.join(root, 'shared/greeting.ts'));

    await expect(recompiledRoute(app)).resolves.toMatchObject({
      shared: false,
      private: expect.stringContaining('an input nothing tracks'),
    });
  });
});
