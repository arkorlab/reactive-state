import { fork, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADAPTER,
  compileProject,
  DIGEST_FILE,
  layoutOf,
  type ProjectOptions,
} from '../next/compile-on-build.ts';
import { type Change, followChanges, followFiles, outsideOf } from './changes.ts';
import type { ProjectRead } from './project.ts';
import { Supervisor } from './supervisor.ts';

/**
 * `reactive dev`: the components compiled, the authority and `next dev` beside it, through the
 * adapter, as a build goes. What the components are compiled of is followed, and the authority
 * started again on the same port and token where that says it is behind, or ended; `next dev` waits
 * for it meanwhile. What the compile is given is read of the application's config, and what the
 * authority is given of its `.env` files, as `next dev` reads them, by a process of its own
 * (`project.ts`); both are read again where they changed.
 */

const SETTINGS = { port: '4011', settleMs: 150, tokenBytes: 32 } as const;
const AUTHORITY = fileURLToPath(new URL('authority.ts', import.meta.url));
const PROJECT = fileURLToPath(new URL('project.ts', import.meta.url));

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * What the application's config and `.env` files say, of `next dev`'s options `args`, until `signal`
 * says it no longer matters, as a config may wait on anything.
 */
export async function readProject(
  projectDir: string,
  args: readonly string[],
  signal: AbortSignal = new AbortController().signal,
): Promise<ProjectRead> {
  const reading = fork(PROJECT, [...args], { cwd: projectDir, killSignal: 'SIGKILL', signal });
  return new Promise((resolve, reject) => {
    reading.once('message', (read) => {
      resolve(read as unknown as ProjectRead);
    });
    reading.once('error', reject);
    reading.once('exit', (code) => {
      reject(new Error(`The application's config was not read: exit code ${String(code)}.`));
    });
  });
}

/** The last compile's record of `project`, whichever process it was of. */
function digestOf(project: ProjectOptions): Readonly<Record<string, unknown>> {
  const record = readFileSync(path.join(layoutOf(project).outDir, DIGEST_FILE), 'utf8');
  return JSON.parse(record) as Readonly<Record<string, unknown>>;
}

/**
 * What the authority runs of `project`, by the last compile's record: what it wrote, and the modules
 * it read, in and out of the application, each by its digest. Not the record's digest of every
 * source, which moves of a module of the browser's alone as well.
 */
function recordOf(project: ProjectOptions): string {
  const { outputs, reads } = digestOf(project);
  return JSON.stringify({ outputs, reads });
}

/** The modules the last compile read that no watch of the application's folders reaches. */
function outsideReadsOf(project: ProjectOptions): string[] {
  const { reads } = digestOf(project);
  return outsideOf(layoutOf(project), Object.keys(reads as Readonly<Record<string, string>>));
}

/**
 * Runs the application's server and authority in `projectDir` until `next dev` ends, which is given
 * `args`.
 */
