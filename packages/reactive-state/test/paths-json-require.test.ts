import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it, onTestFinished } from 'vitest';

/**
 * A JSON document an application's CommonJS module requires, under `registerPaths`: read as Node
 * reads one for a `require`, the document itself. The module the hooks make of a JSON document is
 * an import's alone, as it is of one a package's `exports` name. Each case runs in a Node of its
 * own, as `paths.test.ts`'s do.
 */

const PATHS = fileURLToPath(new URL('../src/authority/paths.ts', import.meta.url));

interface Ran {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

/** An application of `files`, whose `tsconfig.json` aliases `@/*` to its root. */
async function application(files: Readonly<Record<string, string>>): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'reactive-paths-require-'));
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

describe('a JSON document an application’s CommonJS module requires', () => {
  it.each([
    { by: 'a relative path', specifier: './roles.json' },
    { by: 'an alias', specifier: '@/roles.json' },
  ])('is the document itself, required by $by', async ({ specifier }) => {
    const directory = await application({
      'main.mts': [
        "import roles from './roles.cjs';",
        "console.log(Array.isArray(roles), roles.join(','));",
        '',
      ].join('\n'),
      'roles.cjs': `module.exports = require(${JSON.stringify(specifier)});\n`,
      'roles.json': '["editor", "owner"]',
    });

    await expect(run(directory)).resolves.toMatchObject({
      code: 0,
      stdout: 'true editor,owner\n',
    });
  });

  it('is still the module the hooks make of it where the same module imports it', async () => {
    const directory = await application({
      'main.mts': [
        "import { imported, required } from './roles.cjs';",
        'const module = await imported;',
        "console.log(required.join(','), module.default.join(','));",
        '',
      ].join('\n'),
      'roles.cjs': [
        "exports.required = require('./roles.json');",
        "exports.imported = import('./roles.json');",
        '',
      ].join('\n'),
      'roles.json': '["editor", "owner"]',
    });

    await expect(run(directory)).resolves.toMatchObject({
      code: 0,
      stdout: 'editor,owner editor,owner\n',
    });
  });
});
