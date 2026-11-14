import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { fileFor, isFile, packageDirectory, typescriptFor } from '../authority/aliases.ts';

/**
 * The files a package's specifier names on each side of a component, as what loads that side's
 * output resolves it — through the package's `exports`, under the conditions it resolves an ES
 * module's import with — so that two specifiers of one file are one module to the compiler, which
 * imports a module on one side alone. The application's own `#` imports are resolved the same way,
 * through its `package.json`'s `imports`.
 */

/** The side of a component a module is read on. */
export type Side = 'authority' | 'browser';

/** How one of what loads an output resolves a package: under which conditions, to which entry. */
interface Consumer {
  /** The conditions it resolves `exports` and `imports` under. */
  readonly conditions: readonly string[];
  /** The file it takes for the entry of the package of no `exports` in `directory`: Node's, or a bundler's. */
  readonly entry: (directory: string, manifest: Json) => string | undefined;
  /** Whether it reads a package's `browser` field as a map of its files to others, as a bundler for the browser does. */
  readonly browserMap: boolean;
}

/** How a bundler for the browser — Rolldown's `browser` platform, Next.js's — reads an entry. */
const BUNDLER_MAIN_FIELDS = ['browser', 'module', 'main'] as const;

/**
 * What Node tries for the entry of a package of no `exports` (`legacyMainResolve`), in its order:
 * its `main`, a path from the package's directory, as written, with `.js`, `.json` or `.node`, or a
 * directory's `index` of one of them; and then the package's own `index` of one of them.
 */
const NODE_MAIN = ['', '.js', '.json', '.node', '/index.js', '/index.json', '/index.node'] as const;
const NODE_INDEX = ['index.js', 'index.json', 'index.node'] as const;

/**
 * The file Node takes for the entry of a package of no `exports` (`NODE_MAIN`), as it alone finds
 * it: never its TypeScript, which a bundler takes first — though an `index.ts` stands beside the
 * `index.js` Node runs — nor what a directory's own `package.json` names; and, where `main` names
 * no file, or there is none, the package's own `index.js`.
 */
function nodeEntry(directory: string, manifest: Json): string | undefined {
  const { main } = manifest;
  const named = typeof main === 'string' ? path.resolve(directory, main) : undefined;
  const candidates = [
    ...(named === undefined ? [] : NODE_MAIN.map((suffix) => `${named}${suffix}`)),
    ...NODE_INDEX.map((index) => path.join(directory, index)),
  ];
  return candidates.find((file) => isFile(file));
}

/**
 * The file a bundler takes for the entry of a package of no `exports`: the entry the first of its
 * fields that names one names — a `browser` field that maps files names none — or else its
 * `index`, found as a path is, its TypeScript first.
 */
function bundlerEntry(directory: string, manifest: Json): string | undefined {
  const entry = BUNDLER_MAIN_FIELDS.map((field) => manifest[field]).find(
    (value) => typeof value === 'string',
  );
  return fileFor(path.join(directory, typeof entry === 'string' ? entry : 'index'));
}

/**
 * A bundler's ways of reading a package: as it is, and in each mode a build may run in, whose
 * condition it adds — Next.js resolves `production` in a production build and `development` in a
 * development one.
 */
function inEachMode(consumer: Consumer): readonly Consumer[] {
  return [consumer, inMode(consumer, 'production'), inMode(consumer, 'development')];
}

/** `consumer` in a build's `mode`, whose condition it adds. */
function inMode(consumer: Consumer, mode: string): Consumer {
  return { ...consumer, conditions: [...consumer.conditions, mode] };
}

/**
 * How each side's output is resolved, by each of what loads it: the authority's program by the
 * Node authority, and by a Durable Object's bundle (`workerd`, `worker`, `browser`, and Rolldown's
 * `import`); the Client Component by Next.js's bundle for the browser — each bundle in each mode.
 */
const CONSUMERS: Readonly<Record<Side, readonly Consumer[]>> = {
  authority: [
    {
      browserMap: false,
      // Node's own: `node-addons` among them, which it holds unless it runs with `--no-addons`.
      conditions: ['node', 'node-addons', 'import', 'module-sync', 'default'],
      entry: nodeEntry,
    },
    ...inEachMode({
      browserMap: true,
      conditions: ['workerd', 'worker', 'browser', 'import', 'default'],
      entry: bundlerEntry,
    }),
  ],
  browser: inEachMode({
    browserMap: true,
    conditions: ['browser', 'import', 'module', 'default'],
    entry: bundlerEntry,
  }),
};

