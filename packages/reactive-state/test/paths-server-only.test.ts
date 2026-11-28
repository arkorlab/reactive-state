import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it, onTestFinished } from 'vitest';

/**
 * `server-only` under `registerPaths`: an empty module wherever it is imported or required from —
 * the application's ES module, CommonJS or TypeScript, or a package's — as in Next.js's server
 * bundles, where the package is installed or not. An installed one is a copy as Next.js ships its
 * own, whose entry throws for any layer but a server's. Each case runs in a Node of its own, as
 * `paths.test.ts`'s do.
 */

const PATHS = fileURLToPath(new URL('../src/authority/paths.ts', import.meta.url));
const THROW = 'This module cannot be imported from a Client Component module.';

interface Ran {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

/** The package as Next.js ships its copy: empty for a server layer, a throw for any other. */
const INSTALLED: Readonly<Record<string, string>> = {
  'node_modules/server-only/empty.js': '',
  'node_modules/server-only/index.js': `throw new Error(${JSON.stringify(THROW)});\n`,
  'node_modules/server-only/package.json': JSON.stringify({
    exports: { '.': { default: './index.js', 'react-server': './empty.js' } },
    name: 'server-only',
  }),
};

/** An application of `files`, whose `tsconfig.json` aliases `@/*` to its root. */
async function application(files: Readonly<Record<string, string>>): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'reactive-paths-server-only-'));
  onTestFinished(async () => {
    await rm(directory, { force: true, recursive: true });
  });
  const tsconfig = path.join(directory, 'tsconfig.json');
  await writeFile(tsconfig, JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }));
  await writeFile(
    path.join(directory, 'register.mts'),
    `import { registerPaths } from ${JSON.stringify(PATHS)};\nregisterPaths(${JSON.stringify(tsconfig)});\n`,
  );
  for (const [name, source] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), source);
  }
  return directory;
}

/** `main.mts` of the application, in a Node that registered its aliases first. */
async function run(directory: string): Promise<Ran> {
  try {
    const { stderr, stdout } = await promisify(execFile)(
      process.execPath,
      ['--import', './register.mts', 'main.mts'],
      { cwd: directory },
    );
    return { code: 0, stderr, stdout };
  } catch (error) {
    const failed = error as {
      readonly code?: number;
      readonly stderr?: string;
      readonly stdout?: string;
    };
    return { code: failed.code ?? 1, stderr: failed.stderr ?? '', stdout: failed.stdout ?? '' };
  }
}

/** The ways a module of the application, or a package, reaches `server-only`. */
const SOURCES: readonly {
  readonly files: Readonly<Record<string, string>>;
  readonly name: string;
}[] = [
  {
    files: { 'main.mts': "import 'server-only';\nconsole.log('loaded');\n" },
    name: 'an ES module’s import',
  },
  {
    files: {
      'main.mts': "import './guard.cjs';\nconsole.log('loaded');\n",
      'guard.cjs': "require('server-only');\n",
    },
    name: 'a CommonJS module’s require',
  },
  {
    files: {
      'main.mts': "import { value } from '@/guard.ts';\nconsole.log('loaded', value);\n",
      'guard.ts': "import 'server-only';\nexport const value: number = 1;\n",
    },
    name: 'a TypeScript module’s import',
  },
  {
    files: {
      'main.mts': "import { value } from 'guarded';\nconsole.log('loaded', value);\n",
      'node_modules/guarded/index.cjs': "require('server-only');\nexports.value = 1;\n",
      'node_modules/guarded/package.json': JSON.stringify({ main: './index.cjs', name: 'guarded' }),
    },
    name: 'a package’s require',
  },
];

describe('server-only an application’s module imports', () => {
  describe.each([
    { installed: {}, state: 'not installed' },
    { installed: INSTALLED, state: 'installed' },
  ])('with the package $state', ({ installed }) => {
    it.each(SOURCES)('is an empty module: $name', async ({ files }) => {
      const directory = await application({ ...installed, ...files });

      const ran = await run(directory);

      expect(ran).toMatchObject({ code: 0 });
      expect(ran.stdout).toMatch(/^loaded/u);
      expect(ran.stderr).not.toContain(THROW);
    });
  });

  it('leaves client-only to Node', async () => {
    const directory = await application({ 'main.mts': "import 'client-only';\n" });

    const ran = await run(directory);

    expect(ran.code).not.toBe(0);
    expect(ran.stderr).toContain('client-only');
  });
});
