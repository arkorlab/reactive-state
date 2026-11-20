import { createHash, randomUUID } from 'node:crypto';
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { GENERATED, isGeneratedFile } from '../compiler/app-route.ts';
import { givenHost } from '../compiler/host.ts';
import { compileApp, writeOutputs } from '../compiler/index.ts';
import {
  isModuleResolutions,
  type ModuleResolution,
  moduleResolutionsHold,
  moduleResolutionsOf,
} from '../compiler/module-resolutions.ts';
import { byCodeUnits } from '../compiler/splice.ts';
import { inputRoots } from './input-roots.ts';

/**
 * The compile a build runs before Next.js reads the application (`./adapter.ts`), and a platform's
 * command before it starts the authority the build prerenders against: `cli.ts`'s compile, run
 * where what it reads changed since it last ran, by one process at a time, and written so that no
 * reader sees half of it.
 *
 * - What it reads is digested — the application's sources, and this package's own, which the
 *   compile is — and the digest kept beside the outputs (`<out>/.input-digest`, never committed),
 *   with a digest of each file it wrote and of each file it read: a module out of the application,
 *   where an alias leads, among them, and the `tsconfig.json`s its aliases are read from, each it
 *   extends too. A compile is skipped where all of them still hold: the sources are as they were,
 *   each file it read as it read it, and nothing it wrote was changed or taken away since.
 * - Processes compile one at a time: a build loads its config in more than one, and two commands
 *   may build at once. Each takes `<out>/.lock`: a directory of one file, named by the lock's own id
 *   and naming its holder — its process and its host — made beside it and renamed into place whole,
 *   which a rename does only where there is none, or an empty one. It beats its file while it
 *   compiles, from a thread of its own that the compile does not hold, however long it takes; one
 *   waits while another holds it, and looks at the digest again once it has it. A holder that is
 *   gone — a process of this host there is no more, or any unbeaten for `LOCK_STALE_MS` — is one a
 *   process left behind as it died, and its file is taken away by its own name, then the directory
 *   where nothing is left in it: never a lock taken since, whose file is another's, however many
 *   processes found the same one left behind.
 * - Each file is written whole beside where it goes, then renamed over it; the manifest last, once
 *   everything it describes is in place; the digest after it.
 */

export interface ProjectOptions {
  /** The application's root: where its `package.json` and `next.config` are. */
  readonly projectDir: string;
  /** Where its components are, from the root: `src` unless said. */
  readonly src?: string;
  /** Where the compile writes, from the root: `.reactive` unless said. */
  readonly out?: string;
  /** Its `app` directory, from the root: where Next.js finds it unless said. */
  readonly app?: string;
  /** The module and the export its database is: the compile's `@/db#db` unless said. */
  readonly database?: string;
  /** The module and the export its own sessions are read by (`--session`), where it has one. */
  readonly session?: string;
  /** The private cache its roots render inside for a link's prefetch (`--prefetch`), where said. */
  readonly prefetch?: string;
  /** `false` where it shares nothing (`--no-share`). */
  readonly share?: boolean;
}

/** Where an application's compile reads and writes, each directory by its absolute path. */
export interface ProjectLayout {
  readonly projectDir: string;
  readonly srcDir: string;
  readonly outDir: string;
  readonly appDir: string;
}

export interface ProjectCompile extends ProjectLayout {
  /** Whether this call compiled: false where the digest said what is on disk is current. */
  readonly compiled: boolean;
  /** Whether it changed anything on disk: a file written anew, or one taken away. */
  readonly changed: boolean;
}

/** Where the compile writes, and where the components are, from the application's root. */
export const DEFAULT_OUT = '.reactive';
export const DEFAULT_SRC = 'src';

/**
 * The adapter a platform's command names in `NEXT_ADAPTER_PATH` to build an application of reactive
 * state (`./adapter.ts`), by its path; and the variable the command names the platform's own
 * adapter in, by its module's path: the one the adapter wraps. Here, beside the compile the
 * command runs first, rather than in the adapter, which loads that adapter as it is imported.
 */
