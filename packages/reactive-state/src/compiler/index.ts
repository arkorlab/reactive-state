import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import type { API } from 'typescript/sync';

import { PROTOCOL_VERSION } from '../program.ts';
import { appRouteOf, GENERATED, routeCollisions } from './app-route.ts';
import { compileComponent } from './compile.ts';
import type { DatabaseExport } from './database-handle.ts';
import {
  type AppInput,
  type CompiledComponent,
  DURABLE_OBJECT_MODULE,
  emitElements,
  emitDurableObject,
  emitRegistry,
  emitRoot,
  emitRoute,
  emitServerFunctions,
  manifestOf,
  relativeSpecifier,
} from './emit-app.ts';
import { emitAuthority } from './emit-authority.ts';
import { emitClient } from './emit-client.ts';
import { emitHookModule } from './emit-hooks.ts';
import { type HostOptions, namedOf } from './emit-host.ts';
import { emitRoutesModule, middlewareOutputs, ROUTES_MODULE } from './emit-routes.ts';
import { ReactiveCompileError } from './errors.ts';
import { type HookModule, HookModules } from './hooks.ts';
import { emitStubs, hostOf, rootPrefetch, rootRemote } from './host.ts';
import type { Manifest } from './manifest.ts';
import { rememberModuleResolutions } from './module-resolutions.ts';
import { COMPONENT_SUFFIX, type ModuleClass, Modules, OPERATIONS_SUFFIX } from './modules.ts';
import { checkNodeArguments } from './node-arguments.ts';
import { operationModules } from './operation-modules.ts';
import { NO_ROUTING, scanRouting } from './routes.ts';
import { byCodeUnits } from './splice.ts';
import { typeNames } from './type-names.ts';
import { openTypeScript } from './typescript.ts';

export { ReactiveCompileError } from './errors.ts';
export type { Manifest } from './manifest.ts';
export { COMPONENT_SUFFIX } from './modules.ts';
export { openTypeScript } from './typescript.ts';

/**
 * The compiler of an application's `.reactive.tsx` components — the documented subset, and nothing
 * it cannot carry over whole (packages/reactive-state/README.md). Every component under the source
 * directory is compiled, with the custom hooks, the `'use server'` modules and the shared modules it
 * reaches — and each `'use server'` module there named `*.operations.ts`, which nothing need import
 * — into one build:
 *
 * - `<id>.authority.mts`, the authority's program of each component: its server part, as the
 *   application wrote it, its JSX rendered as data, and for one with state, its client part;
 * - `<id>.client.tsx`, the Client Component of each component with state, which holds nothing of
 *   the server's;
 * - `<id>.root.tsx`, what a page renders when it imports the component;
 * - a copy of each module of custom hooks, a stub of each `'use server'` module, the elements the
 *   host renders with, the Server Functions a page writes and has its dynamic sites rendered with,
 *   the authority's registry, the route a page follows its roots by, and the build's manifest.
 *
 * It runs on TypeScript 7.1's API, reading syntax alone: no program, no checker. What it writes of
 * the application's code it writes as the source holds it, comments and all (`splice.ts`).
 */

export interface CompileOptions {
  /** The application's source directory, which every component's id is the path in. */
  readonly srcDir: string;
  /** Where the compile writes its outputs: `.reactive`, in the application's root. */
  readonly outDir: string;
  /** The application's `app` directory, which the compile writes the route into. */
  readonly appDir: string;
  /** The module and the export the application's database is: `@/db#db` when not given. */
  readonly database?: string;
  /**
   * The module and the export the application reads its own signed-in session by (`SessionSource`
   * of `./next`), where it signs its users in itself: `<specifier>#<export>`. Not given, sessions
   * are the demo's.
   */
  readonly session?: string;
  /**
   * The module and the export that applies the change of the application's own session a server
   * operation asks for (`SessionChange` of `./next`): `<specifier>#<export>`. Not given, a change
   * is logged and left unapplied.
   */
  readonly sessionChange?: string;
  /**
   * The module and the export that prepares an operation on the application's server before the
   * authority runs it (`OperationPreparation` of `./next`): `<specifier>#<export>`. Not given,
   * nothing is prepared.
   */
  readonly prepareOperation?: string;
  /**
   * The private cache a root renders inside, for a link's prefetch to carry it: a `cacheLife`
   * profile of the application's config, or `<stale>/<revalidate>/<expire>` in seconds. Not given,
   * no root is cached.
   */
  readonly prefetch?: string;
  /**
   * Where the roots a prefetch carries are kept: `private`, the browser alone, as where it is not
   * given; or `remote`, the deployment's cache too, keyed by the reader's session, of a build that
   * names its `prefetch` and the application's own `session`.
   */
  readonly prefetchCache?: string;
  /**
   * `false` turns sharing off: the compile shares no route's view, and every root renders for its
   * own session. Not given, it shares what it shows renders alike for every visitor.
   */
  readonly share?: boolean;
  /** A compiler already open, for a caller that compiles many times; else one is opened. */
  readonly api?: API;
}

