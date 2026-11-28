import fs from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';

import { Modules } from '../src/compiler/modules.ts';
import { openTypeScript } from '../src/compiler/typescript.ts';
import {
  application,
  type Application,
  refusalOf,
  source,
  variant,
} from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * What one compile reads of the packages an application imports, and where it looks for them: each
 * manifest read once, a missing one too, and each specifier looked up once from a directory, on a
 * side — and of a compile, nothing kept for the next, which reads what changed since.
 */

const EDITOR = 'components/todo-editor.reactive.tsx';

const MODULE = "export const allow = () => true;\nexport const label = 'gate';\n";

/** The fixture's TodoEditor, beside a package `gate` of `manifest` and of `files`. */
async function withGate(
  manifest: Readonly<Record<string, unknown>>,
  imports: { readonly before: string; readonly after: string; readonly reads?: number },
  files: readonly string[] = ['shared.js', 'client.js', 'server.js'],
): Promise<Application> {
  const { after, before, reads = 1 } = imports;
  const imported = variant(
    await source(EDITOR),
    "import { db } from '@/db';",
    `import { db } from '@/db';\nimport { allow } from '${before}';\nimport { label } from '${after}';`,
  );
  const allowed = Array.from({ length: reads }, () => 'allow()').join(' && ');
  const allowing = variant(
    imported,
    '  const ref = db.todos.ref(id);',
    `  const ref = db.todos.ref(${allowed} ? id : '');`,
  );
  const app = await application({
    [EDITOR]: variant(allowing, '<p>{status}</p>', '<p>{status}{label}</p>'),
  });
  await writeManifest(app, manifest);
  for (const file of files) {
    await writeFile(path.join(gateOf(app), file), MODULE);
  }
  return app;
}

function gateOf(app: Application): string {
  return path.join(app.root, 'node_modules/gate');
}

async function writeManifest(
  app: Application,
  manifest: Readonly<Record<string, unknown>>,
): Promise<void> {
  await mkdir(gateOf(app), { recursive: true });
  await writeFile(
    path.join(gateOf(app), 'package.json'),
    JSON.stringify({ name: 'gate', type: 'module', ...manifest }),
  );
}

/**
 * How many times `run` calls `method` of `node:fs` with `file`: the compiler's named imports of the
 * module see the spy once its exports are synced with the spied object.
 */