export async function dev(projectDir: string, args: readonly string[] = []): Promise<void> {
  const reading = new AbortController();
  // A signal before `next dev` runs ends what runs till then, the process that reads the config,
  // and the command with it: nothing else is left to stop.
  const early = (): void => {
    reading.abort();
  };
  process.once('SIGINT', early);
  process.once('SIGTERM', early);
  let read: ProjectRead;
  try {
    read = await readProject(projectDir, args, reading.signal);
  } catch (error) {
    if (reading.signal.aborted) return;
    throw error;
  } finally {
    process.off('SIGINT', early);
    process.off('SIGTERM', early);
  }
  await compileProject(read.project);
  // What the two processes find each other by: `.env`'s, or made, read once, for both. An empty
  // value is one left to be filled in.
  const given = (name: string): string | undefined =>
    [process.env[name], read.env[name]].find((value) => value !== undefined && value !== '');
  const port = given('REACTIVE_ENGINE_PORT') ?? SETTINGS.port;
  const token = given('REACTIVE_ENGINE_TOKEN') ?? randomBytes(SETTINGS.tokenBytes).toString('hex');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REACTIVE_ENGINE_PORT: port,
    REACTIVE_ENGINE_TOKEN: token,
    REACTIVE_ENGINE_URL: `http://127.0.0.1:${port}`,
  };
  // The mode `next dev` runs in, which it sets of none: what the authority runs is the application's
  // own code, its database module, its seed and its operations, which may read it. (Of a type that
  // names the three modes, as Next.js types it.)
  Reflect.set(env, 'NODE_ENV', given('NODE_ENV') ?? 'development');
  const running: {
    read: ProjectRead;
    record: string;
    again: boolean;
    restarting: Promise<void>;
    stopping?: Promise<void>;
    timer?: ReturnType<typeof setTimeout>;
    unfollow: () => void;
    outside: { files: string; unfollow: () => void };
  } = {
    again: false,
    outside: {
      files: '',
      unfollow: () => {
        // Nothing is followed yet.
      },
    },
    read,
    record: recordOf(read.project),
    restarting: Promise.resolve(),
    unfollow: () => {
      // Nothing is followed yet.
    },
  };
  const authority = new Supervisor(() => {
    const { outDir, srcDir } = layoutOf(running.read.project);
    return spawn(process.execPath, [AUTHORITY, outDir, srcDir], {
      cwd: projectDir,
      env: { ...running.read.env, ...env },
      stdio: 'inherit',
    });
  });

  /**
   * Follows the modules the last compile read outside the folders `followChanges` watches, a
   * workspace's package or a folder of the root: they change of an edit that touches no source of
   * the application's. What it follows is what that compile read, so a module it came to read is
   * followed from then on.
   */
  const following = (told: (change: Change) => void): void => {
    const files = outsideReadsOf(running.read.project);
    const key = files.join('\n');
    if (key === running.outside.files) return;
    running.outside.unfollow();
    running.outside = {
      files: key,
      unfollow: followFiles(
        files,
        () => {
          told('compile');
        },
        say,
      ),
    };
  };

  /**
   * Compiles the components again, and starts the authority again where it is behind what is on
   * disk, whoever compiled that, or where it ended; of what it read as it started, whatever then,
   * which may have moved what is followed, or taken a folder a watch held away.
   */
  const restart = async (again: boolean, told: (change: Change) => void): Promise<void> => {
    await running.restarting;
    if (authority.stopped()) return;
    try {
      if (again) {
        running.read = await readProject(projectDir, args, reading.signal);
        if (authority.stopped()) return;
        running.unfollow();
        running.unfollow = followChanges(layoutOf(running.read.project), told, say);
      }
      await compileProject(running.read.project);
      const record = recordOf(running.read.project);
      following(told);
      if (again || record !== running.record || !authority.running) {
        running.record = record;
        await authority.start();
      }
    } catch (error) {
      if (authority.stopped()) return;
      // What it was to start again of still stands, though the sources may come back as they were.
      running.again ||= again;
      say(`[compile] ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  await authority.start();
  const require = createRequire(path.join(projectDir, 'package.json'));
  const nextDir = path.dirname(require.resolve('next/package.json'));
  const next = spawn(process.execPath, [path.join(nextDir, 'dist/bin/next'), 'dev', ...args], {
    cwd: projectDir,
    env: { ...env, NEXT_ADAPTER_PATH: ADAPTER },
    stdio: 'inherit',
  });
  const told = (change: Change): void => {
    running.again ||= change === 'start';
    clearTimeout(running.timer);
    running.timer = setTimeout(() => {
      const { again } = running;
      running.again = false;
      running.restarting = restart(again, told);
    }, SETTINGS.settleMs);
  };
  running.unfollow = followChanges(layoutOf(read.project), told, say);
  following(told);
  const stop = (): void => {
    running.stopping ??= authority.stop();
    next.kill('SIGTERM');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const code = await new Promise<number | null>((resolve) => {
    next.once('exit', resolve);
  });
  // A signal `stop` did not send is a failure of `next dev`'s, which ended it with no code.
  process.exitCode = code ?? (running.stopping === undefined ? 1 : 0);
  const stopped = running.stopping ?? authority.stop();
  reading.abort();
  running.unfollow();
  running.outside.unfollow();
  clearTimeout(running.timer);
  await stopped;
}