export interface Compiled {
  /** Each file the compile writes, by its path, with its text; none where it refused. */
  readonly outputs: ReadonlyMap<string, string>;
  /** Everything it refused, each where it stands. */
  readonly refusals: readonly ReactiveCompileError[];
  readonly buildId: string;
  readonly manifest: Manifest | undefined;
  /**
   * Each file the compile read, by its path, with the text it read of it: the application's
   * modules wherever they are — outside its directory too, where an alias leads — and the
   * configurations their aliases come from. What a compile of the same texts writes the same of.
   */
  readonly reads: ReadonlyMap<string, string>;
}

/** What `modules` has read: each module, and each configuration of its aliases, with its text. */
function readsOf(modules: Modules): ReadonlyMap<string, string> {
  const reads = new Map(modules.sources());
  for (const [file, text] of modules.configurations()) {
    reads.set(file, text);
  }
  for (const [file, text] of modules.typeReads()) {
    if (!reads.has(file)) reads.set(file, text);
  }
  return rememberModuleResolutions(reads, modules.resolutions());
}

/** The length of a build id's hash. */
const BUILD_HASH_LENGTH = 20;

const DEFAULT_DATABASE = '@/db#db';

export function compileApp(options: CompileOptions): Compiled {
  if (options.api !== undefined) {
    return compileWith(options.api, options);
  }
  using api = openTypeScript();
  return compileWith(api, options);
}

