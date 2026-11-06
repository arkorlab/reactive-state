import { readFileSync, realpathSync } from 'node:fs';
// Added in Node 22.15 and 23.5, so every Node 24 has them, and a release candidate since 24.13.1 and
// 25.4: the synchronous hooks, which resolve an import in the thread that makes it, before anything
// that imports the programs is loaded.
// eslint-disable-next-line n/no-unsupported-features/node-builtins -- see above
import { type ResolveFnOutput, type ResolveHookContext, registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  aliasesOf,
  fileFor,
  isFile,
  manifestOf,
  packageDirectory,
  resolveAlias,
  typescriptFor,
} from './aliases.ts';

/**
 * Lets Node load an application's modules by the path aliases its `tsconfig.json` declares — the
 * `@/db` a component's program imports — as Next.js and the Durable Object's bundler already do. A
 * component's program keeps the application's specifiers as the component wrote them, and Node,
 * unlike both, reads no tsconfig.
 *
 * Synchronous, in-thread hooks (`module.registerHooks`): registered before anything that imports
 * the programs is imported, they resolve every later import the application's modules make, static
 * or not, as TypeScript resolves it (`aliases.ts`); a TypeScript file is loaded as Node loads one,
 * an ES module or CommonJS as its extension, its package's `type` and its syntax make it. A `.tsx` or
 * `.jsx` file is refused: Node runs no JSX, and a module the authority loads is never one the
 * browser's code needs.
 */

const TYPESCRIPT = /\.[cm]?ts$/u;
const JSX = /\.[jt]sx$/u;
/** What marks a JSON document the hooks load as a module whose default it is. */
const AS_MODULE = 'reactive-state-json';
const RELATIVE = /^\.\.?\//u;
const NODE_MODULES = /[/\\]node_modules[/\\]/u;
/**
 * A specifier Node resolves as a package's name: neither a path nor a URL — `node:fs` is one — nor
 * one of the importing package's own `#` imports.
 */
