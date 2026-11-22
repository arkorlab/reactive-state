import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  abandoned,
  beating,
  compileProject,
  DIGEST_FILE,
  layoutOf,
  LOCK_DIRECTORY,
  LOCK_STALE_MS,
  type ProjectCompile,
  reclaim,
} from '../src/next/compile-on-build.ts';

/**
 * The compile a build runs before Next.js reads the application, and a platform's command before
 * it starts the authority: run where what it reads changed, one process at a time, written whole.
 * Each case compiles an application of one component of its own.
 */

const HELLO = [
  'export default function Hello({ name }: { readonly name: string }) {',
  '  return <p>Hello, {name}</p>;',
  '}',
  '',
].join('\n');
const PAGE = [
  "import Hello from '@/components/hello.reactive';",
  '',
  'export default function Page() {',
  '  return <Hello name="world" />;',
  '}',
  '',
].join('\n');
/** A page of a route of one param, which the component is given: one view for every visitor. */
const GREETING_PAGE = [
  "import Hello from '@/components/hello.reactive';",
  '',
  'export default async function Page({ params }: { params: Promise<{ name: string }> }) {',
  '  const { name } = await params;',
  '  return <Hello name={name} />;',
  '}',
  '',
].join('\n');
/** The component, its greeting read from a module in a hidden directory of the application's. */
const GREETED = [
  "import { GREETING } from '@/.generated/greeting';",
  '',
  'export default function Hello({ name }: { readonly name: string }) {',
  '  return <p>{GREETING}, {name}</p>;',
  '}',
  '',
].join('\n');
/** The component, its greeting read through an alias from a module out of the application. */
const SHARED_GREETED = GREETED.replace('@/.generated/greeting', '@shared/greeting');
/** What the compiler refuses: a component file without its component. */
const NO_COMPONENT = 'export const notAComponent = 1;\n';
/** Long enough for a compile that waits on another's lock to be seen waiting. */
const HELD_MS = 300;
const MS_PER_SECOND = 1000;

const projects: string[] = [];

/** An application with `files` (paths from its root) over its one component and page. */
function application(files: Readonly<Record<string, string>> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'reactive-state-compile-'));
  projects.push(dir);
  const all = {
    'src/app/page.tsx': PAGE,
    'src/components/hello.reactive.tsx': HELLO,
    'tsconfig.json': JSON.stringify({
      compilerOptions: { jsx: 'react-jsx', paths: { '@/*': ['./src/*'] } },
    }),
    ...files,
  };
  for (const [file, text] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

/**
 * A lock of another process's in `dir`'s output directory, its holder's file named `id`: taken, or
 * last beaten, `ageMs` ago; naming its holder as `holder` does, as no holder at all unless said.
 */
function lockedBy(
  dir: string,
  ageMs: number,
  holder = 'another process\n',
  id = 'another',
): string {
  const file = path.join(dir, '.reactive', LOCK_DIRECTORY, id);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, holder);
  const taken = (Date.now() - ageMs) / MS_PER_SECOND;
  utimesSync(file, taken, taken);
  return file;
}

/** The id of a process of this host that ran and is gone. */
function gonePid(): number {
  const { pid } = spawnSync(process.execPath, ['-e', '']);
  return pid;
}