/** The application's own path for `directory`: through any symbolic link to it. */
function realDirectory(directory: string): string {
  const absolute = path.resolve(directory);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function compileWith(api: API, options: CompileOptions): Compiled {
  // What the host tells the compile is refused before a source is read: nothing is written of a
  // build its host misnamed the session source, or the prefetch's lifetime, of.
  let host: HostOptions;
  try {
    host = hostOf(options);
  } catch (error) {
    if (error instanceof ReactiveCompileError) {
      return {
        buildId: '',
        manifest: undefined,
        outputs: new Map(),
        reads: new Map(),
        refusals: [error],
      };
    }
    throw error;
  }
  const srcDir = realDirectory(options.srcDir);
  const outDir = path.resolve(options.outDir);
  const appDir = path.resolve(options.appDir);
  using modules = new Modules(api, srcDir, outDir);
  const hooks = new HookModules(modules);
  const refusals: ReactiveCompileError[] = [];
  const attempt = <T>(run: () => T): T | undefined => {
    try {
      return run();
    } catch (error) {
      if (error instanceof ReactiveCompileError) {
        if (refusals.every((refusal) => refusal.message !== error.message)) {
          refusals.push(error);
        }
        return undefined;
      }
      throw error;
    }
  };
  // The walk goes by real paths, and so skips what the compile writes by its real path: each stub
  // it writes of a module named as one of operations is a `'use server'` module of that name too.
  const named = namedFiles(srcDir, realDirectory(options.outDir));
  const components = named.components.flatMap((file) => {
    const compiled = attempt(() => compileComponent(file, { hooks, modules }));
    return compiled === undefined ? [] : [compiled];
  });
  checkNodeArguments(components, attempt);
  // A module nothing imports is imported by its path from the outputs, each by its real path: a
  // link in `outDir` or in `srcDir`, as it was given, leads where Node loads the module from.
  const operations = operationModules(
    {
      components,
      hooks: hooks.all(),
      named: named.operations,
      srcDir: path.resolve(options.srcDir),
    },
    modules,
    attempt,
  );
  const database = namedOf(options.database ?? DEFAULT_DATABASE);
  const exported = database === undefined ? undefined : resolvedDatabase(database, modules, outDir);
  // The pages, the layouts and the route middleware it reads are the build's as much as a
  // component is: each is read through `modules`, whose sources the build's id hashes.
  const routing = scanRouting({
    appDir,
    attempt,
    components,
    database: exported,
    modules,
    outDir,
    unshared: host.share === false,
  });
  // Nothing of the application's is written over, nor served beside the compile's route.
  for (const { file, reason } of routeCollisions(appDir, outDir)) {
    attempt(() => {
      throw new ReactiveCompileError(reason, {
        fileName: modules.nameOf(file),
        position: { character: 0, line: 0 },
      });
    });
  }
  if (database === undefined || refusals.length > 0) {
    if (database === undefined) {
      refusals.push(
        new ReactiveCompileError(
          `\`${options.database ?? ''}\` names no database: it is \`<specifier>#<export>\`, as \`@/db#db\`.`,
          {
            fileName: '--database',
            position: { character: 0, line: 0 },
          },
        ),
      );
    }
    return {
      buildId: '',
      manifest: undefined,
      outputs: new Map(),
      reads: readsOf(modules),
      refusals,
    };
  }
  // The database is the authority's whatever imports it: its declaration — tables, defaults, what
  // is public, the seed — is in the build's id as much as a component's code is, read from where the
  // registry the compile writes imports it.
  if (exported !== undefined) {
    modules.kindOf(exported.file);
  }
  const app = (buildId: string): AppInput => {
    return {
      buildId,
      classes: classesOf(components, hooks.all()),
      components,
      database,
      hooks: hooks.all(),
      host,
      operations,
      routing,
    };
  };
  const written = (buildId: string): Map<string, string> =>
    emitAll({ app: app(buildId), appDir, outDir });
  // The build's id says which code the browser and the authority run, so it hashes what the
  // compile writes as well as what it read: a compiler that writes something else from the same
  // application makes another build.
  const sources = [...modules.sources()].map(([file, text]) => [portable(srcDir, file), text]);
  const drafted = attempt(() => written(''));
  if (drafted === undefined) {
    return {
      buildId: '',
      manifest: undefined,
      outputs: new Map(),
      reads: readsOf(modules),
      refusals,
    };
  }
  const draft = [...drafted].map(([file, text]) => [portable(outDir, file), text]);
  const hash = createHash('sha256')
    .update(JSON.stringify([PROTOCOL_VERSION, sources.toSorted(byPath), draft.toSorted(byPath)]))
    .digest('hex');
  const buildId = `b_${hash.slice(0, BUILD_HASH_LENGTH)}`;
  return {
    buildId,
    manifest: manifestOf(app(buildId)),
    outputs: written(buildId),
    reads: readsOf(modules),
    refusals,
  };
}

/** `file`'s path from `directory`, its parts joined by `/` on every system, as the build's id hashes it. */
function portable(directory: string, file: string): string {
  return path.relative(directory, file).split(path.sep).join('/');
}

function byPath(a: readonly string[], b: readonly string[]): number {
  return byCodeUnits(a[0] ?? '', b[0] ?? '');
}

/** Whether a directory or a file holds nothing the compile finds by name: packages, mocks, what is hidden. */
function isHidden(name: string): boolean {
  // A test runner's manual mocks bear the names of the modules they stand in for, and are none of
  // the application's: a mock of a module of server operations would be registered, or refused.
  return name === 'node_modules' || name === '__mocks__' || name.startsWith('.');
}

/** The files the compile finds by their names under its source directory, in a stable order. */
interface NamedFiles {
  /** Each component (`COMPONENT_SUFFIX`). */
  readonly components: readonly string[];
  /** Each module of server operations (`OPERATIONS_SUFFIX`), which nothing need import. */
  readonly operations: readonly string[];
}

/**
 * Every component and every module named as one of server operations under `srcDir`: no package's,
 * none of a hidden directory's or of what the compile wrote, and none through a link.
 */
function namedFiles(srcDir: string, outDir: string): NamedFiles {
  const components: string[] = [];
  const operations: string[] = [];
  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (full === outDir || isHidden(entry.name)) {
        continue;
      }
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile() && entry.name.endsWith(COMPONENT_SUFFIX)) {
        components.push(full);
      } else if (entry.isFile() && entry.name.endsWith(OPERATIONS_SUFFIX)) {
        operations.push(full);
      }
    }
  };
  visit(srcDir);
  return {
    components: components.toSorted(byCodeUnits),
    operations: operations.toSorted(byCodeUnits),
  };
}