export const ADAPTER = fileURLToPath(new URL('adapter.ts', import.meta.url));
export const PLATFORM_ADAPTER_ENV = 'REACTIVE_STATE_PLATFORM_ADAPTER';
/**
 * The variable a platform's command sets to `1` where the edge it deploys to binds this package's
 * gate (`GATE_NAME`): only then does the adapter declare it for the routes it answers. A route a
 * deployment declares a gate for is answered 503 by an edge that binds none, so no build declares
 * one its platform did not say it binds; a shared route with no gate is rendered by the Function.
 */
export const EDGE_GATE_ENV = 'REACTIVE_STATE_EDGE_GATE';

/** The file the digest is kept in, and the lock's directory, in the compile's output directory. */
export const DIGEST_FILE = '.input-digest';
export const LOCK_DIRECTORY = '.lock';
/**
 * How long a lock goes unbeaten before its holder is taken to have died with it: many beats
 * (`LOCK_BEAT_MS`), which a holder makes however long its compile holds its process.
 */
export const LOCK_STALE_MS = 120_000;
/** How often a lock's holder beats it: touches it, for its age to say the holder is alive. */
const LOCK_BEAT_MS = 10_000;
/** How often a process waiting for the lock looks again. */
const LOCK_POLL_MS = 50;

/** The manifest, which a compile writes last. */
const MANIFEST = 'manifest.json';
/** The files a compile may read: code, and the JSON of a `tsconfig.json` or a `package.json`. */
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.json',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
]);
/** What Next.js writes into the application's root at each build: no source of the compile's. */
const NEXT_WRITES: ReadonlySet<string> = new Set(['next-env.d.ts']);
/**
 * The directories no source is read from, by name, wherever they stand: what installs, builds,
 * deployments, runs and tools write into an application — its packages (`node_modules`, pnpm's and
 * Yarn's stores), its history (`.git`), Next.js's build (`.next`), Turborepo's cache (`.turbo`),
 * Vercel's, upwind's and Wrangler's outputs and state, the database the fixtures' `serve` keeps
 * (`.state`) and the copies their variants are run in (`.variants`). Every other directory is read,
 * a hidden one among them (`src/.generated`): the compile reads a module wherever it is imported
 * from.
 */
const NOT_SOURCES: ReadonlySet<string> = new Set([
  '.arkor',
  '.git',
  '.next',
  '.pnpm-store',
  '.state',
  '.turbo',
  '.variants',
  '.vercel',
  '.wrangler',
  '.yarn',
  'node_modules',
]);
/** The compiler's own sources: this package's `src`, which a change to compiles otherwise. */
const PACKAGE_SOURCES = fileURLToPath(new URL('..', import.meta.url));

/** What is under `directory` but its directories — files, links — each as it is listed. */
function entriesUnder(directory: string): readonly Dirent[] {
  try {
    return readdirSync(directory, { recursive: true, withFileTypes: true }).filter(
      (entry) => !entry.isDirectory(),
    );
  } catch {
    return [];
  }
}

/** `entry`'s absolute path. */
function pathOf(entry: Dirent): string {
  return path.join(entry.parentPath, entry.name);
}

/**
 * Whether `entry` is what a compile wrote, as the compile tells its own files from the
 * application's (`isGeneratedFile`): a file — no link — that opens as every one it writes does.
 */
function isGenerated(entry: Dirent): boolean {
  return entry.isFile() && isGeneratedFile(pathOf(entry));
}

/**
 * Whether `directory` is an `app` directory as the compile reads one: there, and holding something
 * of the application's, or nothing at all — not only what a compile wrote into it, the route the
 * application's pages moved away from (`removeStaleRoutes`).
 */
function isAppDirectory(directory: string): boolean {
  if (!existsSync(directory)) {
    return false;
  }
  const entries = entriesUnder(directory);
  return entries.length === 0 || entries.some((entry) => !isGenerated(entry));
}

/**
 * The application's `app` directory, as Next.js finds it (`findDir`): `app` in its root over
 * `src/app`; where it has neither, the one Next.js would read beside its `pages`, or `src/app` in
 * an application with a `src`. One that holds nothing but what a compile wrote is none.
 */
function appDirOf(projectDir: string): string {
  const rooted = path.join(projectDir, 'app');
  if (isAppDirectory(rooted)) {
    return rooted;
  }
  const nested = path.join(projectDir, 'src', 'app');
  if (isAppDirectory(nested)) {
    return nested;
  }
  const srcHasIt =
    existsSync(path.join(projectDir, 'src')) && !existsSync(path.join(projectDir, 'pages'));
  return srcHasIt ? nested : rooted;
}

