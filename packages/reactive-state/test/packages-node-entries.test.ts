import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { packageFiles } from '../src/compiler/packages.ts';

/**
 * The entry Node takes a package of no `exports` to name, as it finds it (`legacyMainResolve`): its
 * `main` as written, with `.js`, `.json` or `.node`, or a directory's `index` of one of them, and
 * else the package's own `index.js` — never its TypeScript, which a bundler takes first, nor what a
 * directory's own `package.json` names. The authority's files of a package are what Node runs of
 * it, and what a Durable Object's bundle does.
 */

/** An application beside a package `gate` of `manifest` and `files`, by name and text. */
async function withGate(
  manifest: Readonly<Record<string, unknown>>,
  files: Readonly<Record<string, string>>,
): Promise<{ readonly app: string; readonly gate: string }> {
  const made = await mkdtemp(path.join(tmpdir(), 'reactive-node-entries-'));
  const root = await realpath(made);
  onTestFinished(async () => {
    await rm(root, { force: true, recursive: true });
  });
  const gate = path.join(root, 'node_modules/gate');
  await mkdir(gate, { recursive: true });
  await writeFile(
    path.join(gate, 'package.json'),
    JSON.stringify({ name: 'gate', type: 'module', ...manifest }),
  );
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(gate, name)), { recursive: true });
    await writeFile(path.join(gate, name), text);
  }
  return { app: root, gate };
}

const MODULE = "export const label = 'gate';\n";

describe('packageFiles, of a package of no `exports` on the authority', () => {
  it('takes the JavaScript Node runs for a `main` of no extension, beside the TypeScript a bundler takes', async () => {
    const { app, gate } = await withGate(
      { main: './index' },
      { 'index.js': MODULE, 'index.ts': MODULE },
    );

    const files = packageFiles('gate', app, 'authority');

    expect(files).toContain(path.join(gate, 'index.js'));
    expect(files).toContain(path.join(gate, 'index.ts'));
  });

  it('takes the `index.js` Node runs for a package of no `main`', async () => {
    const { app, gate } = await withGate({}, { 'index.js': MODULE, 'index.ts': MODULE });

    expect(packageFiles('gate', app, 'authority')).toContain(path.join(gate, 'index.js'));
  });

  it('takes the `index.js` Node runs where `main` names no file', async () => {
    const { app, gate } = await withGate({ main: './missing.js' }, { 'index.js': MODULE });

    expect(packageFiles('gate', app, 'authority')).toStrictEqual([path.join(gate, 'index.js')]);
  });

  it('takes the `index.js` of a directory `main` names, whose own `package.json` Node does not read', async () => {
    const { app, gate } = await withGate(
      { main: './lib' },
      {
        'lib/index.js': MODULE,
        'lib/other.js': MODULE,
        'lib/package.json': JSON.stringify({ main: './other.js' }),
      },
    );

    expect(packageFiles('gate', app, 'authority')).toContain(path.join(gate, 'lib/index.js'));
  });

  it('takes the JSON document Node takes for a `main` of no extension', async () => {
    const { app, gate } = await withGate({ main: './data' }, { 'data.json': '{}\n' });

    expect(packageFiles('gate', app, 'authority')).toContain(path.join(gate, 'data.json'));
  });

  // Pins: each passed before Node's entry was read as Node reads it.
  it('reads the browser’s entry, and a subpath, as a bundler does still', async () => {
    const { app, gate } = await withGate(
      { main: './index' },
      { 'index.js': MODULE, 'index.ts': MODULE },
    );

    expect(packageFiles('gate', app, 'browser')).toStrictEqual([path.join(gate, 'index.ts')]);
    expect(packageFiles('gate/index', app, 'authority')).toStrictEqual([
      path.join(gate, 'index.ts'),
    ]);
  });
});
