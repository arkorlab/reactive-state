import { type ChildProcess, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { readProject } from '../src/cli/dev.ts';
import { LOADER } from '../src/next/config.ts';

/**
 * `reactive dev` whole, of a small application, its compile and its authority real, and of a `next`
 * that only says how it was run: what the real one does beside them is the fixture's to show.
 */

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const REACTIVE = path.join(PACKAGE, 'src/cli/reactive.ts');
/** A run starts Node three times and compiles, as long as a second and more under load. */
const TEST_TIMEOUT_MS = 60_000;
const WAIT = { interval: 50, timeout: 30_000 } as const;
/** Longer than a change takes to reach a compile that finds nothing to do. */
const SETTLED_MS = 1500;
const COMPONENT = 'src/components/hello.reactive.tsx';
/** Says `.env` holds the port, so that none is given the process. */
const PORT_IN_ENV_FILE = 'port.in-env';
/** A module that keeps Drizzle from the process, as of an application without the optional peer. */
const NO_DRIZZLE = `
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('drizzle-orm')) throw new Error('This application has no drizzle-orm.');
    return next(specifier, context);
  },
});
`;
const HELLO = [
  'export default function Hello({ name }: { readonly name: string }) {',
  '  return <p>Hello, {name}</p>;',
  '}',
  '',
].join('\n');
/** Says each start of the authority, as the module the application's database is. */
const DB = [
  "import { appendFileSync } from 'node:fs';",
  "import { database } from '@arkorlab/reactive-state/server';",
  'const { FROM_FILE: file, REACTIVE_ENGINE_TOKEN: token, REACTIVE_ENGINE_URL: url } = process.env;',
  'const start = { file, pid: process.pid, token, url };',
  String.raw`appendFileSync('starts.log', JSON.stringify(start) + '\n');`,
  String.raw`process.on('exit', (code) => appendFileSync('exits.log', code + '\n'));`,
  'export const db = database({});',
  '',
].join('\n');
/** What `next dev`'s config reading does that matters here: `.env`, then what a test asks. */
const LOAD_CONFIG = String.raw`
const { appendFileSync, existsSync, readFileSync } = require('node:fs');
const SOURCES = '*.reactive.tsx';
const LOADER = ${JSON.stringify(LOADER)};
const options = (src) => ({ out: '.reactive', root: process.cwd(), src });
exports.default = async () => {
  if (existsSync('.env')) {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const [name, value] = line.split('=');
      if (name !== '' && process.env[name] === undefined) process.env[name] = value;
    }
  }
  process.env.SEEN = JSON.stringify([process.env.NODE_ENV, process.env.TURBOPACK ?? null]);
  if (existsSync('config.throws')) throw new Error('The config failed.');
  if (existsSync('config.stuck')) {
    appendFileSync('stuck.log', JSON.stringify({ pid: process.pid }) + '\n');
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  if (existsSync('config.slow')) {
    appendFileSync('reads.log', '1\n');
    await new Promise((resolve) => { setTimeout(resolve, 1000); });
  }
  if (existsSync('config.holds')) {
    process.env.HOLDER = String(process.pid);
    setInterval(() => {}, 1000);
  }
  if (!existsSync('next.config.ts')) return {};
  const src = readFileSync('next.config.ts', 'utf8');
  return { turbopack: { rules: { [SOURCES]: { loaders: [{ loader: LOADER, options: options(src) }] } } } };
};
`;
/** Says how it was run, and runs until it is told to stop. */
const NEXT = `
const { appendFileSync, existsSync } = require('node:fs');
appendFileSync('next.log', JSON.stringify({
  adapter: process.env.NEXT_ADAPTER_PATH !== undefined,
  argv: process.argv.slice(2),
  file: process.env.FROM_FILE ?? null,
  pid: process.pid,
  token: process.env.REACTIVE_ENGINE_TOKEN,
  url: process.env.REACTIVE_ENGINE_URL,
}) + '\\n');
if (!existsSync('next.dies')) {
  process.on('SIGTERM', () => {
    if (!existsSync('next.slow')) process.exit(0);
  });
}
setInterval(() => {}, 1000);
`;

/** An application of one component, its first `.env` and `files` over them, in a directory of its own. */
function application(files: Readonly<Record<string, string>> = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'reactive-run-'));
  const made = realpathSync(directory);
  const root = path.join(made, 'application');
  onTestFinished(() => {
    rmSync(made, { force: true, recursive: true });
  });
  const all = {
    '.env': 'FROM_FILE=one\n',
    'node_modules/next/dist/bin/next': NEXT,
    'node_modules/next/dist/server/config.js': LOAD_CONFIG,
    'node_modules/next/package.json': JSON.stringify({ name: 'next', version: '0.0.0' }),
    'package.json': JSON.stringify({ name: 'application', private: true, type: 'module' }),
    'src/app/page.tsx': 'export default function Page() {\n  return null;\n}\n',
    'src/db.ts': DB,
    [COMPONENT]: HELLO,
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        jsx: 'react-jsx',
        paths: { '@/*': ['./src/*'], '@shared/*': ['../shared/*'] },
      },
    }),
    ...files,
  };
  for (const [file, text] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  mkdirSync(path.join(root, 'node_modules/@arkorlab'), { recursive: true });
  symlinkSync(PACKAGE, path.join(root, 'node_modules/@arkorlab/reactive-state'));
  return root;
}

