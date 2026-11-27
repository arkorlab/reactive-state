import { type FSWatcher, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { type Change, followChanges } from '../src/cli/changes.ts';

/**
 * What `reactive dev` follows of an application whose components are the root's own (`src: '.'`,
 * no `src` folder beside the app): the root is watched twice, as the components' folder, through
 * everything under it, and as the root, through its own files alone (the config, `.env`). Both
 * watches are kept, and both are ended as the command ends: one a list overwrote stayed open, and
 * held `reactive dev` alive after its children stopped.
 */

/** One call of `watch`, and what it was given. */
interface Watched {
  readonly directory: string;
  readonly recursive: boolean;
  readonly listener: (event: string, name: string | null) => void;
  readonly close: ReturnType<typeof vi.fn>;
}

/** An application of components in its root, followed by watches that only say what they are given. */
function followed() {
  const projectDir = mkdtempSync(path.join(tmpdir(), 'reactive-root-sources-'));
  onTestFinished(() => {
    rmSync(projectDir, { force: true, recursive: true });
  });
  mkdirSync(path.join(projectDir, 'app'));
  const watched: Watched[] = [];
  const changes: Change[] = [];
  const unfollow = followChanges(
    {
      appDir: path.join(projectDir, 'app'),
      outDir: path.join(projectDir, '.reactive'),
      projectDir,
      srcDir: projectDir,
    },
    (change) => {
      changes.push(change);
    },
    vi.fn(),
    (directory, { recursive }, listener) => {
      const close = vi.fn();
      watched.push({ close, directory, listener, recursive });
      return { close, on: vi.fn() } as unknown as FSWatcher;
    },
  );
  return { changes, projectDir, unfollow, watched };
}

describe('the root of an application whose components are in it', () => {
  it('is watched as the components, and as the root, both kept', () => {
    const { projectDir, watched } = followed();

    expect(watched.map(({ directory, recursive }) => [directory, recursive])).toStrictEqual([
      [projectDir, true],
      [projectDir, false],
    ]);
  });

  it('ends both watches as the command ends', () => {
    const { unfollow, watched } = followed();

    unfollow();

    expect(watched.map(({ close }) => close.mock.calls.length)).toStrictEqual([1, 1]);
  });

  it('tells a change of `.env` as one that starts the authority again, and of a file as a compile', () => {
    const { changes, watched } = followed();
    const [components, root] = watched;

    components?.listener('change', 'hello.reactive.tsx');
    root?.listener('change', '.env');

    expect(changes).toStrictEqual(['compile', 'start']);
  });
});