/** Holds this thread for `ms`, as a compile that takes as long holds its process's. */
function holdThread(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // Nothing else runs on this thread meanwhile.
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function removeProjects(): void {
  for (const dir of projects.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
}

describe('compileProject', () => {
  afterEach(removeProjects);

  it('compiles the components, and skips the compile while nothing it reads changed', async () => {
    const dir = application();

    const first = await compileProject({ projectDir: dir });
    const again = await compileProject({ projectDir: dir });

    expect(first).toMatchObject({ changed: true, compiled: true, srcDir: path.join(dir, 'src') });
    expect(existsSync(path.join(dir, '.reactive', 'manifest.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'src/app/api/reactive-state/[...path]/route.ts'))).toBe(true);
    expect(existsSync(path.join(dir, '.reactive', DIGEST_FILE))).toBe(true);
    expect(existsSync(path.join(dir, '.reactive', LOCK_DIRECTORY))).toBe(false);
    expect(again).toMatchObject({ changed: false, compiled: false });
  });

  it('compiles again where a source changed, inside the components’ directory or out of it', async () => {
    const dir = application();
    await compileProject({ projectDir: dir });

    writeFileSync(
      path.join(dir, 'src/components/hello.reactive.tsx'),
      HELLO.replace('Hello,', 'Hi,'),
    );
    const component = await compileProject({ projectDir: dir });
    writeFileSync(path.join(dir, 'db.ts'), 'export const db = {};\n');
    const outside = await compileProject({ projectDir: dir });

    expect(component).toMatchObject({ changed: true, compiled: true });
    expect(
      readFileSync(path.join(dir, '.reactive/components/hello.authority.mts'), 'utf8'),
    ).toContain('Hi,');
    expect(outside).toMatchObject({ changed: false, compiled: true });
  });

  it('compiles again where a page is added under a folder out of the application the app directory links to, and walks a link back to a folder along the way no further', async () => {
    const linked = mkdtempSync(path.join(tmpdir(), 'reactive-state-linked-'));
    projects.push(linked);
    const dir = application({
      'src/components/greeting.reactive.tsx': HELLO.replace('function Hello', 'function Greeting'),
    });
    symlinkSync(linked, path.join(dir, 'src/app/linked'), 'dir');
    // A link to the folder it is in, which a walk that follows links would follow without end.
    symlinkSync(linked, path.join(linked, 'self'), 'dir');
    await compileProject({ projectDir: dir });

    mkdirSync(path.join(linked, 'greeting/[name]'), { recursive: true });
    writeFileSync(
      path.join(linked, 'greeting/[name]/page.tsx'),
      GREETING_PAGE.replaceAll('hello.reactive', 'greeting.reactive'),
    );
    const added = await compileProject({ projectDir: dir });
    const manifest = JSON.parse(
      readFileSync(path.join(dir, '.reactive/manifest.json'), 'utf8'),
    ) as { readonly routes?: readonly { readonly route: string }[] };

    expect(added).toMatchObject({ compiled: true });
    expect(manifest.routes?.map((each) => each.route)).toContain('/linked/greeting/[name]');
  });

  it('compiles again where a source in a hidden directory changed, and not where a build or a tool wrote', async () => {
    const greeting = 'src/.generated/greeting.ts';
    const dir = application({
      [greeting]: "export const GREETING = 'Hello';\n",
      'src/components/hello.reactive.tsx': GREETED,
    });
    await compileProject({ projectDir: dir });

    writeFileSync(path.join(dir, greeting), "export const GREETING = 'Hi';\n");
    const hidden = await compileProject({ projectDir: dir });
    for (const written of ['.next/server/app/page.js', '.state/state.json', '.turbo/cache.json']) {
      mkdirSync(path.dirname(path.join(dir, written)), { recursive: true });
      writeFileSync(path.join(dir, written), 'export {};\n');
    }
    const tools = await compileProject({ projectDir: dir });

    expect(hidden).toMatchObject({ compiled: true });
    expect(tools).toMatchObject({ changed: false, compiled: false });
  });

  it('compiles again where a module out of the application an alias leads to changed, or a configuration it extends', async () => {
    const shared = mkdtempSync(path.join(tmpdir(), 'reactive-state-shared-'));
    projects.push(shared);
    const greeting = path.join(shared, 'greeting.ts');
    const base = path.join(shared, 'tsconfig.base.json');
    writeFileSync(greeting, "export const GREETING = 'Hello';\n");
    const dir = application({
      'src/components/hello.reactive.tsx': SHARED_GREETED,
      'tsconfig.json': JSON.stringify({ compilerOptions: { jsx: 'react-jsx' }, extends: base }),
    });
    const paths = { '@/*': [path.join(dir, 'src', '*')], '@shared/*': ['./*'] };
    writeFileSync(base, JSON.stringify({ compilerOptions: { paths } }));
    const first = await compileProject({ projectDir: dir });
    const again = await compileProject({ projectDir: dir });

    writeFileSync(greeting, "export const GREETING = 'Hi';\n");
    const aliased = await compileProject({ projectDir: dir });
    const settled = await compileProject({ projectDir: dir });
    const unused = { ...paths, '@unused/*': ['./unused/*'] };
    writeFileSync(base, JSON.stringify({ compilerOptions: { paths: unused } }));
    const extended = await compileProject({ projectDir: dir });

    expect(first).toMatchObject({ changed: true, compiled: true });
    expect(again).toMatchObject({ compiled: false });
    expect(aliased).toMatchObject({ changed: true, compiled: true });
    expect(settled).toMatchObject({ compiled: false });
    expect(extended).toMatchObject({ changed: false, compiled: true });
  });

  it('compiles again where what it wrote was changed or taken away, and puts it back', async () => {
    const dir = application();
    await compileProject({ projectDir: dir });
    const route = path.join(dir, 'src/app/api/reactive-state/[...path]/route.ts');
    const manifest = path.join(dir, '.reactive/manifest.json');
    const written = readFileSync(manifest, 'utf8');

    rmSync(route);
    const restored = await compileProject({ projectDir: dir });
    writeFileSync(manifest, '{}\n');
    const rewritten = await compileProject({ projectDir: dir });

    expect(restored).toMatchObject({ changed: true, compiled: true });
    expect(existsSync(route)).toBe(true);
    expect(rewritten).toMatchObject({ changed: true, compiled: true });
    expect(readFileSync(manifest, 'utf8')).toBe(written);
  });

  it('compiles once for two callers at once: the second finds what the first wrote', async () => {
    const dir = application();

    const both = await Promise.all([
      compileProject({ projectDir: dir }),
      compileProject({ projectDir: dir }),
    ]);

    expect(both.filter(({ compiled }) => compiled)).toHaveLength(1);
  });

  it('waits for the lock another process holds, and takes one a process left behind', async () => {
    const held = application();
    const left = application();
    const holding = lockedBy(held, 0);
    const leftBehind = lockedBy(left, LOCK_STALE_MS + HELD_MS);

    let finished: ProjectCompile | undefined;
    const waiting = (async () => {
      finished = await compileProject({ projectDir: held });
      return finished;
    })();
    await delay(HELD_MS);
    const waited = finished;
    rmSync(holding);

    expect(waited).toBeUndefined();
    await expect(waiting).resolves.toMatchObject({ compiled: true });
    await expect(compileProject({ projectDir: left })).resolves.toMatchObject({ compiled: true });
    expect(existsSync(leftBehind)).toBe(false);
  });

  it('takes at once a lock whose holder, a process of this host, is gone, and waits for one whose holder is not', async () => {
    const left = application();
    const held = application();
    const leftBehind = lockedBy(left, 0, `${String(gonePid())} ${hostname()} x\n`);
    const holding = lockedBy(held, 0, `${String(process.pid)} ${hostname()} x\n`);

    await expect(compileProject({ projectDir: left })).resolves.toMatchObject({ compiled: true });
    expect(existsSync(leftBehind)).toBe(false);

    let finished: ProjectCompile | undefined;
    const waiting = (async () => {
      finished = await compileProject({ projectDir: held });
      return finished;
    })();
    await delay(HELD_MS);
    const waited = finished;
    rmSync(holding);

    expect(waited).toBeUndefined();
    await expect(waiting).resolves.toMatchObject({ compiled: true });
  });

  it('takes away only what it found left behind of a lock: never the lock another process that found the same took since', async () => {
    const dir = application();
    const leftBehind = lockedBy(dir, 0, `${String(gonePid())} ${hostname()} x\n`);
    const lock = path.dirname(leftBehind);
    // Two processes find the same lock left behind, and one takes it away and takes the lock.
    const found = abandoned(lock);
    const first = reclaim(lock, found);
    const holding = lockedBy(dir, 0, `${String(process.pid)} ${hostname()} y\n`, 'taken-since');
    // The other, late: what it found is gone, and the lock taken since is left as it is.
    const late = reclaim(lock, found);

    expect(found).toStrictEqual([leftBehind]);
    expect([first, late]).toStrictEqual([true, false]);
    expect(existsSync(holding)).toBe(true);

    // Waited for, as any lock held is.
    let finished: ProjectCompile | undefined;
    const waiting = (async () => {
      finished = await compileProject({ projectDir: dir });
      return finished;
    })();
    await delay(HELD_MS);
    const waited = finished;
    rmSync(lock, { recursive: true });

    expect(waited).toBeUndefined();
    await expect(waiting).resolves.toMatchObject({ compiled: true });
  });

  it('takes a lock an earlier version left behind as a file, and waits for one whose holder is alive', async () => {
    const left = application();
    const held = application();
    const leftBehind = path.join(left, '.reactive', LOCK_DIRECTORY);
    const holding = path.join(held, '.reactive', LOCK_DIRECTORY);
    for (const [file, pid] of [
      [leftBehind, gonePid()],
      [holding, process.pid],
    ] as const) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${String(pid)} ${hostname()} x\n`);
    }

    await expect(compileProject({ projectDir: left })).resolves.toMatchObject({ compiled: true });
    expect(existsSync(leftBehind)).toBe(false);

    let finished: ProjectCompile | undefined;
    const waiting = (async () => {
      finished = await compileProject({ projectDir: held });
      return finished;
    })();
    await delay(HELD_MS);
    const waited = finished;
    rmSync(holding);

    expect(waited).toBeUndefined();
    await expect(waiting).resolves.toMatchObject({ compiled: true });
  });

  it('beats the lock it holds from a thread of its own, while a compile holds its process’s, and none once it is let go of, nor another’s', async () => {
    const dir = application();
    const lock = lockedBy(dir, LOCK_STALE_MS, 'holder\n');
    const stop = beating(lock, 'holder\n', HELD_MS / 10);
    // Its thread is up once it has beaten the lock once.
    await vi.waitFor(() => {
      expect(Date.now() - statSync(lock).mtimeMs).toBeLessThan(LOCK_STALE_MS / 2);
    });

    // Aged again, and this thread held from then until the lock is read, no timer of its own run
    // in between: what beats the lock meanwhile is a thread of its own.
    lockedBy(dir, LOCK_STALE_MS, 'holder\n');
    holdThread(HELD_MS);
    const beaten = Date.now() - statSync(lock).mtimeMs;
    await stop();
    // Let go of: its lock aged again, and left so.
    lockedBy(dir, LOCK_STALE_MS, 'holder\n');
    await delay(HELD_MS / 2);
    const stopped = Date.now() - statSync(lock).mtimeMs;
    // Another's lock, which a beat of `holder` finds: left as it is.
    lockedBy(dir, LOCK_STALE_MS, 'another holder\n');
    const others = beating(lock, 'holder\n', HELD_MS / 10);
    await delay(HELD_MS / 2);
    await others();

    expect(beaten).toBeLessThan(LOCK_STALE_MS / 2);
    expect(stopped).toBeGreaterThan(LOCK_STALE_MS / 2);
    expect(Date.now() - statSync(lock).mtimeMs).toBeGreaterThan(LOCK_STALE_MS / 2);
  });

  it('refuses with each refusal of the compiler’s, and writes nothing', async () => {
    const dir = application({ 'src/components/broken.reactive.tsx': NO_COMPONENT });

    const refused = compileProject({ projectDir: dir });

    await expect(refused).rejects.toThrow(
      `refused to compile the components under ${path.join(dir, 'src')}`,
    );
    await expect(refused).rejects.toThrow(
      'components/broken.reactive.tsx:1:1: A component file holds one function',
    );
    expect(existsSync(path.join(dir, '.reactive', 'manifest.json'))).toBe(false);
    expect(existsSync(path.join(dir, '.reactive', DIGEST_FILE))).toBe(false);
    expect(existsSync(path.join(dir, '.reactive', LOCK_DIRECTORY))).toBe(false);
  });

  it('compiles into `src/app` once the pages moved there from `app`, taking away the route it wrote into `app`, and `app` with it', async () => {
    const dir = application({ 'app/page.tsx': PAGE });
    rmSync(path.join(dir, 'src', 'app'), { recursive: true });
    await compileProject({ projectDir: dir });

    expect(existsSync(path.join(dir, 'app/api/reactive-state/[...path]/route.ts'))).toBe(true);

    // The pages move to `src/app`: `app` holds nothing but the route the compile wrote into it.
    mkdirSync(path.join(dir, 'src', 'app'));
    renameSync(path.join(dir, 'app/page.tsx'), path.join(dir, 'src/app/page.tsx'));
    const moved = await compileProject({ projectDir: dir });

    expect(moved).toMatchObject({
      appDir: path.join(dir, 'src', 'app'),
      changed: true,
      compiled: true,
    });
    expect(existsSync(path.join(dir, 'src/app/api/reactive-state/[...path]/route.ts'))).toBe(true);
    // Next.js finds `src/app` from then on: nothing is left of the root's.
    expect(existsSync(path.join(dir, 'app'))).toBe(false);
  });

  it('takes away nothing but what it wrote of the `app` directory the pages moved away from', async () => {
    const dir = application({ 'src/app/notes.md': 'Moved to app.\n' });
    await compileProject({ projectDir: dir });
    // The pages move to `app`, a file of the application's left behind in `src/app`.
    mkdirSync(path.join(dir, 'app'));
    renameSync(path.join(dir, 'src/app/page.tsx'), path.join(dir, 'app/page.tsx'));

    const moved = await compileProject({ projectDir: dir });

    expect(moved.appDir).toBe(path.join(dir, 'app'));
    expect(existsSync(path.join(dir, 'app/api/reactive-state/[...path]/route.ts'))).toBe(true);
    expect(existsSync(path.join(dir, 'src/app/api'))).toBe(false);
    expect(readFileSync(path.join(dir, 'src/app/notes.md'), 'utf8')).toBe('Moved to app.\n');
  });

  it('takes away the folders the pages left empty in the `app` they moved from, and `app` with them', async () => {
    const dir = application({ 'app/(site)/docs/page.tsx': PAGE });
    rmSync(path.join(dir, 'src', 'app'), { recursive: true });
    await compileProject({ projectDir: dir });
    // The page moves to `src/app`, file by file: its folders are left behind, empty.
    mkdirSync(path.join(dir, 'src/app/(site)/docs'), { recursive: true });
    renameSync(
      path.join(dir, 'app/(site)/docs/page.tsx'),
      path.join(dir, 'src/app/(site)/docs/page.tsx'),
    );

    const moved = await compileProject({ projectDir: dir });

    expect(moved).toMatchObject({ appDir: path.join(dir, 'src', 'app'), compiled: true });
    // Next.js reads an `app` in the root while one is there at all, its pages or none.
    expect(existsSync(path.join(dir, 'app'))).toBe(false);
    await expect(compileProject({ projectDir: dir })).resolves.toMatchObject({
      appDir: path.join(dir, 'src', 'app'),
      changed: false,
      compiled: false,
    });
  });

  it('takes nothing away where it refuses: the route it wrote where the pages moved from stays until a compile is accepted', async () => {
    const dir = application({ 'app/page.tsx': PAGE });
    rmSync(path.join(dir, 'src', 'app'), { recursive: true });
    await compileProject({ projectDir: dir });
    const digest = readFileSync(path.join(dir, '.reactive', DIGEST_FILE), 'utf8');
    // The page moves to `src/app`, and a component the compile refuses comes with it.
    mkdirSync(path.join(dir, 'src', 'app'));
    renameSync(path.join(dir, 'app/page.tsx'), path.join(dir, 'src/app/page.tsx'));
    writeFileSync(path.join(dir, 'src/components/broken.reactive.tsx'), NO_COMPONENT);

    await expect(compileProject({ projectDir: dir })).rejects.toThrow('refused to compile');

    expect(existsSync(path.join(dir, 'app/api/reactive-state/[...path]/route.ts'))).toBe(true);
    expect(readFileSync(path.join(dir, '.reactive', DIGEST_FILE), 'utf8')).toBe(digest);

    rmSync(path.join(dir, 'src/components/broken.reactive.tsx'));
    const accepted = await compileProject({ projectDir: dir });

    expect(accepted).toMatchObject({
      appDir: path.join(dir, 'src', 'app'),
      changed: true,
      compiled: true,
    });
    expect(existsSync(path.join(dir, 'app'))).toBe(false);
    expect(existsSync(path.join(dir, 'src/app/api/reactive-state/[...path]/route.ts'))).toBe(true);
  });

  it('leaves the folders of an `app` directory it is told to read no pages from, where a file of the application’s is among them', async () => {
    const dir = application({ 'src/app/(site)/notes.md': 'Kept.\n' });
    await compileProject({ projectDir: dir });
    mkdirSync(path.join(dir, 'src/app/(empty)'));
    // The pages move to `web/app`, which the build is told: no directory Next.js finds by itself.
    mkdirSync(path.join(dir, 'web'));
    renameSync(path.join(dir, 'src/app/page.tsx'), path.join(dir, 'web/page.tsx'));

    await compileProject({ app: 'web', projectDir: dir });

    expect(existsSync(path.join(dir, 'src/app/api'))).toBe(false);
    expect(existsSync(path.join(dir, 'src/app/(empty)'))).toBe(true);
    expect(readFileSync(path.join(dir, 'src/app/(site)/notes.md'), 'utf8')).toBe('Kept.\n');
  });

  it('refuses to write over a file of the application’s where it writes its route, and writes nothing', async () => {
    const own = "export function GET() {\n  return new Response('mine');\n}\n";
    const dir = application({ 'src/app/api/reactive-state/[...path]/route.ts': own });

    await expect(compileProject({ projectDir: dir })).rejects.toThrow(
      "app/api/reactive-state/[...path]/route.ts:1:1: A file of the application's stands where",
    );
    expect(
      readFileSync(path.join(dir, 'src/app/api/reactive-state/[...path]/route.ts'), 'utf8'),
    ).toBe(own);
    expect(existsSync(path.join(dir, '.reactive', 'manifest.json'))).toBe(false);
  });

  it('refuses a route of the application’s served under `/api/reactive-state/`, of the App Router or the Pages Router', async () => {
    const handler = 'export default function handler() {}\n';
    const dir = application({
      'src/app/(site)/api/reactive-state/feed/route.ts':
        "export function GET() {\n  return new Response('feed');\n}\n",
      'src/pages/api/reactive-state/[...slug].ts': handler,
      'src/pages/api/reactive-state/index.ts': handler,
    });

    let refused = '';
    try {
      await compileProject({ projectDir: dir });
    } catch (error) {
      refused = String(error);
    }

    expect(refused).toContain(
      'app/(site)/api/reactive-state/feed/route.ts:1:1: A route of the application',
    );
    expect(refused).toContain(
      'pages/api/reactive-state/[...slug].ts:1:1: A route of the application',
    );
    // The Pages Router's index is served at `/api/reactive-state` itself, beside nothing.
    expect(refused).not.toContain('pages/api/reactive-state/index.ts');
  });

  it('compiles again once a proxy stands beside the app directory, and shares no route from then on', async () => {
    // The greeting's page alone renders the component: a root is one route's.
    const dir = application({
      'src/app/greet/[name]/page.tsx': GREETING_PAGE,
      'src/app/page.tsx': 'export default function Page() {\n  return <p />;\n}\n',
    });
    const shared = (): unknown => {
      const manifest = JSON.parse(
        readFileSync(path.join(dir, '.reactive', 'manifest.json'), 'utf8'),
      ) as { readonly routes: readonly { readonly route: string; readonly shared: boolean }[] };
      return manifest.routes.find(({ route }) => route === '/greet/[name]')?.shared;
    };
    await compileProject({ projectDir: dir });

    expect(shared()).toBe(true);

    writeFileSync(path.join(dir, 'src', 'proxy.ts'), 'export function proxy() {}\n');
    const proxied = await compileProject({ projectDir: dir });

    expect(proxied).toMatchObject({ changed: true, compiled: true });
    expect(shared()).toBe(false);
  });

  it('refuses a directory of components that is not there', async () => {
    const dir = application();

    await expect(compileProject({ projectDir: dir, src: 'components' })).rejects.toThrow(
      'components does not exist',
    );
  });
});

describe('layoutOf', () => {
  afterEach(removeProjects);

  it('finds the `app` directory where Next.js finds it: in the root before `src`', () => {
    const nested = application();
    const rooted = application({ 'app/page.tsx': PAGE });
    const none = application();
    rmSync(path.join(none, 'src', 'app'), { recursive: true });

    expect(layoutOf({ projectDir: nested }).appDir).toBe(path.join(nested, 'src', 'app'));
    expect(layoutOf({ projectDir: rooted }).appDir).toBe(path.join(rooted, 'app'));
    expect(layoutOf({ projectDir: none }).appDir).toBe(path.join(none, 'src', 'app'));
    expect(layoutOf({ app: 'web', out: 'gen', projectDir: none, src: 'lib' })).toStrictEqual({
      appDir: path.join(none, 'web'),
      outDir: path.join(none, 'gen'),
      projectDir: none,
      srcDir: path.join(none, 'lib'),
    });
  });
});