/** Takes away `directory`, and each directory above it up to `top`, while each is empty. */
function removeEmpty(directory: string, top: string): void {
  for (let current = directory; ; current = path.dirname(current)) {
    try {
      rmdirSync(current);
    } catch {
      // Something is left in it, or it is gone already.
      return;
    }
    if (current === top) {
      return;
    }
  }
}

/**
 * Takes away what a compile wrote into an `app` directory the compile no longer writes into — `app`
 * in the application's root, or `src/app`, whichever `layout`'s is not, as its pages moved from one
 * to the other — and each directory that leaves empty, up to that `app` directory: Next.js reads an
 * `app` directory in the root wherever it is there at all, its pages or none, before `src/app`.
 * Nothing the compile did not write: a file only where it opens as what the compile writes, and a
 * directory only where nothing is left in it. Answers whether it took anything away.
 */
function removeStaleRoutes(layout: ProjectLayout): boolean {
  let removed = false;
  const { appDir, projectDir } = layout;
  for (const directory of [path.join(projectDir, 'app'), path.join(projectDir, 'src', 'app')]) {
    if (directory === appDir) {
      continue;
    }
    for (const entry of entriesUnder(directory)) {
      if (isGenerated(entry)) {
        rmSync(pathOf(entry), { force: true });
        removeEmpty(entry.parentPath, directory);
        removed = true;
      }
    }
  }
  return removed;
}

/** Where `options` has the compile read and write. */
export function layoutOf(options: ProjectOptions): ProjectLayout {
  const projectDir = path.resolve(options.projectDir);
  return {
    appDir:
      options.app === undefined ? appDirOf(projectDir) : path.resolve(projectDir, options.app),
    outDir: path.resolve(projectDir, options.out ?? DEFAULT_OUT),
    projectDir,
    srcDir: path.resolve(projectDir, options.src ?? DEFAULT_SRC),
  };
}

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** What `entry` is, a link for what it links to; none where it links to nothing it can reach. */
function followed(entry: Dirent, file: string): Pick<Dirent, 'isDirectory' | 'isFile'> | undefined {
  if (!entry.isSymbolicLink()) {
    return entry;
  }
  try {
    return statSync(file);
  } catch {
    return undefined;
  }
}

/**
 * The source files under `directory` the compile may read, each by its absolute path: a hidden one
 * too, but none under `NOT_SOURCES` or `skipped` — a link for what it links to, as the walk of the
 * app's routes follows one (`scanApp`) and the compile reads through one, and a link to a folder
 * along the way (`above`, by their own paths) walked no further.
 */
function sourceFiles(
  directory: string,
  skipped: ReadonlySet<string>,
  above: ReadonlySet<string> = new Set(),
): string[] {
  let entries;
  let real;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
    real = realpathSync(directory);
  } catch {
    return [];
  }
  if (above.has(real)) {
    return [];
  }
  const along = new Set([...above, real]);
  return entries.flatMap((entry) => {
    const file = path.join(directory, entry.name);
    const kind =
      NOT_SOURCES.has(entry.name) || skipped.has(file) ? undefined : followed(entry, file);
    if (kind?.isDirectory() === true) {
      return sourceFiles(file, skipped, along);
    }
    const source =
      kind?.isFile() === true &&
      SOURCE_EXTENSIONS.has(path.extname(entry.name)) &&
      !NEXT_WRITES.has(entry.name);
    return source ? [file] : [];
  });
}

/** The version of the TypeScript the compiler reads code with: a part of what it writes. */
function compilerTypeScript(): string {
  const manifest = createRequire(import.meta.url).resolve('typescript/package.json');
  const { version } = JSON.parse(readFileSync(manifest, 'utf8')) as { readonly version?: unknown };
  return typeof version === 'string' ? version : '';
}

/**
 * The digest of everything a compile of `layout` reads: the application's sources — under its
 * root, not only its components' directory, as they import its modules wherever they are — but
 * what the compile itself writes there; the components' directory and the app's, where either is
 * out of its root (`inputRoots`); this package's own, the compiler's; the TypeScript it reads them
 * with; and where it is told to read and write. Each file by its path from its root and the digest
 * of its bytes, in one order whatever the directory's.
 */
