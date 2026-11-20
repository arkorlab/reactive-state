import { mkdirSync, mkdtempSync, type PathLike, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { compileProject, DIGEST_FILE } from '../src/next/compile-on-build.ts';

/**
 * The order the compile run before a build puts its files in place: each written beside where it
 * goes and renamed over it, the manifest after every file it describes, and the digest that says
 * the compile is done after the manifest — so that no reader of the manifest finds a file it names
 * missing, and no later compile skips one that stopped halfway. Read off the renames it makes.
 */

const renames = vi.hoisted((): string[] => []);

vi.mock(import('node:fs'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    renameSync: (from: PathLike, to: PathLike): void => {
      renames.push(String(to));
      actual.renameSync(from, to);
    },
  };
});

const projects: string[] = [];

describe('compileProject', () => {
  afterEach(() => {
    renames.length = 0;
    for (const dir of projects.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('puts the manifest in place after every file it describes, and the digest last', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'reactive-state-compile-'));
    projects.push(dir);
    mkdirSync(path.join(dir, 'src', 'components'), { recursive: true });
    mkdirSync(path.join(dir, 'src', 'app'));
    writeFileSync(
      path.join(dir, 'src/components/hello.reactive.tsx'),
      'export default function Hello() {\n  return <p>Hello</p>;\n}\n',
    );

    await compileProject({ projectDir: dir });
    const manifest = path.join(dir, '.reactive', 'manifest.json');

    expect(renames.at(-1)).toBe(path.join(dir, '.reactive', DIGEST_FILE));
    expect(renames.at(-2)).toBe(manifest);
    expect(renames.indexOf(manifest)).toBe(renames.length - 2);
    expect(renames).toContain(path.join(dir, '.reactive', 'authority.mts'));
    expect(renames).toContain(path.join(dir, 'src/app/api/reactive-state/[...path]/route.ts'));
  });
});
