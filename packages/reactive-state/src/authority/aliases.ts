import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * How TypeScript resolves an application's specifiers by its `tsconfig.json` — the `@/db` a
 * component's program imports — for what reads them without TypeScript: the Node authority, which
 * loads the modules (`registerPaths`), and the compiler, which tells two specifiers of one module
 * apart from two modules.
 *
 * A specifier takes the key TypeScript would take — one without `*` that is the specifier itself,
 * or else the matching key with the longest text before its `*` — and resolves to the first of that
 * key's targets that names a file: `./x.js` as `./x.ts` or `./x.tsx` where there is one, as
 * written, with `.ts`, `.tsx`, `.js` or `.jsx` in TypeScript's order, or as a directory's `index`.
 * A bare specifier no key matches is looked for under `baseUrl`, where the configuration sets one,
 * as TypeScript looks for it there before it looks for a package. A configuration's own `paths` and
 * `baseUrl`, or those it inherits through `extends`, as TypeScript reads them.
 */

/**
 * What a specifier without an extension is tried with, in TypeScript's order: its TypeScript before
 * its JavaScript, so that the file run is the one the application's type check read. A `.mts` or a
 * `.mjs` is named by its extension alone, as TypeScript has it.
 */
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'] as const;
const INDEXES = EXTENSIONS.map((extension) => `index${extension}`);
/**
 * The JavaScript extensions TypeScript reads as a TypeScript file's of the same name, each with the
 * TypeScript extensions it tries for it, in its order: `.js` as `.ts` and then `.tsx`, `.jsx` as
 * `.tsx` and then `.ts`, `.mjs` as `.mts`, `.cjs` as `.cts`. The declaration it tries after them is
 * no module to load. None ends with another, so a path ends with one of them at most.
 */
const SCRIPTS: ReadonlyMap<string, readonly string[]> = new Map([
  ['.cjs', ['.cts']],
  ['.js', ['.ts', '.tsx']],
  ['.jsx', ['.tsx', '.ts']],
  ['.mjs', ['.mts']],
]);
const TSCONFIG = 'tsconfig.json';
const PACKAGE_JSON = 'package.json';
const WHITE_SPACE = /\s/u;

/** A pattern split at its `*`; one without matches its own text alone. */
interface Pattern {
  readonly prefix: string;
  readonly suffix: string;
  readonly wildcard: boolean;
}

interface Alias extends Pattern {
  /** Each target, absolute, split at its `*` as the key is. */
  readonly targets: readonly Pattern[];
}

/** A configuration file read for an application's aliases, and its text as it was read. */
interface ConfigurationFile {
  readonly file: string;
  readonly text: string;
}

/** The aliases a `tsconfig.json` declares, and its `baseUrl`, as `resolveAlias` reads them. */
export interface Aliases {
  readonly paths: readonly Alias[];
  /** The directory a bare specifier no key matches is looked for in; none without `baseUrl`. */
  readonly baseUrl: string | undefined;
  /** The configuration files they were read from: the `tsconfig.json`, and each it extends. */
  readonly files: readonly ConfigurationFile[];
}

/** What a configuration that declares nothing resolves: no specifier at all. */
export const NO_ALIASES: Aliases = { baseUrl: undefined, files: [], paths: [] };

/** A specifier that names neither a path nor a URL — `node:fs` is a URL — which a package might. */
const BARE = /^(?![./]|[a-z][\w+.-]*:)/iu;

/** Where the string that opens at `index` ends, its closing quote included. */
function stringEnd(source: string, index: number): number {
  let end = index + 1;
  while (end < source.length && source[end] !== '"') {
    end += source[end] === '\\' ? 2 : 1;
  }
  return end + 1;
}

/** Where the comment that opens at `index` ends; `index` itself where none opens there. */
function commentEnd(source: string, index: number): number {
  if (source.startsWith('//', index)) {
    const end = source.indexOf('\n', index);
    return end === -1 ? source.length : end;
  }
  if (source.startsWith('/*', index)) {
    const end = source.indexOf('*/', index + 2);
    return end === -1 ? source.length : end + 2;
  }
  return index;
}

/** Whether what follows `index`, past white space and comments, closes an array or an object. */
function closes(source: string, index: number): boolean {
  let at = index;
  while (at < source.length) {
    const end = commentEnd(source, at);
    if (end !== at) {
      at = end;
    } else if (WHITE_SPACE.test(source[at] ?? '')) {
      at += 1;
    } else {
      return source[at] === ']' || source[at] === '}';
    }
  }
  return false;
}