type Json = Readonly<Record<string, unknown>>;

/** A package's specifier: neither a path, nor a `#` import, nor a URL. */
const PACKAGE = /^(?![./#]|[a-z][\w+.-]*:)/iu;

function readJson(file: string): Json | undefined {
  try {
    // A byte-order mark, as some editors write one, is no JSON; Node skips it in a manifest.
    const value: unknown = JSON.parse(readFileSync(file, 'utf8').replace(/^\u{FEFF}/u, ''));
    return typeof value === 'object' && value !== null ? (value as Json) : undefined;
  } catch {
    return undefined;
  }
}

/** `url` without the query or the fragment it ends with, which name no other file. */
function withoutQuery(url: string): string {
  const end = url.search(/[?#]/u);
  return end === -1 ? url : url.slice(0, end);
}

/** What a target names under conditions: a file, `null` where it excludes the path, or nothing. */
type Target = string | null | undefined;

/** What a target is resolved with. */
interface Resolving {
  /** What the key's `*` stood for, which each `*` of the target stands for too. */
  readonly matched: string | undefined;
  readonly conditions: readonly string[];
  /**
   * How a target that names a package rather than a path is resolved: `imports` may map to one,
   * resolved as Node resolves it from the package that declares them; `exports` may not.
   */
  readonly external?: (specifier: string) => string | undefined;
}

/** The first item of an array target that names something. */
function firstOf(directory: string, items: readonly unknown[], resolving: Resolving): Target {
  // A `null` among them is passed over, as Node passes it, and answered only where nothing after it
  // names a file.
  let excluded: Target;
  for (const item of items) {
    const file = targetFile(directory, item, resolving);
    if (typeof file === 'string') {
      return file;
    }
    excluded ??= file;
  }
  return excluded;
}

/** The first condition of an object target the conditions hold, in the object's order. */
function conditionOf(directory: string, target: Json, resolving: Resolving): Target {
  for (const [condition, value] of Object.entries(target)) {
    if (condition === 'default' || resolving.conditions.includes(condition)) {
      const file = targetFile(directory, value, resolving);
      if (file !== undefined) {
        return file;
      }
    }
  }
  return undefined;
}

/**
 * The file a target of `exports` or `imports` names: a path of the package's — or, where
 * `external` resolves them, a package's own — the first of an array that names one, or the first
 * condition of an object the conditions hold, each `*` standing for what the key's stood for.
 * `null` where the target excludes the path; none where it names none.
 */
function targetFile(directory: string, target: unknown, resolving: Resolving): Target {
  if (typeof target === 'string') {
    const { matched } = resolving;
    const named = matched === undefined ? target : target.replaceAll('*', () => matched);
    // A URL, as Node reads it, from the package's directory: what a query or a fragment adds names
    // no other file.
    return target.startsWith('./')
      ? fileURLToPath(new URL(withoutQuery(named), pathToFileURL(`${directory}/`)))
      : resolving.external?.(named);
  }
  if (Array.isArray(target)) {
    return firstOf(directory, target, resolving);
  }
  if (target === null) {
    return null;
  }
  return typeof target === 'object' ? conditionOf(directory, target as Json, resolving) : undefined;
}

/**
 * Whether the pattern `key` takes precedence over `other`, as Node orders them: the longer text
 * before `*`, and of two as long, the longer key — its text after `*` the longer.
 */
function moreSpecific(key: string, other: string): boolean {
  const before = key.indexOf('*');
  const otherBefore = other.indexOf('*');
  return before > otherBefore || (before === otherBefore && key.length > other.length);
}

/** The key of `map` that matches `request`: itself, or the most specific pattern that does. */
function keyFor(
  map: Json,
  request: string,
): { readonly key: string; readonly matched: string | undefined } | undefined {
  if (Object.hasOwn(map, request) && !request.includes('*')) {
    return { key: request, matched: undefined };
  }
  let best: { readonly key: string; readonly matched: string } | undefined;
  for (const key of Object.keys(map)) {
    const star = key.indexOf('*');
    if (star === -1 || key.includes('*', star + 1)) {
      continue;
    }
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (
      request.length >= key.length &&
      request.startsWith(prefix) &&
      request.endsWith(suffix) &&
      (best === undefined || moreSpecific(key, best.key))
    ) {
      best = { key, matched: request.slice(prefix.length, request.length - suffix.length) };
    }
  }
  return best;
}

/** Whether `exports` is its `.` alone, written without the key: a target, or conditions. */
function isSugar(exports: unknown): boolean {
  return (
    typeof exports === 'string' ||
    Array.isArray(exports) ||
    (typeof exports === 'object' &&
      exports !== null &&
      Object.keys(exports).every((key) => !key.startsWith('.')))
  );
}

/** The file a package's `subpath` — `.`, or `./x` — names to `consumer`, its `exports` read. */
function exportedFile(
  directory: string,
  manifest: Json,
  subpath: string,
  consumer: Consumer,
): string | undefined {
  const { exports } = manifest;
  // Absent, or `null`, which Node takes for absent.
  if (exports === undefined || exports === null) {
    // A package of no `exports`: the file the consumer takes for its entry, or the file the subpath
    // names as it lies; to a bundler for the browser, through what the `browser` field maps it to.
    const file =
      subpath === '.'
        ? consumer.entry(directory, manifest)
        : fileFor(path.join(directory, subpath));
    return consumer.browserMap ? remapped(directory, manifest, file) : file;
  }
  const map = isSugar(exports) ? { '.': exports } : (exports as Json);
  const found = keyFor(map, subpath);
  if (found === undefined) {
    return undefined;
  }
  const resolving = { conditions: consumer.conditions, matched: found.matched };
  return targetFile(directory, map[found.key], resolving) ?? undefined;
}

/**
 * The JavaScript names a TypeScript file stands for, as TypeScript reads `./x.js`: `x.js` of
 * `x.ts`, and of `x.tsx` too.
 */
const JAVASCRIPT_OF: ReadonlyMap<string, readonly string[]> = new Map([
  ['.cts', ['.cjs']],
  ['.mts', ['.mjs']],
  ['.ts', ['.js']],
  ['.tsx', ['.js', '.jsx']],
]);

/**
 * What the `browser` field of the package in `directory` maps its `file` to (`"./server.js":
 * "./shared.js"`), the file named with or without its extension, or as the JavaScript a TypeScript
 * file stands for: a path of the package's, `false` where it leaves the file out, or nothing.
 */
function browserEntry(directory: string, manifest: Json, file: string): unknown {
  const map = manifest['browser'];
  if (typeof map !== 'object' || map === null) {
    return undefined;
  }
  const relative = `./${path.relative(directory, file).split(path.sep).join('/')}`;
  const extension = path.extname(relative);
  const stem = relative.slice(0, relative.length - extension.length);
  const javascript = JAVASCRIPT_OF.get(extension) ?? [];
  const names = [relative, stem, ...javascript.map((named) => `${stem}${named}`)];
  const key = names.find((name) => Object.hasOwn(map, name));
  return key === undefined ? undefined : (map as Json)[key];
}

/**
 * `file` of the package in `directory` as a bundler for the browser takes it, through what the
 * package's `browser` field maps it to; none where the field leaves the file out (`false`).
 */
function remapped(directory: string, manifest: Json, file: string | undefined): string | undefined {
  if (file === undefined) {
    return undefined;
  }
  const to = browserEntry(directory, manifest, file);
  if (to === false) {
    return undefined;
  }
  return typeof to === 'string' ? fileFor(path.join(directory, to)) : file;
}

/**
 * The files a bundler may take for `file` — one an alias, `exports` or `imports` names — through the
 * `browser` field of the package it is in, where that maps it to another: a Durable Object's bundle
 * and the browser's read it alike. Its TypeScript and its JavaScript both, where both are there,
 * since a bundler may read `./x.js` as TypeScript does, or as it is.
 */
export function browserMapped(file: string): readonly string[] {
  const scope = scopeOf(path.dirname(file));
  const to = scope === undefined ? undefined : browserEntry(scope.directory, scope.manifest, file);
  if (scope === undefined || typeof to !== 'string') {
    return [];
  }
  const target = path.join(scope.directory, to);
  return [typescriptFor(target), fileFor(target)].filter((mapped) => mapped !== undefined);
}

/**
 * What a bundler takes for the module named `specifier` where the `browser` field of the package
 * that imports it — the package `directory` is in — replaces that name (`"server-lib":
 * "./src/shared.js"`), as the field lets a package replace a module: a file of the package's, or
 * the module of another name; none where the field replaces nothing of the name, or with none.
 */
function replacedName(specifier: string, directory: string, consumer: Consumer): readonly string[] {
  const scope = scopeOf(directory);
  const map = scope?.manifest['browser'];
  if (
    scope === undefined ||
    typeof map !== 'object' ||
    map === null ||
    !Object.hasOwn(map, specifier)
  ) {
    return [];
  }
  const to = (map as Json)[specifier];
  if (typeof to !== 'string') {
    return [];
  }
  if (!to.startsWith('.')) {
    const file = packageFile(to, directory, consumer);
    return file === undefined ? [] : [file];
  }
  const target = path.join(scope.directory, to);
  return [typescriptFor(target), fileFor(target)].filter((mapped) => mapped !== undefined);
}

/** The package `directory` is in: the nearest `package.json`, in it or above it, and its own. */
function scopeOf(
  directory: string,
): { readonly directory: string; readonly manifest: Json } | undefined {
  let from = directory;
  for (;;) {
    const manifest = readJson(path.join(from, 'package.json'));
    if (manifest !== undefined) {
      return { directory: from, manifest };
    }
    const parent = path.dirname(from);
    if (parent === from) {
      return undefined;
    }
    from = parent;
  }
}

/** The `imports` of the package `directory` is in, where it declares them. */
function importsOf(
  directory: string,
): { readonly directory: string; readonly imports: Json } | undefined {
  const scope = scopeOf(directory);
  const imports = scope?.manifest['imports'];
  return scope !== undefined && typeof imports === 'object' && imports !== null
    ? { directory: scope.directory, imports: imports as Json }
    : undefined;
}

function realFile(file: string): string | undefined {
  try {
    return isFile(file) ? realpathSync(file) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The file a `#` import of the application's names from `directory` to `consumer`: a path of
 * its own, or a package's, resolved from the application as Node resolves the target it maps to.
 */
function importedFile(
  specifier: string,
  directory: string,
  consumer: Consumer,
): string | undefined {
  const own = importsOf(directory);
  const found = own === undefined ? undefined : keyFor(own.imports, specifier);
  if (own === undefined || found === undefined) {
    return undefined;
  }
  const external = (target: string): string | undefined =>
    PACKAGE.test(target) ? packageFile(target, own.directory, consumer) : undefined;
  const resolving = { conditions: consumer.conditions, external, matched: found.matched };
  return targetFile(own.directory, own.imports[found.key], resolving) ?? undefined;
}

/** The file a package's specifier names from `directory` to `consumer`. */
function packageFile(specifier: string, directory: string, consumer: Consumer): string | undefined {
  const [first = '', second = ''] = specifier.split('/', 2);
  const packageName = first.startsWith('@') ? `${first}/${second}` : first;
  const subpath = `.${specifier.slice(packageName.length)}`;
  // The package the component is in, named by its own name, as Node lets a package with `exports`
  // import itself, before any of `node_modules`.
  const own = scopeOf(directory);
  if (own?.manifest['name'] === packageName && own.manifest['exports'] !== undefined) {
    return exportedFile(own.directory, own.manifest, subpath, consumer);
  }
  const packageDir = packageDirectory(packageName, directory);
  // A package of no `package.json` is one of no fields at all, its entry its `index`.
  return packageDir === undefined
    ? undefined
    : exportedFile(
        packageDir,
        readJson(path.join(packageDir, 'package.json')) ?? {},
        subpath,
        consumer,
      );
}

/**
 * The files `specifier` — a package's, or a `#` import of the application's — names from
 * `directory` on `side`, to each of what loads it; none it names no file of.
 */
export function packageFiles(specifier: string, directory: string, side: Side): readonly string[] {
  const files = new Set<string>();
  const consumers = CONSUMERS[side];
  for (const consumer of consumers) {
    const named = namedFiles(specifier, directory, consumer);
    for (const each of named) {
      const real = realFile(each);
      if (real !== undefined) {
        files.add(real);
      }
    }
  }
  return [...files];
}

/**
 * The files `specifier` names from `directory` to `consumer`: the one `exports` or `imports` names,
 * and, to a bundler, what the `browser` field of the package it is in maps it to too — which one
 * bundler does and another may not: both are the module's — and what the importing package's own
 * field replaces the name with.
 */
function namedFiles(specifier: string, directory: string, consumer: Consumer): readonly string[] {
  const imported = specifier.startsWith('#');
  const file = imported
    ? importedFile(specifier, directory, consumer)
    : packageFile(specifier, directory, consumer);
  const named = file === undefined ? [] : [file];
  if (!consumer.browserMap) {
    return named;
  }
  // What the name is replaced with is read on as the bundler reads it: through the `browser` field
  // of the package that file is in too, a package the name was replaced with among them.
  const replaced = imported ? [] : replacedName(specifier, directory, consumer);
  return [...named, ...replaced].flatMap((each) => [each, ...browserMapped(each)]);
}