function callsOf(method: 'readFileSync' | 'statSync', file: string, run: () => void): number {
  const spy = vi.spyOn(fs, method);
  syncBuiltinESMExports();
  try {
    run();
    return spy.mock.calls.filter(([named]) => named === file).length;
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
}

const TWO_FILES = { exports: { '.': './client.js', './server': './server.js' } } as const;
const ONE_FILE = { exports: { '.': './shared.js', './server': './shared.js' } } as const;
const READ_ON_BOTH = "`label` is `gate`'s, which the server part reads on the authority";

describe('the compiler, of what one compile reads of the packages imported', () => {
  const { apps, compile } = compilerApplications();

  async function gated(
    manifest: Readonly<Record<string, unknown>>,
    imports: { readonly before: string; readonly after: string; readonly reads?: number },
    files?: readonly string[],
  ): Promise<Application> {
    const app = await withGate(manifest, imports, files);
    apps.push(app);
    return app;
  }

  it('reads a package’s manifest once, however many lookups it answers', async () => {
    const app = await gated(TWO_FILES, { after: 'gate', before: 'gate/server' });
    const manifest = path.join(gateOf(app), 'package.json');

    const reads = callsOf('readFileSync', manifest, () => {
      expect(compile(app).refusals).toStrictEqual([]);
    });

    expect(reads).toBe(1);
  });

  it('looks for a manifest that is not there once', async () => {
    const app = await gated(TWO_FILES, { after: 'gate', before: 'gate/server' });
    const missing = path.join(app.src, 'components/package.json');

    const reads = callsOf('readFileSync', missing, () => {
      expect(compile(app).refusals).toStrictEqual([]);
    });

    expect(reads).toBe(1);
  });

  it('looks a specifier up once from a directory, however many reads name it', async () => {
    const once = await gated(TWO_FILES, { after: 'gate', before: 'gate/server' });
    const thrice = await gated(TWO_FILES, { after: 'gate', before: 'gate/server', reads: 3 });
    // Where the lookup from a component's directory first looks for the package.
    const looked = (app: Application): number => {
      return callsOf('statSync', path.join(app.src, 'components/node_modules/gate'), () => {
        expect(compile(app).refusals).toStrictEqual([]);
      });
    };

    const lookups = looked(once);

    expect(lookups).toBeGreaterThan(0);
    expect(looked(thrice)).toBe(lookups);
  });

  it('reads a manifest changed since the last compile anew', async () => {
    const app = await gated(TWO_FILES, { after: 'gate', before: 'gate/server' });

    expect(compile(app).refusals).toStrictEqual([]);

    await writeManifest(app, ONE_FILE);

    expect(refusalOf(compile(app)).reason).toContain(READ_ON_BOTH);
  });

  it('finds a package’s file written since the last compile', async () => {
    const app = await gated(ONE_FILE, { after: 'gate', before: 'gate/server' }, ['client.js']);

    expect(compile(app).refusals).toStrictEqual([]);

    await writeFile(path.join(gateOf(app), 'shared.js'), MODULE);

    expect(refusalOf(compile(app)).reason).toContain(READ_ON_BOTH);
  });

  it('keeps nothing of a compile that threw for the next', async () => {
    // A target of an encoded `/` is no path of a file: the lookup throws, the manifest read.
    const app = await gated(
      { exports: { '.': './client.js', './server': './a%2Fb.js' } },
      { after: 'gate', before: 'gate/server' },
    );

    expect(() => compile(app)).toThrow(/encoded/u);

    await writeManifest(app, ONE_FILE);

    expect(refusalOf(compile(app)).reason).toContain(READ_ON_BOTH);
  });
});

/** A directory of `files`, by their paths in it, removed once the test is over. */
async function tree(files: Readonly<Record<string, string>>): Promise<string> {
  const made = await mkdtemp(path.join(tmpdir(), 'reactive-lookups-'));
  const root = await realpath(made);
  onTestFinished(async () => {
    await rm(root, { force: true, recursive: true });
  });
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  return root;
}

describe('the modules of a compile, of what a specifier names', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it('answers each side its own files of one specifier', async () => {
    const root = await tree({
      'node_modules/gate/client.js': MODULE,
      // Node's condition before the default, as a condition's order is what it is taken by.
      'node_modules/gate/package.json':
        '{ "name": "gate", "exports": { ".": { "node": "./server.js", "default": "./client.js" } } }',
      'node_modules/gate/server.js': MODULE,
    });
    using modules = new Modules(api, root);
    const importer = path.join(root, 'a.ts');
    const gate = path.join(root, 'node_modules/gate');

    expect(modules.identities('gate', importer, 'authority')).toStrictEqual([
      'gate',
      path.join(gate, 'server.js'),
      path.join(gate, 'client.js'),
    ]);
    expect(modules.identities('gate', importer, 'browser')).toStrictEqual([
      'gate',
      path.join(gate, 'client.js'),
    ]);
  });

  it('answers each directory the package it finds from there', async () => {
    const manifest = JSON.stringify({ main: './index.js', name: 'gate' });
    const root = await tree({
      'a/node_modules/gate/index.js': MODULE,
      'a/node_modules/gate/package.json': manifest,
      'b/node_modules/gate/index.js': MODULE,
      'b/node_modules/gate/package.json': manifest,
    });
    using modules = new Modules(api, root);

    expect(modules.identities('gate', path.join(root, 'a/x.ts'), 'authority')).toStrictEqual([
      'gate',
      path.join(root, 'a/node_modules/gate/index.js'),
    ]);
    expect(modules.identities('gate', path.join(root, 'b/y.ts'), 'authority')).toStrictEqual([
      'gate',
      path.join(root, 'b/node_modules/gate/index.js'),
    ]);
  });

  it('answers each directory by the aliases of its own configuration', async () => {
    const config = JSON.stringify({ compilerOptions: { paths: { lib: ['./lib.ts'] } } });
    const root = await tree({
      'a/lib.ts': MODULE,
      'a/tsconfig.json': config,
      'b/lib.ts': MODULE,
      'b/tsconfig.json': config,
    });
    using modules = new Modules(api, root);

    expect(modules.identities('lib', path.join(root, 'a/x.ts'), 'browser')).toStrictEqual([
      'lib',
      path.join(root, 'a/lib.ts'),
    ]);
    expect(modules.identities('lib', path.join(root, 'b/y.ts'), 'browser')).toStrictEqual([
      'lib',
      path.join(root, 'b/lib.ts'),
    ]);
  });

  it('answers two files of one directory alike', async () => {
    const root = await tree({
      'node_modules/gate/index.js': MODULE,
      'node_modules/gate/package.json': JSON.stringify({ main: './index.js', name: 'gate' }),
    });
    using modules = new Modules(api, root);
    const first = modules.identities('gate', path.join(root, 'x.ts'), 'browser');

    expect(modules.identities('gate', path.join(root, 'y.tsx'), 'browser')).toStrictEqual(first);
  });

  it('looks a specifier up once from a directory, however many of its files name it', async () => {
    const root = await tree({
      'node_modules/gate/index.js': MODULE,
      'node_modules/gate/package.json': JSON.stringify({ main: './index.js', name: 'gate' }),
    });
    using modules = new Modules(api, root);
    // Where a lookup from `src` first looks for the package.
    const looked = path.join(root, 'src/node_modules/gate');
    const first = callsOf('statSync', looked, () => {
      modules.identities('gate', path.join(root, 'src/x.ts'), 'browser');
    });
    const second = callsOf('statSync', looked, () => {
      modules.identities('gate', path.join(root, 'src/y.tsx'), 'browser');
    });

    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
  });

  it('reads the manifest of the package an alias names a file of once, however many lookups name it', async () => {
    const root = await tree({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { paths: { lib: ['./vendor/lib/main.js'] } },
      }),
      'vendor/lib/browser.js': MODULE,
      'vendor/lib/main.js': MODULE,
      'vendor/lib/package.json': JSON.stringify({
        browser: { './main.js': './browser.js' },
        name: 'lib',
      }),
    });
    using modules = new Modules(api, root);
    const mapped = path.join(root, 'vendor/lib/browser.js');

    const reads = callsOf('readFileSync', path.join(root, 'vendor/lib/package.json'), () => {
      expect(modules.identities('lib', path.join(root, 'a.ts'), 'authority')).toContain(mapped);
      expect(modules.identities('lib', path.join(root, 'b/c.ts'), 'browser')).toContain(mapped);
    });

    expect(reads).toBe(1);
  });
});
