import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { compileProject, DIGEST_FILE, LOCK_DIRECTORY } from '../src/next/compile-on-build.ts';

/**
 * A compile lets its lock go however it ends: also where the thread that beats the lock cannot be
 * started, or cannot be stopped. A lock left by a process that lives on names a holder that is not
 * gone, so the next compile of that application waits until the lock has gone unbeaten for its whole
 * stale time. The thread is stood in for: one that cannot start, one that cannot stop.
 */

/** How the thread of a lock's beat fails while a case runs: as it starts, as it stops, or not. */
type Failing = 'start' | 'stop' | undefined;
const thread = vi.hoisted((): { failing: Failing } => ({ failing: undefined }));

vi.mock(import('node:worker_threads'), async (importOriginal) => {
  const actual = await importOriginal();
  class Worker extends actual.Worker {
    constructor(...given: ConstructorParameters<typeof actual.Worker>) {
      if (thread.failing === 'start') {
        throw new Error('no thread could be started');
      }
      super(...given);
    }

    override async terminate(): Promise<number> {
      const code = await super.terminate();
      if (thread.failing === 'stop') {
        throw new Error('the thread could not be stopped');
      }
      return code;
    }
  }
  return { ...actual, Worker };
});

const projects: string[] = [];

/** An application of one component, in a directory of its own. */
function application(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'reactive-state-lock-release-'));
  projects.push(dir);
  mkdirSync(path.join(dir, 'src', 'components'), { recursive: true });
  mkdirSync(path.join(dir, 'src', 'app'));
  writeFileSync(
    path.join(dir, 'src/components/hello.reactive.tsx'),
    'export default function Hello() {\n  return <p>Hello</p>;\n}\n',
  );
  return dir;
}

describe('the lock of a compile whose beat fails', () => {
  afterEach(() => {
    thread.failing = undefined;
    for (const dir of projects.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('is let go where the thread that beats it cannot be started, and the next compile takes it at once', async () => {
    const dir = application();
    thread.failing = 'start';

    await expect(compileProject({ projectDir: dir })).rejects.toThrow('no thread could be started');

    expect(existsSync(path.join(dir, '.reactive', LOCK_DIRECTORY))).toBe(false);
    expect(existsSync(path.join(dir, '.reactive', DIGEST_FILE))).toBe(false);

    thread.failing = undefined;

    await expect(compileProject({ projectDir: dir })).resolves.toMatchObject({ compiled: true });
  });

  it('is let go where that thread cannot be stopped, what the compile wrote in place', async () => {
    const dir = application();
    thread.failing = 'stop';

    await expect(compileProject({ projectDir: dir })).rejects.toThrow(
      'the thread could not be stopped',
    );

    expect(existsSync(path.join(dir, '.reactive', LOCK_DIRECTORY))).toBe(false);
    expect(existsSync(path.join(dir, '.reactive', DIGEST_FILE))).toBe(true);
  });
});