function inputDigest(layout: ProjectLayout, options: ProjectOptions): string {
  const hash = createHash('sha256');
  const add = (part: string): void => {
    hash.update(part).update('\0');
  };
  add(
    JSON.stringify({
      app: path.relative(layout.projectDir, layout.appDir),
      database: options.database,
      host: [options.session ?? null, options.prefetch ?? null, options.share ?? null],
      out: path.relative(layout.projectDir, layout.outDir),
      src: path.relative(layout.projectDir, layout.srcDir),
      typescript: compilerTypeScript(),
    }),
  );
  const roots = [...inputRoots(layout), { name: 'compiler', root: PACKAGE_SOURCES }];
  const skipped = new Set([layout.outDir]);
  for (const { name, root } of roots) {
    const files = sourceFiles(root, skipped)
      .map((file) => ({ file, relative: path.relative(root, file).split(path.sep).join('/') }))
      .toSorted((left, right) => byCodeUnits(left.relative, right.relative));
    for (const { file, relative } of files) {
      const bytes = readFileSync(file);
      if (!bytes.subarray(0, GENERATED.length).toString('utf8').startsWith(GENERATED)) {
        add(`${name}:${relative}`);
        add(sha256(bytes));
      }
    }
  }
  return hash.digest('hex');
}

/**
 * What the digest file holds: the inputs' digest, each file written, and each file the compile
 * read, by its digest.
 */
interface DigestRecord {
  readonly inputs: string;
  /** Each file the compile wrote, by its path from the application's root. */
  readonly outputs: Readonly<Record<string, string>>;
  /**
   * Each file the compile read, by its path from the application's root — one outside it as well,
   * where an alias leads, and the configurations of its aliases — with the digest of what it read.
   */
  readonly reads: Readonly<Record<string, string>>;
  /** Original resolver decisions, with file paths relative to the project root. */
  readonly resolutions: readonly ModuleResolution[];
}

/** Whether `value` is an object of digests, by path. */
function isDigests(value: unknown): value is Readonly<Record<string, string>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((digest) => typeof digest === 'string')
  );
}

function isDigestRecord(value: unknown): value is DigestRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { inputs, outputs, reads, resolutions } = value as Partial<Record<string, unknown>>;
  return (
    typeof inputs === 'string' &&
    isDigests(outputs) &&
    isDigests(reads) &&
    isModuleResolutions(resolutions)
  );
}

/** `file`'s path from the application's root, its parts joined by `/`, as the digest file names it. */
function recordedPath(layout: ProjectLayout, file: string): string {
  return path.relative(layout.projectDir, file).split(path.sep).join('/');
}

/**
 * `files`, each by its path from the application's root, with the digest of its text: the text a
 * compile wrote or read, not the file as it is now, so that one changed since holds no more.
 */
function digestsOf(
  layout: ProjectLayout,
  files: ReadonlyMap<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    [...files].map(([file, text]) => [recordedPath(layout, file), sha256(text)]),
  );
}

/**
 * Whether each of `digests`, by its path from the application's root, is still of its file: of its
 * text, as the compile reads it.
 */
function holds(layout: ProjectLayout, digests: Readonly<Record<string, string>>): boolean {
  return Object.entries(digests).every(([relative, digest]) => {
    try {
      return sha256(readFileSync(path.resolve(layout.projectDir, relative), 'utf8')) === digest;
    } catch {
      return false;
    }
  });
}

