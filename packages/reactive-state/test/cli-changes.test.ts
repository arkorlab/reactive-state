import { type FSWatcher, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { type Change, followChanges } from '../src/cli/changes.ts';

/** What `reactive dev` follows of an application, of a system that only says what it is told. */

/** A directory watched, and how: a change is told through `listener`, a failure through `fail`. */
interface Watched {
  readonly recursive: boolean;
  readonly listener: (event: string, name: string | null) => void;
  readonly close: ReturnType<typeof vi.fn>;
  readonly fail: (error: Error) => void;
}

/** An application's root, of `src` and what `made` names under it, and what follows it. */
function followed({ app = 'src/app', made = [] }: { app?: string; made?: readonly string[] } = {}) {
  const projectDir = mkdtempSync(path.join(tmpdir(), 'reactive-changes-'));
  onTestFinished(() => {
    rmSync(projectDir, { force: true, recursive: true });
  });
  for (const directory of ['src', ...made]) mkdirSync(path.join(projectDir, directory));
  const watched = new Map<string, Watched>();
  const refused = new Set<string>();
  const changes: Change[] = [];
  const said = vi.fn();
  const layout = {
    appDir: path.join(projectDir, app),
    outDir: path.join(projectDir, '.reactive'),
    projectDir,
    srcDir: path.join(projectDir, 'src'),
  };
  const start = () => {
    return followChanges(
      layout,
      (change) => {
        changes.push(change);
      },
      said,
      (directory, { recursive }, listener) => {
        if (refused.has(directory)) throw new Error('ENOSPC');
        const close = vi.fn();
        const failures: ((error: Error) => void)[] = [];
        const fail = (error: Error) => {
          for (const failure of failures) failure(error);
        };
        watched.set(directory, { close, fail, listener, recursive });
        const on = (_event: string, failure: (error: Error) => void) => {
          failures.push(failure);
        };
        return { close, on } as unknown as FSWatcher;
      },
    );
  };
  const at = (name: string) => path.join(projectDir, name);
  return { at, changes, projectDir, refused, said, start, watched };
}

describe('what `reactive dev` follows', () => {
  it('compiles of a change of the components', () => {
    const { at, changes, start, watched } = followed();

    start();
    watched.get(at('src'))?.listener('change', 'a.tsx');

    expect(watched.get(at('src'))?.recursive).toBe(true);
    expect(changes).toStrictEqual(['compile']);
  });

  it('starts again of the seed, which no compile reads, and of no module beside it', () => {
    const { at, changes, start, watched } = followed();

    start();
    watched.get(at('src'))?.listener('change', 'lib/seed.ts');
    watched.get(at('src'))?.listener('change', 'seed.ts');

    expect(changes).toStrictEqual(['compile', 'start']);
  });

  it('watches no folder of the application twice, but follows one outside the components', () => {
    const inside = followed();
    inside.start();

    expect([...inside.watched.keys()]).toStrictEqual([inside.at('src'), inside.projectDir]);

    const outside = followed({ app: 'app', made: ['app'] });
    outside.start();
    outside.watched.get(outside.at('app'))?.listener('change', 'page.tsx');

    expect(outside.changes).toStrictEqual(['compile']);
  });

  it.each([
    'next.config.ts',
    'next.config.mjs',
    '.env',
    '.env.local',
    '.env.development',
    'tsconfig.json',
  ])('starts again of a change of %s, and of no other file of the root', (name) => {
    const { changes, projectDir, start, watched } = followed();

    start();
    watched.get(projectDir)?.listener('change', 'README.md');
    watched.get(projectDir)?.listener('change', '.next');
    watched.get(projectDir)?.listener('change', 'tsconfig.tsbuildinfo');
    watched.get(projectDir)?.listener('change', name);

    expect(watched.get(projectDir)?.recursive).toBe(false);
    expect(changes).toStrictEqual(['start']);
  });

  it('starts again of a migration', () => {
    const { at, changes, start, watched } = followed({ made: ['drizzle'] });

    start();
    watched.get(at('drizzle'))?.listener('rename', '0001_next.sql');

    expect(watched.get(at('drizzle'))?.recursive).toBe(true);
    expect(changes).toStrictEqual(['start']);
  });

  it('follows the migrations from the first, of an application that had none', () => {
    const { at, changes, projectDir, start, watched } = followed();
    start();

    expect(watched.has(at('drizzle'))).toBe(false);

    mkdirSync(at('drizzle'));
    watched.get(projectDir)?.listener('rename', 'drizzle');
    watched.get(at('drizzle'))?.listener('rename', '0000_first.sql');

    expect(changes).toStrictEqual(['start', 'start']);
  });

  it('says what it may not follow, and follows the rest', () => {
    const { at, changes, projectDir, refused, said, start, watched } = followed();
    refused.add(at('src'));

    start();
    watched.get(projectDir)?.listener('change', '.env');

    expect(said).toHaveBeenCalledWith(expect.stringContaining('ENOSPC'));
    expect(changes).toStrictEqual(['start']);
  });

  it('says what stopped being followed, of no fault of the process', () => {
    const { at, said, start, watched } = followed();
    start();

    watched.get(at('src'))?.fail(new Error('ENOSPC'));

    expect(said).toHaveBeenCalledWith(expect.stringContaining('ENOSPC'));
  });

  it('ends what it follows', () => {
    const { at, projectDir, start, watched } = followed();
    const stop = start();

    stop();

    expect(watched.get(at('src'))?.close).toHaveBeenCalledTimes(1);
    expect(watched.get(projectDir)?.close).toHaveBeenCalledTimes(1);
  });
});