/**
 * The module and the export `database` names, its module resolved from where the registry the
 * compile writes in `outDir` imports it; none where it resolves to no module of the application's.
 */
function resolvedDatabase(
  database: { readonly specifier: string; readonly name: string },
  modules: Modules,
  outDir: string,
): DatabaseExport | undefined {
  const file = modules.resolve(database.specifier, path.join(outDir, 'authority.mts'));
  return file === undefined ? undefined : { file, name: database.name };
}

/** What each module the components and the hooks import is to the compile, by specifier. */
function classesOf(
  components: readonly CompiledComponent[],
  hookModules: readonly HookModule[],
): ReadonlyMap<string, string> {
  const classes = new Map<string, string>();
  const modules = [
    ...components.flatMap(({ component }) => component.modules),
    ...hookModules.flatMap((module) => module.modules),
  ];
  for (const module of modules) {
    classes.set(module.specifier, module.target.kind);
  }
  return classes;
}

interface Emitting {
  readonly app: AppInput;
  readonly outDir: string;
  readonly appDir: string;
}

/**
 * Every file of the build, by its path. No two are one file: not by their paths, nor by their
 * paths in lower case, which a file system that keeps no case (macOS, Windows) writes one over the
 * other — a module of the application's named as a file the compile names itself, `Elements.ts`
 * beside `elements.ts`, or two components whose ids differ in case alone — whichever the system the
 * compile runs on. The outputs of route middleware are held against the other outputs, not against
 * each other: each is written at the path of its route, and two routes that differ in case alone
 * are two directories of the application's own — one directory where no case is kept, so no two
 * files there. Which routes are one to a request is Next.js's to say and the adapter's to refuse
 * (`caseShadowsOf`), not the compile's.
 */