/** A port no one holds. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => {
    server.close(resolve);
  });
  return port;
}

/** The JSON lines of `file` of `root`, none where it is not there yet. */
function linesOf<T>(root: string, file: string): T[] {
  const at = path.join(root, file);
  if (!existsSync(at)) return [];
  return readFileSync(at, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as T);
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

/** Answers once `child` ended. */
async function ended(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    child.once('exit', resolve);
  });
}

interface Start {
  readonly file?: string;
  readonly pid: number;
  readonly token?: string;
  readonly url?: string;
}

/** `reactive dev` of `root`, once it runs `next dev` and an authority started: `given` over the rest. */
async function run(
  root: string,
  args: readonly string[] = [],
  given: Readonly<Record<string, string>> = {},
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REACTIVE_ENGINE_PORT: String(await freePort()),
    ...given,
  };
  delete env['DATABASE_URL'];
  delete env['REACTIVE_ENGINE_TOKEN'];
  if (existsSync(path.join(root, PORT_IN_ENV_FILE))) delete env['REACTIVE_ENGINE_PORT'];
  const child = spawn(process.execPath, [REACTIVE, 'dev', ...args], {
    cwd: root,
    env,
    stdio: 'ignore',
  });
  const starts = () => linesOf<Start>(root, 'starts.log');
  onTestFinished(async () => {
    child.kill('SIGKILL');
    await ended(child);
    for (const { pid } of starts()) if (alive(pid)) process.kill(pid, 'SIGKILL');
    for (const { pid } of linesOf<Start>(root, 'next.log')) {
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
    for (const { pid } of linesOf<Start>(root, 'stuck.log')) {
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  });
  await vi.waitFor(() => {
    expect(starts()).toHaveLength(1);
    expect(linesOf(root, 'next.log')).toHaveLength(1);
  }, WAIT);
  // A change of just before the watch may be told after it, on macOS.
  await sleep(SETTLED_MS);
  return { child, starts };
}

/** The mode and the bundler a config was read under. */
async function seen(args: readonly string[]): Promise<unknown> {
  const { env } = await readProject(application(), args);
  return JSON.parse(env['SEEN'] ?? '');
}

describe('`reactive dev`', () => {
  it(
    "runs `next dev` of the options it is given, through the adapter, and leaves it `.env`'s to read",
    async () => {
      const root = application();

      const { starts } = await run(root, ['--port', '3100']);

      expect(linesOf(root, 'next.log')).toMatchObject([
        { adapter: true, argv: ['dev', '--port', '3100'], file: null },
      ]);
      expect(starts()[0]?.file).toBe('one');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'starts the authority again of a component that changed',
    async () => {
      const root = application();
      const { starts } = await run(root);

      writeFileSync(path.join(root, COMPONENT), `${HELLO}// Changed.\n`);

      await expect.poll(starts, WAIT).toHaveLength(2);

      expect(alive(starts()[0]?.pid ?? 0)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "starts the authority again of the database's module, which changes nothing the compile writes",
    async () => {
      const root = application();
      const { starts } = await run(root);

      writeFileSync(path.join(root, 'src/db.ts'), `${DB}// Changed.\n`);

      await expect.poll(starts, WAIT).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'starts the authority again of `tsconfig.json`, which it reads its paths of as it starts',
    async () => {
      const root = application();
      const { starts } = await run(root);
      const file = path.join(root, 'tsconfig.json');

      writeFileSync(file, `${readFileSync(file, 'utf8')}\n`);

      await expect.poll(starts, WAIT).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'leaves the authority as it is of a change that compiles nothing',
    async () => {
      const root = application();
      const { starts } = await run(root);

      writeFileSync(path.join(root, 'src/notes.txt'), 'Nothing the compile reads.\n');
      await sleep(SETTLED_MS);

      expect(starts()).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'leaves the authority as it is of a source no component imports, as of the browser alone',
    async () => {
      const root = application();
      const { starts } = await run(root);

      writeFileSync(path.join(root, 'src/browser.ts'), 'export const BROWSER = 1;\n');
      await sleep(SETTLED_MS);

      expect(starts()).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'starts an authority that ended, of any change, as a fix may be none the compile reads',
    async () => {
      const root = application();
      const { starts } = await run(root);
      process.kill(starts()[0]?.pid ?? 0, 'SIGKILL');

      writeFileSync(path.join(root, 'src/notes.txt'), 'Nothing the compile reads.\n');

      await expect.poll(starts, WAIT).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reads `.env` again, and gives the authority what it says',
    async () => {
      const root = application();
      const { starts } = await run(root);

      writeFileSync(path.join(root, '.env'), 'FROM_FILE=two\n');

      await expect.poll(starts, WAIT).toHaveLength(2);

      expect(starts()[1]?.file).toBe('two');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'starts the authority of what it read, though a compile failed as it did',
    async () => {
      const root = application();
      const { starts } = await run(root);

      writeFileSync(path.join(root, COMPONENT), 'export const notAComponent = 1;\n');
      writeFileSync(path.join(root, '.env'), 'FROM_FILE=two\n');
      await sleep(SETTLED_MS);

      expect(starts()).toHaveLength(1);

      writeFileSync(path.join(root, COMPONENT), HELLO);

      await expect.poll(starts, WAIT).toHaveLength(2);

      expect(starts()[1]?.file).toBe('two');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'starts the authority again of a migration, of an application that had none',
    async () => {
      const root = application();
      const { starts } = await run(root);

      mkdirSync(path.join(root, 'drizzle'));

      await expect.poll(starts, WAIT).toHaveLength(2);

      writeFileSync(path.join(root, 'drizzle/0000_first.sql'), 'SELECT 1;\n');

      await expect.poll(starts, WAIT).toHaveLength(3);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'follows migrations made again, as a watch of the folder that went hears nothing',
    async () => {
      const root = application();
      mkdirSync(path.join(root, 'drizzle'));
      const { starts } = await run(root);

      rmSync(path.join(root, 'drizzle'), { recursive: true });

      await expect.poll(starts, WAIT).toHaveLength(2);

      mkdirSync(path.join(root, 'drizzle'));

      await expect.poll(starts, WAIT).toHaveLength(3);

      writeFileSync(path.join(root, 'drizzle/0000_first.sql'), 'SELECT 1;\n');

      await expect.poll(starts, WAIT).toHaveLength(4);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'follows the components to where a config moves them',
    async () => {
      const root = application({
        'lib/app/page.tsx': 'export default function Page() {\n  return null;\n}\n',
        'lib/components/hello.reactive.tsx': HELLO,
        'next.config.ts': 'src',
      });
      const { starts } = await run(root);

      writeFileSync(path.join(root, 'next.config.ts'), 'lib');

      await expect.poll(starts, WAIT).toHaveLength(2);

      writeFileSync(path.join(root, 'lib/components/hello.reactive.tsx'), `${HELLO}// Changed.\n`);

      await expect.poll(starts, WAIT).toHaveLength(3);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'gives both what `.env` says of the engine, as `next dev` calls the authority by them',
    async () => {
      const port = await freePort();
      const root = application({
        '.env': `REACTIVE_ENGINE_TOKEN=from-file\nREACTIVE_ENGINE_PORT=${String(port)}\n`,
        [PORT_IN_ENV_FILE]: '',
      });

      const { starts } = await run(root);

      const expected = { token: 'from-file', url: `http://127.0.0.1:${String(port)}` };

      expect(starts()[0]).toMatchObject(expected);
      expect(linesOf(root, 'next.log')).toMatchObject([expected]);

      writeFileSync(path.join(root, '.env'), 'REACTIVE_ENGINE_TOKEN=another\n');

      await expect.poll(starts, WAIT).toHaveLength(2);

      expect(starts()[1]).toMatchObject(expected);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'takes an empty value of the engine as none, as `.env` may leave one to be filled in',
    async () => {
      const root = application({ '.env': 'REACTIVE_ENGINE_TOKEN=\n' });

      const { starts } = await run(root);

      const [start] = starts();

      expect(start?.token).toMatch(/^[0-9a-f]{64}$/u);
      expect(linesOf(root, 'next.log')).toMatchObject([{ token: start?.token }]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'runs an application without Drizzle, the optional peer it is',
    async () => {
      const root = application({ 'no-drizzle.mjs': NO_DRIZZLE });

      const { starts } = await run(root, [], { NODE_OPTIONS: '--import ./no-drizzle.mjs' });

      expect(starts()).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'says `next dev` failed where a signal it did not send ended it',
    async () => {
      const root = application();
      const { child } = await run(root);
      const [next] = linesOf<Start>(root, 'next.log');

      process.kill(next?.pid ?? 0, 'SIGKILL');
      await ended(child);

      expect(child.exitCode).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'ends well where the signal it sent ended `next dev`',
    async () => {
      const root = application({ 'next.dies': '' });
      const { child } = await run(root);

      child.kill('SIGTERM');
      await ended(child);

      expect(child.exitCode).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'stops though it was reading the config again, which would follow what no one ends',
    async () => {
      const root = application({ 'config.slow': '' });
      const { child } = await run(root);

      writeFileSync(path.join(root, '.env'), 'FROM_FILE=two\n');

      await expect.poll(() => linesOf(root, 'reads.log'), WAIT).toHaveLength(2);

      child.kill('SIGTERM');
      await ended(child);

      expect(child.exitCode).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'ends a reading of the config that never ends, as it would hold the command',
    async () => {
      const root = application();
      const { child } = await run(root);

      writeFileSync(path.join(root, 'config.stuck'), '');
      writeFileSync(path.join(root, '.env'), 'FROM_FILE=two\n');

      await expect.poll(() => linesOf(root, 'stuck.log'), WAIT).toHaveLength(1);

      const [reading] = linesOf<Start>(root, 'stuck.log');
      child.kill('SIGTERM');
      await ended(child);

      expect(child.exitCode).toBe(0);
      expect(alive(reading?.pid ?? 0)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'starts the authority again of a module out of the application, as a change finds it',
    async () => {
      const root = application({
        '../shared/greeting.ts': "export const GREETING = 'Hello';\n",
        [COMPONENT]: [
          "import { GREETING } from '@shared/greeting';",
          '',
          'export default function Hello({ name }: { readonly name: string }) {',
          '  return <p>{GREETING}, {name}</p>;',
          '}',
          '',
        ].join('\n'),
      });
      const { starts } = await run(root);

      writeFileSync(path.join(root, '../shared/greeting.ts'), "export const GREETING = 'Hi';\n");
      writeFileSync(path.join(root, 'src/notes.txt'), 'Nothing the compile reads.\n');

      await expect.poll(starts, WAIT).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'ends what it runs as it is told to stop',
    async () => {
      const root = application();
      const { child, starts } = await run(root);

      child.kill('SIGTERM');
      await ended(child);

      expect(child.exitCode).toBe(0);
      expect(alive(starts()[0]?.pid ?? 0)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'stops the authority without waiting for `next dev`, which takes its time',
    async () => {
      const root = application({ 'next.slow': '' });
      const { child, starts } = await run(root);

      child.kill('SIGTERM');

      await expect.poll(() => alive(starts()[0]?.pid ?? 0), WAIT).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "restarts past what the application's module holds, which would keep the process",
    async () => {
      const root = application({ 'src/db.ts': `${DB}setInterval(() => {}, 1000);\n` });
      const { starts } = await run(root);

      writeFileSync(path.join(root, COMPONENT), `${HELLO}// Changed.\n`);

      await expect.poll(starts, WAIT).toHaveLength(2);

      // Of itself as it closed: one that took too long ends otherwise, and one killed says nothing.
      expect(linesOf(root, 'exits.log')).toStrictEqual([0]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'stops an authority whose start never ends',
    async () => {
      const root = application({
        'src/db.ts': `${DB}setInterval(() => {}, 1000);\nawait new Promise(() => {});\n`,
      });
      const { child, starts } = await run(root);

      child.kill('SIGTERM');
      await ended(child);

      expect(alive(starts()[0]?.pid ?? 0)).toBe(false);
      // Of itself: one killed says nothing.
      expect(linesOf(root, 'exits.log')).toStrictEqual([1]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('what `reactive dev` reads of the config', () => {
  it(
    'reads it as `next dev` does, which refuses what another mode or bundler does not allow',
    async () => {
      await expect(seen([])).resolves.toStrictEqual(['development', 'auto']);
      await expect(seen(['--webpack'])).resolves.toStrictEqual(['development', null]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'answers what `.env` adds, and the application as the config says',
    async () => {
      const root = application();

      const { env, project } = await readProject(root, []);

      expect(env['FROM_FILE']).toBe('one');
      expect(env['PATH']).toBeUndefined();
      expect(project).toStrictEqual({ projectDir: root });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'ends though the config left something running',
    async () => {
      const root = application({ 'config.holds': '' });

      const { env } = await readProject(root, []);

      await expect.poll(() => alive(Number(env['HOLDER'])), WAIT).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'says where the config failed',
    async () => {
      const root = application({ 'config.throws': '' });

      await expect(readProject(root, [])).rejects.toThrow("The application's config was not read");
    },
    TEST_TIMEOUT_MS,
  );
});