/**
 * The text of a JSON document with its comments taken out, as a `tsconfig.json` may have them: a
 * line comment, a block comment, and a trailing comma before a closing bracket — none of them
 * inside a string, which is kept as it is written.
 */
function withoutComments(source: string): string {
  let result = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? '';
    if (char === '"') {
      const end = stringEnd(source, index);
      result += source.slice(index, end);
      index = end;
      continue;
    }
    const end = commentEnd(source, index);
    if (end !== index) {
      index = end;
      continue;
    }
    if (char !== ',' || !closes(source, index + 1)) {
      result += char;
    }
    index += 1;
  }
  return result;
}

function split(pattern: string): Pattern {
  const star = pattern.indexOf('*');
  return star === -1
    ? { prefix: pattern, suffix: '', wildcard: false }
    : { prefix: pattern.slice(0, star), suffix: pattern.slice(star + 1), wildcard: true };
}

/** What a configuration declares of its aliases, its own or inherited, as TypeScript reads it. */
interface Declared {
  /** `paths`, and the directory of the configuration that declared it. */
  readonly paths?: {
    readonly entries: Readonly<Record<string, readonly string[]>>;
    readonly from: string;
  };
  /** `baseUrl`, made absolute from the configuration that declared it. */
  readonly baseUrl?: string;
}

/** What a configuration's JSON holds of what is read here. */
interface ConfigJson {
  readonly extends?: string | readonly string[];
  readonly compilerOptions?: {
    readonly baseUrl?: string;
    readonly paths?: Readonly<Record<string, readonly string[]>>;
  };
}

/** `${configDir}`, which a configuration's paths may name: the directory of the one in use. */
// eslint-disable-next-line no-template-curly-in-string -- TypeScript's placeholder, as tsconfig writes it
const CONFIG_DIR = '${configDir}';

/** `text` without the byte-order mark some editors begin a file with, which is no JSON. */
function withoutMark(text: string): string {
  return text.replace(/^\u{FEFF}/u, '');
}