function emitAll(emitting: Emitting): Map<string, string> {
  const { app, appDir, outDir } = emitting;
  const outputs = new Map<string, string>();
  /** Each path put, by its lower case: what a file system that keeps no case calls the file. */
  const folded = new Map<string, string>();
  const put = (file: string, text: string, folds = true): void => {
    const taken = folded.get(file.toLowerCase());
    if (taken !== undefined) {
      const name = path.relative(outDir, file);
      const message =
        taken === file
          ? `Two of what the compile writes are \`${name}\`: rename the module of the application's that takes the name.`
          : `Two of what the compile writes, \`${path.relative(outDir, taken)}\` and \`${name}\`, are one file where the file system keeps no case (macOS, Windows): rename the module of the application's that takes the name.`;
      throw new ReactiveCompileError(message, {
        fileName: name,
        position: { character: 0, line: 0 },
      });
    }
    outputs.set(file, text);
    if (folds) {
      folded.set(file.toLowerCase(), file);
    }
  };
  const outputOf = (from: string) => {
    return (target: ModuleClass): string | undefined => {
      return (target.kind === 'hooks' || target.kind === 'operations') && target.id !== undefined
        ? relativeSpecifier(from, path.join(outDir, target.id))
        : undefined;
    };
  };
  const byId = new Map(app.components.map((compiled) => [compiled.component.id, compiled]));
  for (const compiled of app.components) {
    const { component, sides, writes } = compiled;
    const base = path.join(outDir, component.id);
    put(
      `${base}.authority.mts`,
      emitAuthority({
        buildId: app.buildId,
        component,
        propTypes: typeNames(component.propsType),
        sides,
        updaters: compiled.updaters,
        writable: compiled.writable,
      }),
    );
    if (component.returned !== undefined) {
      const file = `${base}.client.tsx`;
      put(file, emitClient({ component, outputOf: outputOf(file), sides, writes }));
    }
    const route = app.routing?.roots.get(component.id);
    const sharedRoute = app.routing?.routes.find((each) => each.route === route)?.shared;
    const prefetch = rootPrefetch(app.host, { route, sharedRoute });
    const remote = rootRemote(app.host, { compiled, life: prefetch, route }, byId);
    put(
      `${base}.root.tsx`,
      emitRoot(compiled, `${base}.root.tsx`, outDir, { prefetch, remote, route }),
    );
  }
  for (const module of app.hooks) {
    const file = path.join(outDir, `${module.id}${path.extname(module.file)}`);
    put(file, emitHookModule({ module, outputOf: outputOf(file) }));
  }
  const session = app.host?.session;
  emitStubs(app, outDir, put);
  put(path.join(outDir, 'elements.ts'), emitElements(app));
  put(
    path.join(outDir, 'server-functions.ts'),
    emitServerFunctions(session !== undefined, app.host?.prefetchCache === 'remote'),
  );
  const registry = path.join(outDir, 'authority.mts');
  put(registry, emitRegistry(app, registry));
  put(path.join(outDir, DURABLE_OBJECT_MODULE), emitDurableObject());
  const routing = app.routing ?? NO_ROUTING;
  // Held against every output before them, and nothing against them: both of two routes that differ
  // in case alone are written, and nothing put after them is named under `middleware/`.
  for (const [file, text] of middlewareOutputs(routing, outDir, app.buildId)) {
    put(file, text, false);
  }
  put(path.join(outDir, ROUTES_MODULE), emitRoutesModule(routing));
  put(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifestOf(app), null, 2)}\n`);
  const route = appRouteOf(appDir);
  put(route, emitRoute(route, outDir, session !== undefined));
  return outputs;
}

/** One file a compile writes, and whether what is on disk was already what it would write. */
export interface Output {
  readonly path: string;
  /** `true` where the file was what the compile writes; `false` where it was not, or is to be removed. */
  readonly current: boolean;
  /** Whether it is a file a compile wrote before that this one does not, which a write removes. */
  readonly leftover: boolean;
}

export interface WriteOptions {
  /** Compare with what is on disk and write nothing. */
  readonly check?: boolean;
}

/**
 * Writes `outputs`, or with `check`, says which of them are stale. A file the compile wrote into
 * `outDir` before — one that opens as what it writes does — that it no longer writes is stale too,
 * and a write removes it, and the directories it leaves empty, before it writes anything: where the
 * file system keeps no case (macOS, Windows), a file of a name that differs from an output's in
 * case alone is that output's, and a write over it would update it in place under the old spelling,
 * after which it would be taken for what the compile no longer writes and removed; removed first,
 * the output is written afresh, under its own spelling. A check removes nothing, and takes the old
 * spelling for stale, which it is: it is not the name the compile writes.
 */
export function writeOutputs(
  outputs: ReadonlyMap<string, string>,
  outDir: string,
  options: WriteOptions = {},
): readonly Output[] {
  const check = options.check === true;
  const root = path.resolve(outDir);
  const leftovers = generatedFiles(root).filter((file) => !outputs.has(file));
  if (!check) {
    for (const file of leftovers) {
      rmSync(file);
      removeEmptyDirectories(path.dirname(file), root);
    }
  }
  const written = [...outputs].map(([file, text]): Output => {
    const current = readIfPresent(file) === text;
    if (!current && !check) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    return { current, leftover: false, path: file };
  });
  return [...written, ...leftovers.map((file) => ({ current: false, leftover: true, path: file }))];
}

/** Removes `directory`, and each directory above it below `root`, while it is empty. */
function removeEmptyDirectories(directory: string, root: string): void {
  for (
    let each = directory;
    each !== root && each.startsWith(`${root}${path.sep}`);
    each = path.dirname(each)
  ) {
    try {
      rmdirSync(each);
    } catch {
      // One that is not empty holds what is not the compile's: it stays, and so does what it is in.
      return;
    }
  }
}

/** The files under `directory` that a compile wrote: none where there is no `directory`. */
function generatedFiles(directory: string): readonly string[] {
  let entries;
  try {
    entries = readdirSync(directory, { recursive: true, withFileTypes: true });
  } catch (error) {
    // Only a directory that is not there holds none; one that cannot be read may hold stale files.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => readIfPresent(file)?.startsWith(GENERATED) === true)
    .toSorted(byCodeUnits);
}

function readIfPresent(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}