function readDigest(file: string): DigestRecord | undefined {
  try {
    const record: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return isDigestRecord(record) ? record : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether what is on disk is what a compile of `inputs` wrote: the outputs each as written, and
 * each file the compile read — wherever it is — still as it read it.
 */
function isCurrent(layout: ProjectLayout, inputs: string): boolean {
  const record = readDigest(path.join(layout.outDir, DIGEST_FILE));
  return (
    record?.inputs === inputs &&
    holds(layout, record.outputs) &&
    holds(layout, record.reads) &&
    moduleResolutionsHold(layout.projectDir, record.resolutions)
  );
}

/** Writes `text` to `file` whole: beside it first, then in its place in one rename. */
function writeWhole(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${String(process.pid)}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, text);
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Writes what the compile wrote that is not on disk already, each file whole; takes away the files
 * an earlier compile wrote that this one does not; then the manifest, last. Answers whether it
 * changed anything.
 */
function writeCompiled(outputs: ReadonlyMap<string, string>, outDir: string): boolean {
  const manifest = path.join(outDir, MANIFEST);
  const stale = writeOutputs(outputs, outDir, { check: true }).filter((output) => !output.current);
  const ordered = stale.toSorted(
    (left, right) => Number(left.path === manifest) - Number(right.path === manifest),
  );
  for (const output of ordered) {
    const text = outputs.get(output.path);
    if (text === undefined || output.leftover) {
      rmSync(output.path, { force: true });
    } else {
      writeWhole(output.path, text);
    }
  }
  return stale.length > 0;
}

/** The code of a system error; none of anything else. */
function codeOf(error: unknown): string {
  return error instanceof Error && 'code' in error ? String(error.code) : '';
}

/** The holder a lock names, as `lock` writes one: its process, by its id, and its host. */
interface Holder {
  readonly pid: number;
  readonly host: string;
}

/** The holder a lock's text names; none for a text `lock` did not write — an earlier version's. */
function holderOf(text: string): Holder | undefined {
  const [pid = '', host = ''] = text.split(' ', 2);
  const id = Number(pid);
  return host !== '' && Number.isSafeInteger(id) && id > 0 ? { host, pid: id } : undefined;
}

/** Whether the process `pid` of this host is gone: there is none to signal. */
function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return codeOf(error) === 'ESRCH';
  }
}

/**
 * Whether the holder's file at `file` was left by a process that died holding the lock: one of this
 * host whose process is gone, however fresh its file; any unbeaten for `LOCK_STALE_MS` — of a holder
 * of another host, whose process cannot be asked, of one whose process id another took since, or
 * one that never beat it.
 */
function isStale(file: string): boolean {
  try {
    const holder = holderOf(readFileSync(file, 'utf8'));
    if (holder?.host === hostname() && isGone(holder.pid)) {
      return true;
    }
    return Date.now() - statSync(file).mtimeMs > LOCK_STALE_MS;
  } catch {
    // Taken away since it was there: the next attempt may take the lock.
    return false;
  }
}

/**
 * What a rename into the lock's place fails with where something is there: a lock's directory with
 * its holder's file in it, or a file — an earlier version's lock — and, on Windows, any directory.
 */
const HELD_CODES: ReadonlySet<string> = new Set(['EEXIST', 'ENOTDIR', 'ENOTEMPTY', 'EPERM']);

/**
 * Whether the lock at `directory` was taken for `holder`: a directory of its own, holding the
 * holder's file named `id`, renamed into its place whole — where nothing, or an empty directory, is
 * there. Never left behind.
 */
function taken(directory: string, holder: string, id: string): boolean {
  const made = `${directory}-${id}`;
  mkdirSync(made);
  try {
    writeFileSync(path.join(made, id), holder);
    renameSync(made, directory);
    return true;
  } catch (error) {
    if (HELD_CODES.has(codeOf(error))) {
      return false;
    }
    throw error;
  } finally {
    rmSync(made, { force: true, recursive: true });
  }
}

/**
 * The files of the lock at `directory` whose holders left them behind as they died (`isStale`): its
 * holders' files, or the lock itself where it is a file, an earlier version's.
 */
export function abandoned(directory: string): readonly string[] {
  try {
    return readdirSync(directory)
      .map((name) => path.join(directory, name))
      .filter((file) => isStale(file));
  } catch (error) {
    return codeOf(error) === 'ENOTDIR' && isStale(directory) ? [directory] : [];
  }
}

/**
 * Takes away `files` of the lock at `directory` — what `abandoned` found of it — each by its own
 * name, which no other lock's file has: never a lock taken since, however long since they were found.
 * Then the directory, where nothing is left in it. Whether anything was taken away, for the lock to be
 * asked for again at once.
 */
export function reclaim(directory: string, files: readonly string[]): boolean {
  let removed = false;
  for (const file of files) {
    try {
      // A file's name alone: a lock's directory, where the file was an earlier version's lock, is
      // left as it is.
      unlinkSync(file);
      removed = true;
    } catch {
      // Taken away already, or a directory now.
    }
  }
  try {
    rmdirSync(directory);
    return true;
  } catch {
    // Another holder's file in it, or gone.
    return removed;
  }
}