/** The `package.json` of `directory`, parsed; none where there is none, or it is no JSON. */
export function manifestOf(directory: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const text = withoutMark(readFileSync(path.join(directory, PACKAGE_JSON), 'utf8'));
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null
      ? (value as Readonly<Record<string, unknown>>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** `file` as a configuration names it: itself, or with its `.json`; none where neither is a file. */
function withJson(file: string): string | undefined {
  return [file, `${file}.json`].find((candidate) => isFile(candidate));
}

/** The directory of the package `name`, as Node looks for one from `directory`; none where none is. */
export function packageDirectory(name: string, directory: string): string | undefined {
  let from = directory;
  for (;;) {
    // A package's directory, with a `package.json` or without, which Node resolves as well.
    const candidate = path.join(from, 'node_modules', name);
    if (isDirectory(candidate)) {
      return candidate;
    }
    const parent = path.dirname(from);
    if (parent === from) {
      return undefined;
    }
    from = parent;
  }
}

/** The configuration a package names in its `package.json` (`tsconfig`), as TypeScript reads it. */
function namedConfiguration(packageDir: string): string | undefined {
  const named = manifestOf(packageDir)?.['tsconfig'];
  return typeof named === 'string' ? named : undefined;
}

/**
 * The file a configuration's `extends` names: a path, from the configuration's directory, with or
 * without its `.json`; or a package's configuration, as TypeScript finds it — the one its
 * `package.json` names (`tsconfig`) or its `tsconfig.json` for the package itself, a file of it
 * through its `exports` or as it lies, with or without its `.json` — and never its JavaScript. None
 * where it names none.
 */
function extendedFile(extended: string, directory: string): string | undefined {
  if (extended.startsWith('.') || path.isAbsolute(extended)) {
    return withJson(path.resolve(directory, extended));
  }
  const [scope = '', name = ''] = extended.split('/', 2);
  const packageName = scope.startsWith('@') ? `${scope}/${name}` : scope;
  const subpath = extended.slice(packageName.length + 1);
  const packageDir = packageDirectory(packageName, directory);
  if (subpath === '') {
    return packageDir === undefined
      ? undefined
      : withJson(path.resolve(packageDir, namedConfiguration(packageDir) ?? TSCONFIG));
  }
  try {
    const file = createRequire(path.join(directory, TSCONFIG)).resolve(extended);
    if (file.endsWith('.json')) {
      return file;
    }
  } catch {
    // Not one its `exports` name: the file as it lies, if there is one.
  }
  return packageDir === undefined ? undefined : withJson(path.join(packageDir, subpath));
}

/**
 * What `tsconfig` declares of its aliases, as TypeScript reads it: its own `paths` and `baseUrl`,
 * each in place of what it inherits through `extends` — the later of an array over the earlier —
 * and otherwise what it inherits. A configuration that extends itself, at any remove, is read once.
 * Each file read is noted in `read`, with its text.
 */
function declaredBy(
  tsconfig: string,
  configDir: string,
  seen: ReadonlySet<string>,
  read: ConfigurationFile[],
): Declared {
  if (seen.has(tsconfig)) {
    return {};
  }
  const raw = readFileSync(tsconfig, 'utf8');
  read.push({ file: tsconfig, text: raw });
  // A byte-order mark, as some editors write one, is no JSON; TypeScript and Next.js skip it.
  const config = JSON.parse(withoutComments(withoutMark(raw))) as ConfigJson;
  const directory = path.dirname(tsconfig);
  let declared: Declared = {};
  for (const extended of [config.extends ?? []].flat()) {
    const file = typeof extended === 'string' ? extendedFile(extended, directory) : undefined;
    if (file !== undefined) {
      const inherited = declaredBy(file, configDir, new Set([...seen, tsconfig]), read);
      declared = { ...declared, ...inherited };
    }
  }
  const { baseUrl, paths } = config.compilerOptions ?? {};
  return {
    ...declared,
    ...(baseUrl !== undefined && {
      baseUrl: path.resolve(
        directory,
        baseUrl.replaceAll(CONFIG_DIR, () => configDir),
      ),
    }),
    ...(paths !== undefined && { paths: { entries: paths, from: directory } }),
  };
}

/**
 * The aliases `tsconfig` declares — its own `compilerOptions.paths`, or those it inherits — its
 * targets made absolute as TypeScript makes them: from `baseUrl` where one is in force — deprecated
 * by TypeScript 6.0 and gone in 7.0, but read still by Next.js and the bundlers — and otherwise from
 * the directory of the configuration that declared them; `${configDir}` as the directory of
 * `tsconfig` itself.
 */
export function aliasesOf(tsconfig: string): Aliases {
  const configDir = path.dirname(tsconfig);
  const files: ConfigurationFile[] = [];
  const { baseUrl, paths } = declaredBy(tsconfig, configDir, new Set(), files);
  const from = baseUrl ?? paths?.from ?? configDir;
  const absolute = (target: string): string => {
    return path.resolve(
      from,
      target.replaceAll(CONFIG_DIR, () => configDir),
    );
  };
  return {
    baseUrl,
    files,
    paths: Object.entries(paths?.entries ?? {}).map(([pattern, targets]) => {
      return {
        ...split(pattern),
        targets: targets.map((target) => split(absolute(target))),
      };
    }),
  };
}

/** The `tsconfig.json` nearest `file`, in its directory or above it; none where there is none. */
export function nearestTsconfig(file: string): string | undefined {
  let directory = path.dirname(path.resolve(file));
  for (;;) {
    const candidate = path.join(directory, TSCONFIG);
    if (isFile(candidate)) {
      return candidate;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

function isDirectory(directory: string): boolean {
  try {
    return statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The file `candidate` names as a file: itself, or with an extension. */
function asFile(candidate: string): string | undefined {
  return [candidate, ...EXTENSIONS.map((extension) => `${candidate}${extension}`)].find((file) =>
    isFile(file),
  );
}

/** The file `directory` names as its index. */
function indexOf(directory: string): string | undefined {
  return INDEXES.map((index) => path.join(directory, index)).find((file) => isFile(file));
}

/**
 * The entry a directory's `package.json` names (`main`), as TypeScript and the bundlers read a
 * directory: its TypeScript first, as for `./x.js`; none where it names none.
 */
function mainOf(directory: string): string | undefined {
  return entryOf(directory, 'main');
}

/**
 * The file the field `field` of a directory's `package.json` names as an entry, its TypeScript
 * first, as for `./x.js`; none where the field names none.
 */
function entryOf(directory: string, field: string): string | undefined {
  const named = manifestOf(directory)?.[field];
  if (typeof named !== 'string') {
    return undefined;
  }
  const entry = path.resolve(directory, named);
  return typescriptFor(entry) ?? asFile(entry) ?? indexOf(entry);
}

/**
 * The file `candidate` names as it is: itself, with an extension, or a directory's — the entry its
 * `package.json` names, or else its index.
 */
export function fileFor(candidate: string): string | undefined {
  return asFile(candidate) ?? mainOf(candidate) ?? indexOf(candidate);
}

/**
 * The TypeScript file a path to JavaScript stands for, as TypeScript reads `./x.js` — `./x.ts`
 * where there is one, though an `x.js` stands beside it, and else `./x.tsx` — and `.jsx`, `.mjs`
 * and `.cjs` in their turn (`SCRIPTS`); none where there is none.
 */
export function typescriptFor(candidate: string): string | undefined {
  for (const [script, extensions] of SCRIPTS) {
    if (candidate.endsWith(script)) {
      const stem = candidate.slice(0, -script.length);
      return extensions.map((extension) => `${stem}${extension}`).find((file) => isFile(file));
    }
  }
  return undefined;
}

/** Whether `specifier` matches a key with a `*`, around whatever the `*` stands for. */
function surrounds(alias: Alias, specifier: string): boolean {
  return (
    alias.wildcard &&
    specifier.length >= alias.prefix.length + alias.suffix.length &&
    specifier.startsWith(alias.prefix) &&
    specifier.endsWith(alias.suffix)
  );
}

/**
 * The alias TypeScript takes for `specifier`: a key without `*` that is the specifier itself, or
 * else the matching key with the longest text before its `*`, the first of them on a tie.
 */
function aliasFor(aliases: readonly Alias[], specifier: string): Alias | undefined {
  const exact = aliases.find((alias) => !alias.wildcard && alias.prefix === specifier);
  if (exact !== undefined) {
    return exact;
  }
  let best: Alias | undefined;
  for (const alias of aliases) {
    if (surrounds(alias, specifier) && alias.prefix.length > (best?.prefix.length ?? -1)) {
      best = alias;
    }
  }
  return best;
}

/**
 * A target's path: its `*` standing for what the key's stood for — `matched` — or, under a key
 * without one, where nothing was, a `*` as written.
 */
function pathOf(target: Pattern, matched = '*'): string {
  return target.wildcard ? `${target.prefix}${matched}${target.suffix}` : target.prefix;
}

/** The file a path names as TypeScript reads it: its TypeScript for `.js`, or itself, and so on. */
function fileOf(candidate: string): string | undefined {
  return typescriptFor(candidate) ?? fileFor(candidate);
}

/**
 * The path `specifier` names through the alias TypeScript takes for it: the first of its targets
 * that names a file, the `*` of each standing for what the key's stood for; or, for a bare
 * specifier no key matches, the path it names under `baseUrl`. Nothing where it names no file — a
 * key's targets that name no file are not followed by another key, as TypeScript follows none.
 */
function aliasTarget(aliases: Aliases, specifier: string): string | undefined {
  const alias = aliasFor(aliases.paths, specifier);
  if (alias === undefined) {
    const under = aliases.baseUrl === undefined ? undefined : path.join(aliases.baseUrl, specifier);
    return under !== undefined && BARE.test(specifier) && fileOf(under) !== undefined
      ? under
      : undefined;
  }
  const matched = alias.wildcard
    ? specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length)
    : undefined;
  return alias.targets
    .map((target) => pathOf(target, matched))
    .find((candidate) => fileOf(candidate) !== undefined);
}

/** The file `specifier` names through the alias TypeScript takes for it (`aliasTarget`). */
export function resolveAlias(aliases: Aliases, specifier: string): string | undefined {
  const target = aliasTarget(aliases, specifier);
  return target === undefined ? undefined : fileOf(target);
}

/**
 * Every file `specifier` may name through the alias TypeScript takes for it, to each of what may
 * load it: the file Node and TypeScript take, and, where the alias names a directory, the entries a
 * bundler may take besides — its `package.json`'s `module`, or its `browser` where that names a
 * file — none of which the browser and the authority may share.
 */
export function resolveAliasFiles(aliases: Aliases, specifier: string): readonly string[] {
  const target = aliasTarget(aliases, specifier);
  const file = target === undefined ? undefined : fileOf(target);
  if (target === undefined || file === undefined) {
    return [];
  }
  const bundled = ['module', 'browser'].map((field) => entryOf(target, field));
  return [...new Set([file, ...bundled.filter((entry) => entry !== undefined)])];
}
