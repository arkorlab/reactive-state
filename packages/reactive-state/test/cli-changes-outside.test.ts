import type { FSWatcher } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { followFiles, outsideOf } from '../src/cli/changes.ts';

/**
 * What `reactive dev` follows of the modules an application imports from outside its own folders: a
 * workspace's package, or a folder of the root beside `src`. No watch of `src` or of the app reaches
 * them, so an edit of one told nothing and left the authority on the code it had.
 */

const ROOT = path.resolve('/work/application');
const layout = {
  appDir: path.join(ROOT, 'src/app'),
  outDir: path.join(ROOT, '.reactive'),
  projectDir: ROOT,
  srcDir: path.join(ROOT, 'src'),
};

describe('the modules of a compile that no watch of the application reaches', () => {
  it('are those of the root and beyond it, outside the components and the app', () => {
    const reads = [
      'src/components/hello.reactive.tsx',
      'src/app/page.tsx',
      'lib/helper.ts',
      '../shared/greeting.ts',
      'helper.ts',
    ];

    expect(outsideOf(layout, reads)).toStrictEqual(
      ['helper.ts', 'lib/helper.ts', '../shared/greeting.ts'].map((read) =>
        path.resolve(ROOT, read),
      ),
    );
  });

  it('leave out what is watched already: the root files the start reads, and an app beside src', () => {
    const beside = { ...layout, appDir: path.join(ROOT, 'app') };
    const reads = ['tsconfig.json', 'next.config.ts', '.env', 'app/page.tsx', 'lib/helper.ts'];

    expect(outsideOf(beside, reads)).toStrictEqual([path.join(ROOT, 'lib/helper.ts')]);
  });

  it('leave out the packages of `node_modules`, which an install changes', () => {
    const reads = ['node_modules/pkg/index.js', '../shared/node_modules/pkg/index.js'];

    expect(outsideOf(layout, reads)).toStrictEqual([]);
  });
});

/** The directories `followFiles` watched, and what each tells of. */
function watched() {
  const directories = new Map<
    string,
    {
      recursive: boolean;
      listener: (event: string, name: string | null) => void;
      close: ReturnType<typeof vi.fn>;
    }
  >();
  const told = vi.fn();
  const said = vi.fn();
  const refused = new Set<string>();
  const follow = (files: readonly string[]) => {
    return followFiles(files, told, said, (directory, { recursive }, listener) => {
      if (refused.has(directory)) throw new Error('ENOSPC');
      const close = vi.fn();
      directories.set(directory, { close, listener, recursive });
      return { close, on: vi.fn() } as unknown as FSWatcher;
    });
  };
  return { directories, follow, refused, said, told };
}

describe('the following of those modules', () => {
  it('watches the directory of each, of its own and no deeper, once', () => {
    const { directories, follow } = watched();

    follow(['/work/shared/a.ts', '/work/shared/b.ts', '/work/application/lib/helper.ts']);

    expect(
      [...directories].map(([directory, { recursive }]) => [directory, recursive]),
    ).toStrictEqual([
      ['/work/shared', false],
      ['/work/application/lib', false],
    ]);
  });

  it('tells of the files it was given, and of no other file of their directory', () => {
    const { directories, follow, told } = watched();
    follow(['/work/shared/a.ts']);
    const listener = directories.get('/work/shared')?.listener;

    listener?.('change', 'unrelated.log');

    expect(told).not.toHaveBeenCalled();

    listener?.('change', 'a.ts');

    expect(told).toHaveBeenCalledTimes(1);

    listener?.('rename', null);

    expect(told).toHaveBeenCalledTimes(2);
  });

  it('closes every watch as it ends', () => {
    const { directories, follow } = watched();
    const unfollow = follow(['/work/shared/a.ts', '/work/application/lib/helper.ts']);

    unfollow();

    expect([...directories.values()].map(({ close }) => close.mock.calls.length)).toStrictEqual([
      1, 1,
    ]);
  });

  it('says what the system refuses to watch, and follows the rest', () => {
    const { directories, follow, refused, said } = watched();
    refused.add('/work/shared');

    follow(['/work/shared/a.ts', '/work/application/lib/helper.ts']);

    expect(said).toHaveBeenCalledWith(
      expect.stringContaining('[watch] /work/shared: Error: ENOSPC'),
    );
    expect([...directories.keys()]).toStrictEqual(['/work/application/lib']);
  });
});