/** Takes the lock at `directory`, waiting while another process holds it: its holder's file. */
async function lock(
  directory: string,
): Promise<{ readonly file: string; readonly holder: string }> {
  mkdirSync(path.dirname(directory), { recursive: true });
  const id = randomUUID();
  const holder = `${String(process.pid)} ${hostname()} ${id}\n`;
  while (!taken(directory, holder, id)) {
    if (!reclaim(directory, abandoned(directory))) {
      await sleep(LOCK_POLL_MS);
    }
  }
  return { file: path.join(directory, id), holder };
}

/**
 * Lets the lock go whose holder's file is `file`: the file, by its own name — gone already where
 * the lock was taken over as stale — and its directory where nothing else is in it.
 */
function unlock(file: string): void {
  reclaim(path.dirname(file), [file]);
}

/** A lock's beat, on a thread of its own: its file touched, while it is still its holder's. */
const BEAT = `
const { readFileSync, utimesSync } = require('node:fs');
const { workerData } = require('node:worker_threads');
const { file, holder, everyMs } = workerData;
setInterval(() => {
  try {
    if (readFileSync(file, 'utf8') === holder) {
      const now = new Date();
      utimesSync(file, now, now);
    }
  } catch {}
}, everyMs);
`;

/**
 * Beats the lock at `file` every `everyMs` while `holder` holds it — from a thread of its own, which
 * a compile that holds the process's own for longer than `LOCK_STALE_MS` does not hold — until the
 * function it returns stops it.
 */
export function beating(file: string, holder: string, everyMs = LOCK_BEAT_MS): () => Promise<void> {
  const worker = new Worker(BEAT, { eval: true, workerData: { everyMs, file, holder } });
  worker.unref();
  return async () => {
    await worker.terminate();
  };
}

function compileLocked(layout: ProjectLayout, options: ProjectOptions, inputs: string): boolean {
  const compiled = compileApp({
    appDir: layout.appDir,
    outDir: layout.outDir,
    srcDir: layout.srcDir,
    ...givenHost(options),
  });
  if (compiled.refusals.length > 0) {
    const refusals = compiled.refusals.map((refusal) => refusal.message);
    throw new Error(
      `@arkorlab/reactive-state refused to compile the components under ${layout.srcDir}:\n${refusals.join('\n')}`,
    );
  }
  const changed = writeCompiled(compiled.outputs, layout.outDir);
  const record: DigestRecord = {
    inputs,
    outputs: digestsOf(layout, compiled.outputs),
    reads: digestsOf(layout, compiled.reads),
    resolutions: moduleResolutionsOf(compiled.reads).map(({ importer, specifier, file }) => {
      return {
        importer: recordedPath(layout, importer),
        specifier,
        file: file === null ? null : recordedPath(layout, file),
      };
    }),
  };
  writeWhole(path.join(layout.outDir, DIGEST_FILE), `${JSON.stringify(record, null, 2)}\n`);
  return changed;
}

/**
 * Compiles the application `options` names where what the compile reads changed since it last
 * wrote, and writes what it compiles; refuses with each refusal where it refuses anything, and
 * writes nothing then.
 */
export async function compileProject(options: ProjectOptions): Promise<ProjectCompile> {
  const layout = layoutOf(options);
  if (!existsSync(layout.srcDir)) {
    throw new Error(
      `${layout.srcDir} does not exist: @arkorlab/reactive-state compiles the components under \`src\`, or under the \`src\` withReactiveState is given.`,
    );
  }
  // The route an earlier compile wrote where the application's pages no longer are, whatever the
  // digest says: Next.js would read that directory, and none of the pages.
  const removed = removeStaleRoutes(layout);
  if (isCurrent(layout, inputDigest(layout, options))) {
    return { ...layout, changed: removed, compiled: false };
  }
  const held = await lock(path.join(layout.outDir, LOCK_DIRECTORY));
  // Beaten from the moment it is held, however long what follows takes — reading the sources again
  // as well as the compile — a holder alive.
  const stop = beating(held.file, held.holder);
  try {
    // Another process may have compiled while this one waited, or the sources changed meanwhile.
    const inputs = inputDigest(layout, options);
    if (isCurrent(layout, inputs)) {
      return { ...layout, changed: removed, compiled: false };
    }
    const changed = compileLocked(layout, options, inputs);
    return { ...layout, changed: changed || removed, compiled: true };
  } finally {
    await stop();
    unlock(held.file);
  }
}
