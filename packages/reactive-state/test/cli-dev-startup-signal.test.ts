import { type ChildProcess, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

/**
 * A signal to `reactive dev` while it reads the application's config for the first time ends the
 * reader of the config as well: a config may wait on anything, and the reader keeps the sockets,
 * timers and ports the config opened for as long as it lives.
 */

const REACTIVE = fileURLToPath(new URL('../src/cli/reactive.ts', import.meta.url));
/** Starts Node twice, as long as a second and more under load. */
const TEST_TIMEOUT_MS = 60_000;
const WAIT = { interval: 50, timeout: 30_000 } as const;
/** A config that never answers, and says which process it is. */
const STUCK_CONFIG = String.raw`
const { appendFileSync } = require('node:fs');
exports.default = async () => {
  appendFileSync('reader.log', String(process.pid) + '\n');
  setInterval(() => {}, 1000);
  await new Promise(() => {});
};
`;

/** An application whose config is stuck, in a directory of its own. */
function stuckApplication(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'reactive-signal-'));
  const made = realpathSync(directory);
  onTestFinished(() => {
    rmSync(made, { force: true, recursive: true });
  });
  const files = {
    'node_modules/next/dist/server/config.js': STUCK_CONFIG,
    'node_modules/next/package.json': JSON.stringify({ name: 'next', version: '0.0.0' }),
    'package.json': JSON.stringify({ name: 'application', private: true, type: 'module' }),
  };
  for (const [file, text] of Object.entries(files)) {
    const at = path.join(made, file);
    mkdirSync(path.dirname(at), { recursive: true });
    writeFileSync(at, text);
  }
  return made;
}

/** Whether the process `pid` runs. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Answers the exit code of `child` once it ended. */
async function ended(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise((resolve) => {
    child.once('exit', resolve);
  });
}

describe('`reactive dev` of a config that is read for the first time', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)(
    'ends the reader of the config, and itself, of a %s',
    async (signal) => {
      const root = stuckApplication();
      const reads = path.join(root, 'reader.log');
      const child = spawn(process.execPath, [REACTIVE, 'dev'], {
        cwd: root,
        env: { ...process.env, DATABASE_URL: '' },
        stdio: 'ignore',
      });
      const readers = (): number[] => {
        if (!existsSync(reads)) return [];
        return readFileSync(reads, 'utf8').split('\n').filter(Boolean).map(Number);
      };
      onTestFinished(async () => {
        child.kill('SIGKILL');
        await ended(child);
        for (const pid of readers()) if (alive(pid)) process.kill(pid, 'SIGKILL');
      });
      await vi.waitFor(() => {
        expect(readers()).toHaveLength(1);
      }, WAIT);

      child.kill(signal);

      await expect(ended(child)).resolves.toBe(0);

      await vi.waitFor(() => {
        expect(alive(readers()[0] ?? 0)).toBe(false);
      }, WAIT);
    },
    TEST_TIMEOUT_MS,
  );
});
