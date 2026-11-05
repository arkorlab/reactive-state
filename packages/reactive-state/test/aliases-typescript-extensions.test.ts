import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { aliasesOf, resolveAlias, typescriptFor } from '../src/authority/aliases.ts';

/**
 * The TypeScript file a path to JavaScript stands for, in the order TypeScript's resolver tries
 * them (`tryAddingExtensions`): `.js` as `.ts` and then `.tsx`, `.jsx` as `.tsx` and then `.ts`,
 * `.mjs` as `.mts`, `.cjs` as `.cts` — and never as the declaration it tries after them, which is
 * no module to load.
 */

/** A directory of `files`, by name and text — an empty module where none is given. */
async function directoryOf(files: Readonly<Record<string, string>>): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'reactive-extensions-'));
  onTestFinished(async () => {
    await rm(directory, { force: true, recursive: true });
  });
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), text === '' ? 'export {};\n' : text);
  }
  return directory;
}

describe('typescriptFor', () => {
  it('reads `.js` as `.ts`, and else as `.tsx`, as TypeScript does', async () => {
    const directory = await directoryOf({
      'both.js': '',
      'both.ts': '',
      'both.tsx': '',
      'tsx.js': '',
      'tsx.tsx': '',
    });

    expect(typescriptFor(path.join(directory, 'both.js'))).toBe(path.join(directory, 'both.ts'));
    expect(typescriptFor(path.join(directory, 'tsx.js'))).toBe(path.join(directory, 'tsx.tsx'));
  });

  it('reads `.jsx` as `.tsx`, and else as `.ts`, as TypeScript does', async () => {
    const directory = await directoryOf({ 'both.ts': '', 'both.tsx': '', 'ts.ts': '' });

    expect(typescriptFor(path.join(directory, 'both.jsx'))).toBe(path.join(directory, 'both.tsx'));
    expect(typescriptFor(path.join(directory, 'ts.jsx'))).toBe(path.join(directory, 'ts.ts'));
  });

  it('reads `.mjs` as `.mts` and `.cjs` as `.cts` alone', async () => {
    const directory = await directoryOf({
      'common.cts': '',
      'module.mts': '',
      'plain.ts': '',
      'plain.tsx': '',
    });

    expect(typescriptFor(path.join(directory, 'module.mjs'))).toBe(
      path.join(directory, 'module.mts'),
    );
    expect(typescriptFor(path.join(directory, 'common.cjs'))).toBe(
      path.join(directory, 'common.cts'),
    );
    expect(typescriptFor(path.join(directory, 'plain.mjs'))).toBeUndefined();
    expect(typescriptFor(path.join(directory, 'plain.cjs'))).toBeUndefined();
  });

  it('finds none in a declaration, nor for a path to anything but JavaScript', async () => {
    const directory = await directoryOf({ 'declared.d.ts': '', 'declared.js': '', 'plain.ts': '' });

    expect(typescriptFor(path.join(directory, 'declared.js'))).toBeUndefined();
    expect(typescriptFor(path.join(directory, 'missing.js'))).toBeUndefined();
    expect(typescriptFor(path.join(directory, 'plain.ts'))).toBeUndefined();
    expect(typescriptFor(path.join(directory, 'plain'))).toBeUndefined();
  });

  it('resolves an alias’s JavaScript, and the entry a `package.json` names, as their TypeScript', async () => {
    const directory = await directoryOf({
      'button.tsx': '',
      'list.ts': '',
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          paths: {
            '@/button': ['./button.js'],
            '@/list': ['./list.jsx'],
            '@/ui': ['./ui'],
            '@/widget': ['./widget.js'],
          },
        },
      }),
      'ui/entry.tsx': '',
      'ui/package.json': JSON.stringify({ main: './entry.js' }),
      'widget.js': '',
      'widget.tsx': '',
    });
    const aliases = aliasesOf(path.join(directory, 'tsconfig.json'));

    expect(resolveAlias(aliases, '@/button')).toBe(path.join(directory, 'button.tsx'));
    expect(resolveAlias(aliases, '@/list')).toBe(path.join(directory, 'list.ts'));
    expect(resolveAlias(aliases, '@/ui')).toBe(path.join(directory, 'ui/entry.tsx'));
    // TypeScript's, though a JavaScript file of the name stands beside it.
    expect(resolveAlias(aliases, '@/widget')).toBe(path.join(directory, 'widget.tsx'));
  });
});