const PACKAGE_NAME = /^(?![./#]|[a-z][\w+.-]*:)/iu;

/**
 * The file a relative specifier names from a module of the application's own — `application`, its
 * TypeScript or its JavaScript — as TypeScript and the bundlers resolve it where Node would not:
 * `./x.js` is `./x.ts` where there is one — though an `x.js` stands beside it, which TypeScript
 * does not check — and a specifier that names no file gets an extension, or a directory's `index`.
 * Nothing where the specifier names a file as written and no TypeScript file stands for it, which
 * Node resolves itself, nor for a package's JavaScript, which is resolved as its own
 * `package.json` says, nor for anything under `node_modules`. A TypeScript package linked in from
 * elsewhere, as a workspace's is, is resolved as the application's modules are, as a bundler
 * resolves it: Node, which would not, runs no TypeScript under `node_modules` either.
 */
function siblingOf(
  specifier: string,
  parentURL: string | undefined,
  application: boolean,
): string | undefined {
  if (!RELATIVE.test(specifier) || parentURL?.startsWith('file:') !== true) {
    return undefined;
  }
  const parent = fileURLToPath(parentURL);
  if (NODE_MODULES.test(parent) || !(application || TYPESCRIPT.test(parent))) {
    return undefined;
  }
  const candidate = path.resolve(path.dirname(parent), specifier);
  const typescript = typescriptFor(candidate);
  if (typescript !== undefined) {
    return typescript;
  }
  if (isFile(candidate)) {
    // A JSON document as written is the hooks' to load, where Node would ask for an attribute.
    return candidate.endsWith('.json') ? candidate : undefined;
  }
  return fileFor(candidate);
}

/**
 * A JSON document an application module imports: as Node loads one, where the import says it is
 * JSON (`with { type: 'json' }`), or refuses one, where it names any other attribute; and, where it
 * names none — as TypeScript and the bundlers let an application write it, and Node refuses — as a
 * module of the hooks' own, whose default it is.
 */
function jsonResolution(
  file: string,
  attributes: Readonly<Partial<Record<string, string>>> | undefined,
): { readonly format?: string; readonly shortCircuit: true; readonly url: string } {
  const url = pathToFileURL(file);
  if (attributes?.['type'] === 'json') {
    return { format: 'json', shortCircuit: true, url: url.href };
  }
  // Another `type`, or a key but `type`, is Node's to refuse, as it refuses one of any JSON
  // document it loads — and as a Durable Object's bundler does: the hooks' module, which Node
  // checks no attribute of, would take it for none.
  if (Object.keys(attributes ?? {}).length > 0) {
    return { shortCircuit: true, url: url.href };
  }
  url.searchParams.set(AS_MODULE, '');
  return { shortCircuit: true, url: url.href };
}

/** The directory of the package `file` is in: of the nearest `package.json`, its own or above. */
function packageScope(file: string): string | undefined {
  let directory = path.dirname(file);
  for (;;) {
    if (isFile(path.join(directory, 'package.json'))) {
      return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

/**
 * Whether a `#` import leads out of the package that makes it, into another: its `imports` map it
 * to a package's name, which Node resolves — a package linked in, as a workspace's is, by where the
 * link leads — rather than to a path of its own.
 */
function intoAnotherPackage(parentURL: string | undefined, url: string): boolean {
  return (
    parentURL?.startsWith('file:') === true &&
    url.startsWith('file:') &&
    packageScope(fileURLToPath(parentURL)) !== packageScope(fileURLToPath(url))
  );
}

/**
 * The file a subpath of a package that declares no `exports` names as the bundlers take it — itself
 * with an extension, or a directory's entry — which Node, for a package's subpath, does not look
 * for; none for any other specifier.
 */
function legacySubpathFile(specifier: string, parentURL: string | undefined): string | undefined {
  if (!PACKAGE_NAME.test(specifier)) {
    return undefined;
  }
  const [first = '', second = ''] = specifier.split('/', 2);
  const name = first.startsWith('@') ? `${first}/${second}` : first;
  const subpath = specifier.slice(name.length + 1);
  const from =
    parentURL?.startsWith('file:') === true
      ? path.dirname(fileURLToPath(parentURL))
      : process.cwd();
  const packageDir = subpath === '' ? undefined : packageDirectory(name, from);
  // `exports` of `null` is none, as Node takes it.
  const exports = packageDir === undefined ? undefined : manifestOf(packageDir)?.['exports'];
  if (packageDir === undefined || (exports !== undefined && exports !== null)) {
    return undefined;
  }
  const file = fileFor(path.join(packageDir, subpath));
  return file === undefined ? undefined : realpathSync(file);
}

/**
 * What Node answers for a subpath of a package of no `exports` that names no file as it is: none
 * where it names nothing, and a refusal where it names a directory, which an ES module does not
 * import.
 */
const NOT_A_FILE: ReadonlySet<unknown> = new Set([
  'ERR_MODULE_NOT_FOUND',
  'ERR_UNSUPPORTED_DIR_IMPORT',
]);

/**
 * Node's resolution of a specifier the hooks found no file for; or, where Node finds none for a
 * subpath of a package of no `exports` — or a directory, which it refuses — the file the bundlers,
 * and a Durable Object's bundle, take for it.
 */
function resolvedByNode(
  specifier: string,
  context: ResolveHookContext,
  nextResolve: (specifier: string, context?: Partial<ResolveHookContext>) => ResolveFnOutput,
): ResolveFnOutput {
  let resolved: ResolveFnOutput;
  try {
    resolved = nextResolve(specifier, context);
  } catch (error) {
    const file = NOT_A_FILE.has((error as { readonly code?: unknown }).code)
      ? legacySubpathFile(specifier, context.parentURL)
      : undefined;
    if (file === undefined) {
      throw error;
    }
    resolved = { shortCircuit: true, url: pathToFileURL(file).href };
  }
  return jsonImported(resolved, context);
}

/**
 * A JSON document Node resolved for an import — a package's `exports` may name one — made the
 * module the hooks make of one the application names by a path (`jsonResolution`): imported without
 * an attribute, as the bundlers take it, Node would refuse it. A `require` reads JSON itself.
 */
function jsonImported(resolved: ResolveFnOutput, context: ResolveHookContext): ResolveFnOutput {
  if (!resolved.url.startsWith('file:') || !context.conditions.includes('import')) {
    return resolved;
  }
  const file = fileURLToPath(resolved.url);
  return file.endsWith('.json') ? jsonResolution(file, context.importAttributes) : resolved;
}

/**
 * How the hooks resolve `specifier` to `file`, a file they found for it, for the import or the
 * `require` `context` says: a JSON document is made a module for an import alone, as one Node
 * resolved is (`jsonImported`). A `require` reads JSON itself.
 */
function resolutionOf(
  specifier: string,
  file: string,
  context: ResolveHookContext,
): { readonly format?: string; readonly shortCircuit: true; readonly url: string } {
  if (JSX.test(file)) {
    throw new Error(
      `${specifier} is ${file}, which Node cannot run: what the authority imports holds no JSX, and the browser's components are imported by the Client Component alone.`,
    );
  }
  if (file.endsWith('.json') && context.conditions.includes('import')) {
    return jsonResolution(file, context.importAttributes);
  }
  // `.mts` and `.cts` say what they are; a `.ts` file is what its package's `type` and its own
  // syntax make it, which Node tells as it loads it.
  return {
    ...(file.endsWith('.mts') && { format: 'module-typescript' }),
    ...(file.endsWith('.cts') && { format: 'commonjs-typescript' }),
    shortCircuit: true,
    url: pathToFileURL(file).href,
  };
}

/** The lines that export the JSON object's `key` by its own name, the `index`th of them. */
function namedExport(key: string, index: number): string {
  const local = `key${String(index)}`;
  return `const ${local} = value[${JSON.stringify(key)}];\nexport { ${local} as ${JSON.stringify(key)} };`;
}

/**
 * The source of a module whose default is the JSON document `text`, parsed as JSON — written into
 * the module as an object literal, a `"__proto__"` key would set a prototype rather than make a
 * property — and which, as the bundlers have it, exports each of an object's keys by its own name,
 * `default` apart: a string's name, which a key no identifier could be takes as well.
 */
function jsonModule(text: string): string {
  const parsed: unknown = JSON.parse(text);
  const keys =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? Object.keys(parsed).filter((key) => key !== 'default')
      : [];
  return [
    `const value = JSON.parse(${JSON.stringify(text)});`,
    'export default value;',
    ...keys.map((key, index) => namedExport(key, index)),
    '',
  ].join('\n');
}

/**
 * Resolves the path aliases `tsconfig` declares for every import the application's modules make
 * from now on, in this thread, and the relative imports of the application's own TypeScript modules
 * as TypeScript resolves them: `tsconfig`'s own `paths` and `baseUrl`, or those it inherits
 * through `extends`.
 */
export function registerPaths(tsconfig: string): void {
  const aliases = aliasesOf(path.resolve(tsconfig));
  /**
   * The packages' modules, by URL: what a package's name leads to, and all those import. Node names
   * a package linked in, as a workspace's is, by where the link leads, which need not be under
   * `node_modules`. Any other importer is the application's: its entry, what `--import` loads, the
   * code `-e` runs, and what they import by a path, an alias or a `#` import.
   */
  const packages = new Set<string>();
  const ofPackage = (parentURL: string | undefined): boolean => {
    return (
      parentURL !== undefined &&
      (packages.has(parentURL) ||
        (parentURL.startsWith('file:') && NODE_MODULES.test(fileURLToPath(parentURL))))
    );
  };
  registerHooks({
    resolve(specifier, context, nextResolve) {
      // The application's aliases are the application's: a package's imports are resolved as its
      // own `package.json` says, though a name of one is also a path the application declares.
      const fromPackage = ofPackage(context.parentURL);
      const file =
        (fromPackage ? undefined : resolveAlias(aliases, specifier)) ??
        siblingOf(specifier, context.parentURL, !fromPackage);
      const resolution =
        file === undefined
          ? resolvedByNode(specifier, context, nextResolve)
          : resolutionOf(specifier, file, context);
      // A package's name, or a `#` import, that leads into the importer's own package — the
      // application naming itself — leads into the application still.
      if (
        fromPackage ||
        (file === undefined &&
          (PACKAGE_NAME.test(specifier) || specifier.startsWith('#')) &&
          intoAnotherPackage(context.parentURL, resolution.url))
      ) {
        packages.add(resolution.url);
      }
      return resolution;
    },
    load(url, context, nextLoad) {
      const document = new URL(url);
      if (!document.searchParams.has(AS_MODULE)) {
        return nextLoad(url, context);
      }
      document.search = '';
      // Parsed as JSON, as a JSON module is: written into the module as an object literal, a
      // `"__proto__"` key would set a prototype rather than make a property.
      // A byte-order mark is no JSON, and Node's own JSON modules skip it too.
      const text = readFileSync(fileURLToPath(document), 'utf8').replace(/^\u{FEFF}/u, '');
      return { format: 'module', shortCircuit: true, source: jsonModule(text) };
    },
  });
}
