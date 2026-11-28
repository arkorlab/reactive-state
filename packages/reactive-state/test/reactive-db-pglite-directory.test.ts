import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, it, onTestFinished } from 'vitest';

import { hostOf } from '../src/authority/database-host.ts';
import { reactiveDb } from '../src/sql/db.ts';

/**
 * A PGlite directory is one process's: a second that opened it would write over what the first keeps
 * in memory, and neither could open it again. `reactiveDb` of a directory says so, rather than
 * opens it, whether the other is a `reactive dev` still running or an earlier evaluation of the
 * application's `db` module.
 */

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const schema = { tasks: pgTable('tasks', { id: text().primaryKey() }) };
/** Each test makes a PGlite of its own, as long as a second and more under load. */
const TEST_TIMEOUT_MS = 30_000;
/** What a process of its own does with the directory: opens it, says so, and holds it until it ends. */
const HOLDER = `
import { pgTable, text } from 'drizzle-orm/pg-core';
import { reactiveDb } from './src/sql/db.ts';
await reactiveDb({ tasks: pgTable('tasks', { id: text().primaryKey() }) });
process.stdout.write('opened\\n');
setInterval(() => {}, 1000);
`;

/** A directory for the PGlite, which `PGLITE_DIR` names for the test. */
function directory(): string {
  const made = mkdtempSync(path.join(tmpdir(), 'reactive-pglite-'));
  const previous = process.env['PGLITE_DIR'];
  const at = path.join(made, 'pglite');
  process.env['PGLITE_DIR'] = at;
  onTestFinished(() => {
    if (previous === undefined) delete process.env['PGLITE_DIR'];
    else process.env['PGLITE_DIR'] = previous;
    rmSync(made, { force: true, recursive: true });
  });
  return at;
}

/** Answers once `child` ended. */
async function ended(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    child.once('exit', resolve);
  });
}

describe('a PGlite directory', () => {
  it(
    'is opened by one `reactiveDb` at a time of a process, and again once its host closed',
    async () => {
      directory();
      delete process.env['DATABASE_URL'];
      const first = await reactiveDb(schema);

      await expect(reactiveDb(schema)).rejects.toThrow(/open already/u);

      await hostOf(first.db)?.close();
      const again = await reactiveDb(schema);
      await hostOf(again.db)?.close();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is refused to a process while another holds it, and is free once that one ended',
    async () => {
      directory();
      delete process.env['DATABASE_URL'];
      const holder = spawn(process.execPath, ['--input-type=module', '-e', HOLDER], {
        cwd: PACKAGE,
        env: process.env,
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      onTestFinished(async () => {
        holder.kill('SIGKILL');
        await ended(holder);
      });
      await new Promise<void>((resolve, reject) => {
        holder.stdout.once('data', () => {
          resolve();
        });
        holder.once('exit', () => {
          reject(new Error('The holder ended before it opened the directory.'));
        });
      });

      await expect(reactiveDb(schema)).rejects.toThrow(/open already/u);

      holder.kill('SIGKILL');
      await ended(holder);
      const { db } = await reactiveDb(schema);
      await hostOf(db)?.close();
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    ['with a slash at its end', (at: string) => `${at}/`],
    ['by a path from the working directory', (at: string) => path.relative(process.cwd(), at)],
    [
      'by a link to it',
      (at: string) => {
        const link = `${at}-link`;
        symlinkSync(at, link);
        return link;
      },
    ],
  ])(
    'is one directory whatever it is called by: %s',
    async (_said, spelled) => {
      const at = directory();
      delete process.env['DATABASE_URL'];
      const first = await reactiveDb(schema);
      process.env['PGLITE_DIR'] = spelled(at);

      await expect(reactiveDb(schema)).rejects.toThrow(/open already/u);

      await expect(hostOf(first.db)?.close()).resolves.toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is named by a URL of PGlite alone, which no lock stands for',
    async () => {
      const previous = process.env['PGLITE_DIR'];
      process.env['PGLITE_DIR'] = 'memory://';
      delete process.env['DATABASE_URL'];
      onTestFinished(() => {
        if (previous === undefined) delete process.env['PGLITE_DIR'];
        else process.env['PGLITE_DIR'] = previous;
      });

      const first = await reactiveDb(schema);
      const second = await reactiveDb(schema);

      await expect(hostOf(first.db)?.close()).resolves.toBeUndefined();
      await expect(hostOf(second.db)?.close()).resolves.toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );
});
