import { isBuiltin } from 'node:module';
import path from 'node:path';

import {
  type ExportDeclaration,
  type ImportDeclaration,
  isCallExpression,
  isDecorator,
  isExportDeclaration,
  isExternalModuleReference,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isNamedExports,
  isNamespaceImport,
  isNoSubstitutionTemplateLiteral,
  isParameterDeclaration,
  isSourceFile,
  isStringLiteral,
  type Node,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { browserOnlyIn } from './browser-only.ts';
import { globalPathOf } from './code-globals.ts';
import {
  callsTable,
  type DatabaseExport,
  databaseNames,
  databaseUseIn,
} from './database-handle.ts';
import type { ImportBinding } from './imports.ts';
import type { ModuleKind, Modules } from './modules.ts';
import { runsAsGiven } from './runs-as-given.ts';
import { keptMethodWrite, keptWrite } from './settled.ts';
import { isScript } from './typescript.ts';
import { firstIn, untrackedAt } from './untracked-reads.ts';
import { useOf } from './uses.ts';

/**
 * What a route's document would take from somewhere other than its params and the database the
 * authority tracks, read off the application's code by its syntax: the session's identity, an input
 * nothing tracks — the clock, randomness, the network, the frames an error is made in — what a
 * function of the code keeps between calls, a library, the request itself. A module of the
 * application's is read whole, and every module of the application's it imports at run time with
 * it, as far as `follow` lets: conservative, as a route is shared only where none of it is found,
 * and the authority's own check at run time stands behind it.
 */

/** What was found, each the first of its kind: what a route's `private` reason names. */
export interface Facts {
  /** An identity API the code reaches: `requireUser`, `currentUser`. */
  readonly identity?: string;
  /**
   * A global the code reads that nothing tracks — `Date`, `crypto`, `fetch` — the frames of an
   * error it reads (`stack`, `Error.captureStackTrace`), a module of the platform's it imports
   * (`node:crypto`, `os`, `cloudflare:workers`), or one it loads by a name it computes
   * (`import()`), which the compile cannot classify.
   */
  readonly untracked?: string;
  /**
   * A name the code holds once, as a module loads, that a function of its writes each time it is
   * called — `banner` of `let banner` a setter assigns, a `Map` it `.set()`s, an object a method of
   * writes through `this` (`keptWrite`, `settled.ts`): what it keeps between calls, which no commit
   * announces the change of — but the application's database, a write through a table of which is
   * a commit (`callsTable`).
   */
  readonly kept?: string;
  /**
   * A use of the application's database a page, or what renders around it, reaches — a call,
   * `db.todos.findMany`, or a table or the handle held by another name or handed on, `db.todos`
   * (`databaseUseIn`) — which only the authority's evaluation answers, and Next.js's render of the
   * page throws for: none of a component's or a guard's, which the authority runs.
   */
  readonly database?: string;
  /** A library the code imports. */
  readonly library?: string;
  /** What reads the request: `next/headers`, `connection`. */
  readonly request?: string;
  /**
   * What reads the request's query as a part renders — `useSearchParams`, which a Client Component
   * reads as the server renders it as well as in the browser — wherever in the code a page renders.
   */
  readonly query?: string;
}

/** The framework's module whose identity APIs a component or a guard reads the session by. */
const SERVER = '@arkorlab/reactive-state/server';

/** The identity APIs: each reads the session, whatever it answers. */
const IDENTITY: ReadonlySet<string> = new Set(['currentUser', 'requireUser']);

/** What a module loaded by a name the code computes is said to read (`loadsUnnamed`). */
const UNNAMED_LOAD = 'import()';

/** The framework's own modules, whose reads the authority tracks: no library of the application's. */
const FRAMEWORK = /^(?:@arkorlab\/reactive-state(?:\/|$)|framework\/)/u;

/** Whether `specifier`, a module of no file of the application's of `kind`, is a library. */
function isLibrary(specifier: string, kind: ModuleKind): boolean {
  return kind === 'package' && !FRAMEWORK.test(specifier);
}

/** A specifier of a scheme, a platform's own: `node:os`, `cloudflare:workers`. */
const SCHEMED = /^[a-z][\d+.a-z-]*:/iu;

/**
 * Whether `specifier`, a module of no file of the application's, is the platform's own, of no
 * package: a built-in of Node's, bare or prefixed, as Node's own list has it (`isBuiltin`:
 * `crypto`, `node:os`, `perf_hooks`), or a module of another scheme the compile cannot read
 * (`cloudflare:workers`). What it answers is an input nothing tracks, as `Date`'s and `fetch`'s are
 * — the clock, randomness, the host, its files, its environment — whatever of it the code reads.
 */
function isPlatformModule(specifier: string): boolean {
  return isBuiltin(specifier) || SCHEMED.test(specifier);
}

/** What reads the request in Next.js: the module of `cookies()` and `headers()`, and `connection()`. */
const HEADERS = 'next/headers';
const NEXT_SERVER = 'next/server';
const CONNECTION = 'connection';
/** Next.js's modules of `useSearchParams`, which reads the request's query (`Facts.query`). */
const NEXT_NAVIGATION = 'next/navigation';
const NAVIGATION: ReadonlySet<string> = new Set(['next/compat/navigation', NEXT_NAVIGATION]);
const SEARCH_PARAMS_HOOK = 'useSearchParams';

/** Which modules of the application a read follows, by what each is to the compile. */
export type Follow = (kind: ModuleKind) => boolean;

/** The modules a component's server part, or a guard, reaches: those that run where it runs. */
const SERVER_KINDS: ReadonlySet<ModuleKind> = new Set(['package', 'server', 'shared']);

/** What a component's server part, or a guard, reaches: the modules that run where it runs. */
const followServer: Follow = (kind) => SERVER_KINDS.has(kind);

/** What a page, a layout or a template reaches as Next.js renders it: any module but a component. */
const followRendered: Follow = (kind) => kind !== 'component';

/** Every module of the application's a page reaches, a component's and the browser's among them. */
const followAll: Follow = () => true;

/**
 * What Next.js runs of what a page reaches as it renders it: any module but a component, which the
 * authority renders, and a server operation, which runs when it is called, not as a page renders.
 */
const followRenderedCode: Follow = (kind) => kind !== 'component' && kind !== 'operations';

/** No code skipped: a module read whole. */
const WHOLE = (): boolean => false;

/**
 * The first read among `nodes` of an input nothing tracks (`untrackedAt`) — and, with
 * `outsideFunctions`, outside the functions they hold (`runsElsewhere`): what runs as a part
 * renders, not what a handler runs later.
 */
export function untrackedIn(nodes: readonly Node[], outsideFunctions = false): string | undefined {
  return firstIn(nodes, untrackedAt, outsideFunctions ? runsElsewhere : WHOLE);
}

/** The functions whose bodies run when they are called, not where they stand. */
const FUNCTIONS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ArrowFunction,
  SyntaxKind.Constructor,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.GetAccessor,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.SetAccessor,
]);

/** Whether `node` is a function whose body runs when it is called, not where it stands. */
export function isFunctionLike(node: Node): boolean {
  return FUNCTIONS.has(node.kind);
}

/** What an object or a class holds that is a function, with a name and decorators run as it is made. */
type Owned = Node & { readonly body?: Node | undefined };

function isOwned(node: Node): node is Owned {
  return (
    node.kind === SyntaxKind.Constructor ||
    node.kind === SyntaxKind.GetAccessor ||
    node.kind === SyntaxKind.MethodDeclaration ||
    node.kind === SyntaxKind.SetAccessor
  );
}

/** Whether `fn`, a function, is called where it is written, once: `(() => Date.now())()`, past casts too. */
function isCalledInPlace(fn: Node): boolean {
  const { at, parent } = useOf(fn);
  return isCallExpression(parent) && parent.expression === at;
}

/**
 * Whether `node` runs elsewhere than where it stands: a function, when it is called — but one
 * called where it is written, or given to a call that runs it as it is made (`runsAsGiven`), runs there, and of a method or an accessor of an object or a class,
 * only its parameters and its body run when it is called: its computed key and its decorators, and
 * its parameters' decorators, run as the object or the class is made.
 */
function runsElsewhere(node: Node): boolean {
  if (isSourceFile(node)) {
    return false;
  }
  const { parent } = node;
  if (isParameterDeclaration(parent) && isOwned(parent.parent)) {
    return !isDecorator(node);
  }
  if (isOwned(parent)) {
    return node === parent.body;
  }
  return isFunctionLike(node) && !isOwned(node) && !isCalledInPlace(node) && !runsAsGiven(node);
}

/** One module a file imports, re-exports or loads, as the facts of it are read. */
interface Imported {
  readonly specifier: string;
  /** The names it brings, as the module exports them; `*` for all of them. */
  readonly names: readonly string[];
}

/**
 * The modules of Next.js's own that hold what its public ones export of the request and of the
 * query, or export it again, by the public module they stand for: an import of them is an import of
 * that. Next.js's navigation for React's server (`navigation.react-server`) is none of them: it
 * holds `notFound` and `redirect`, and no `useSearchParams`.
 */
const HELD_BY: ReadonlyMap<string, string> = new Map([
  ['next/dist/api/headers', HEADERS],
  ['next/dist/api/navigation', NEXT_NAVIGATION],
  ['next/dist/api/server', NEXT_SERVER],
  ['next/dist/client/components/navigation', NEXT_NAVIGATION],
  ['next/dist/server/request/connection', NEXT_SERVER],
  ['next/dist/server/request/cookies', HEADERS],
  ['next/dist/server/request/draft-mode', HEADERS],
  ['next/dist/server/request/headers', HEADERS],
  ['next/dist/server/web/exports', NEXT_SERVER],
  ['next/dist/server/web/exports/index', NEXT_SERVER],
]);

/** Where Next.js builds its own modules a second time, as ES modules, beside the CommonJS ones. */
const ESM_BUILD = 'next/dist/esm/';

/** The path a Next package URL names, without its query or fragment and after filename decoding. */
function nextPath(specifier: string): string {
  if (!specifier.startsWith('next/')) return specifier;
  const [pathname = ''] = specifier.split(/[?#]/u, 1);
  try {
    return path.posix.normalize(decodeURIComponent(pathname)).replace(/\/$/u, '');
  } catch {
    return specifier;
  }
}

/**
 * The module `specifier` names, as the facts of it are read: of its file (`next/headers.js`, which a
 * resolution of `nodenext` asks for) as of the module, of a module of Next.js's own in its ES
 * modules' build (`next/dist/esm/…`) as of the same module's other build, and of a module of
 * Next.js's own that holds what a public one exports (`HELD_BY`) as of that one.
 */
function moduleNamed(specifier: string): string {
  const named = nextPath(specifier);
  const bare = named.endsWith('.js') ? named.slice(0, -'.js'.length) : named;
  const built = bare.startsWith(ESM_BUILD) ? `next/dist/${bare.slice(ESM_BUILD.length)}` : bare;
  return HELD_BY.get(built) ?? built;
}

/** What `name`s of `specifier` make of facts, where the specifier is the framework's or Next.js's. */
function importedFacts(imported: Imported): Facts {
  const { names } = imported;
  const specifier = moduleNamed(imported.specifier);
  if (specifier === SERVER) {
    const identity = names.find((name) => name === '*' || IDENTITY.has(name));
    return identity === undefined ? {} : { identity: identity === '*' ? 'requireUser' : identity };
  }
  // A type of it alone reads nothing.
  if (specifier === HEADERS && names.length > 0) {
    return { request: HEADERS };
  }
  if (
    specifier === NEXT_SERVER &&
    names.some((name) => ['*', CONNECTION, 'default'].includes(name))
  ) {
    return { request: CONNECTION };
  }
  if (
    NAVIGATION.has(specifier) &&
    names.some((name) => ['*', 'default', SEARCH_PARAMS_HOOK].includes(name))
  ) {
    return { query: SEARCH_PARAMS_HOOK };
  }
  return {};
}

/** The names an import brings at run time: `default`, each it names, or `*`; none of types alone. */
function importedNames(statement: ImportDeclaration): readonly string[] | undefined {
  const clause = statement.importClause;
  if (clause?.phaseModifier === SyntaxKind.TypeKeyword) {
    return undefined;
  }
  const named = clause?.namedBindings;
  const names = clause?.name === undefined ? [] : ['default'];
  if (named === undefined) {
    return names;
  }
  if (isNamespaceImport(named)) {
    return [...names, '*'];
  }
  const values = named.elements.filter((element) => !element.isTypeOnly);
  return [...names, ...values.map((element) => (element.propertyName ?? element.name).text)];
}

/** The names a re-export brings at run time: each it names, or `*`; none of types alone. */
export function exportedNames(statement: ExportDeclaration): readonly string[] | undefined {
  if (statement.isTypeOnly) {
    return undefined;
  }
  const clause = statement.exportClause;
  return clause !== undefined && isNamedExports(clause)
    ? clause.elements
        .filter((element) => !element.isTypeOnly)
        .map((element) => (element.propertyName ?? element.name).text)
    : ['*'];
}

/** A literal external import assignment contributes a value only when it is not type-only. */
export function importEqualsSpecifier(node: Node): string | undefined {
  return isImportEqualsDeclaration(node) &&
    !node.isTypeOnly &&
    isExternalModuleReference(node.moduleReference) &&
    isStringLiteral(node.moduleReference.expression)
    ? node.moduleReference.expression.text
    : undefined;
}

/** The modules a file imports or re-exports at run time, with the names it brings of each. */
function importsOf(sourceFile: SourceFile): readonly Imported[] {
  const found: Imported[] = [];
  for (const statement of sourceFile.statements) {
    const external = importEqualsSpecifier(statement);
    if (external !== undefined) {
      found.push({ names: ['*'], specifier: external });
      continue;
    }
    const specifier =
      (isImportDeclaration(statement) || isExportDeclaration(statement)) &&
      statement.moduleSpecifier !== undefined &&
      isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : undefined;
    let names: readonly string[] | undefined;
    if (isImportDeclaration(statement)) {
      names = importedNames(statement);
    } else if (isExportDeclaration(statement)) {
      names = exportedNames(statement);
    }
    if (specifier !== undefined && names !== undefined) {
      found.push({ names, specifier });
    }
  }
  return [...found, ...loadsOf(sourceFile)];
}

/**
 * Whether a file loads a module it names as it runs (`import(name)`), which the compile cannot
 * classify: as it may be the platform's, or anything else's, an input nothing tracks — outside what
 * `skips` says runs elsewhere, as `firstIn` reads a file: the code of the browser alone, which the
 * server's render does not run.
 */
function loadsUnnamed(sourceFile: SourceFile, skips: (node: Node) => boolean = WHOLE): boolean {
  let found = false;
  const visit = (node: Node): void => {
    if (found || skips(node)) {
      return;
    }
    if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
      const [specifier] = node.arguments;
      found =
        specifier === undefined ||
        !(isStringLiteral(specifier) || isNoSubstitutionTemplateLiteral(specifier));
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return found;
}

/** Literal dynamic imports and unshadowed CommonJS calls retain their named source dependencies. */
function loadsOf(sourceFile: SourceFile): readonly Imported[] {
  const found: Imported[] = [];
  const visit = (node: Node): void => {
    if (
      isCallExpression(node) &&
      (node.expression.kind === SyntaxKind.ImportKeyword ||
        globalPathOf(unwrapped(node.expression))?.join('.') === 'require')
    ) {
      const [specifier] = node.arguments;
      if (
        specifier !== undefined &&
        (isStringLiteral(specifier) || isNoSubstitutionTemplateLiteral(specifier))
      ) {
        found.push({ names: ['*'], specifier: specifier.text });
      }
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return found;
}

/**
 * What of `facts` a Client Component's code is judged for as the server renders it: an input
 * nothing tracks, what it keeps between calls, a library — what reads the request or its query a
 * page's own reach tells, through every module (`renderedFacts`).
 */
function renderTimeOf(facts: Facts): Facts {
  const { kept, library, untracked } = facts;
  return {
    ...(untracked !== undefined && { untracked }),
    ...(kept !== undefined && { kept }),
    ...(library !== undefined && { library }),
  };
}

/** `facts` with what `more` found that `facts` had not. */
export function mergedFacts(facts: Facts, more: Facts): Facts {
  return { ...more, ...facts };
}

/** What one module of the application's is: its own facts, and the modules it reaches. */
interface Own {
  /** What its imports make of facts: an identity API, a request's, a library, the platform's. */
  readonly imported: Facts;
  /** Those, and what its code reads that nothing tracks or keeps between calls, read whole. */
  readonly facts: Facts;
  /** The application's modules it imports at run time, each with what it is to the compile. */
  readonly reached: readonly {
    readonly file: string;
    readonly kind: ModuleKind;
    /** Whether a value name is supplied, apart from the module's runtime initialization. */
    readonly value: boolean;
  }[];
}

/**
 * The facts of the application's modules, each read once: a module's own, then, through
 * `facts`, of every module of the application's it reaches as far as a `Follow` lets.
 */
export class Reach {
  readonly #modules: Modules;
  /** The application's database, where the compile names one it resolves. */
  readonly #database: DatabaseExport | undefined;
  readonly #own = new Map<string, Own>();
  /** The names each file imports the database by (`databaseNames`), read once. */
  readonly #handles = new WeakMap<SourceFile, ReadonlySet<string>>();
  /** The first use of the database each file makes (`databaseUseIn`), read once. */
  readonly #uses = new Map<string, string | undefined>();
  /** What each file holds as the server renders it (`#renderedOf`), read once. */
  readonly #rendered = new Map<string, Facts>();

  constructor(modules: Modules, database: DatabaseExport | undefined) {
    this.#modules = modules;
    this.#database = database;
  }

  /** The names `sourceFile` imports the application's database by, under any name. */
  #handlesOf(sourceFile: SourceFile): ReadonlySet<string> {
    let names = this.#handles.get(sourceFile);
    if (names === undefined) {
      const database = this.#database;
      names =
        database === undefined
          ? new Set<string>()
          : databaseNames(sourceFile, database, (specifier) =>
              this.#modules.resolve(specifier, sourceFile.fileName),
            );
      this.#handles.set(sourceFile, names);
    }
    return names;
  }

  /**
   * The name a write at `node` keeps between calls (`keptWrite`, `keptMethodWrite`) — but a call of
   * a method of a table of the application's database, of a name the file imports it by
   * (`callsTable`): a commit the authority tracks.
   */
  #keptAt(node: Node): string | undefined {
    const kept = keptWrite(node) ?? keptMethodWrite(node);
    if (kept === undefined) {
      return undefined;
    }
    const tracked = this.#handlesOf(node.getSourceFile()).has(kept.text) && callsTable(node, kept);
    return tracked ? undefined : kept.text;
  }

  /** The first use of the application's database `file` makes (`databaseUseIn`). */
  #useOf(file: string): string | undefined {
    const database = this.#database;
    if (database !== undefined && !this.#uses.has(file)) {
      const { sourceFile } = this.#modules.parse(file, false);
      this.#uses.set(
        file,
        databaseUseIn(sourceFile, {
          database,
          handles: this.#handlesOf(sourceFile),
          resolve: (specifier) => this.#modules.resolve(specifier, sourceFile.fileName),
        }),
      );
    }
    return this.#uses.get(file);
  }

  /** The first use of the application's database a module of `files` makes (`#useOf`). */
  #useIn(files: Iterable<string>): string | undefined {
    for (const file of files) {
      const use = this.#useOf(file);
      if (use !== undefined) {
        return use;
      }
    }
    return undefined;
  }

  #ownOf(file: string): Own {
    const known = this.#own.get(file);
    if (known !== undefined) {
      return known;
    }
    const { sourceFile } = this.#modules.parse(file, false);
    let facts: Facts = {};
    const reached: { file: string; kind: ModuleKind; value: boolean }[] = [];
    for (const imported of importsOf(sourceFile)) {
      facts = mergedFacts(facts, importedFacts(imported));
      const target = this.#modules.targetOf(imported.specifier, file);
      if (target.file !== undefined) {
        reached.push({ file: target.file, kind: target.kind, value: imported.names.length > 0 });
      } else if (isLibrary(imported.specifier, target.kind)) {
        facts = mergedFacts(facts, { library: imported.specifier });
      } else if (isPlatformModule(imported.specifier)) {
        facts = mergedFacts(facts, { untracked: imported.specifier });
      }
    }
    const untracked =
      untrackedIn([sourceFile]) ?? (loadsUnnamed(sourceFile) ? UNNAMED_LOAD : undefined);
    const kept = this.keptIn([sourceFile]);
    const own = {
      facts: mergedFacts(facts, {
        ...(untracked !== undefined && { untracked }),
        ...(kept !== undefined && { kept }),
      }),
      imported: facts,
      reached,
    };
    this.#own.set(file, own);
    return own;
  }

  /**
   * What `file` holds as the server renders it, as a Client Component's code is judged
   * (`renderTimeOf`): a library or a module of the platform's it imports, and what it reads that
   * nothing tracks or keeps between calls outside the code of the browser alone (`browserOnlyIn`) —
   * an event's handler, an effect's callback, a function nothing else reaches.
   */
  #renderedOf(file: string): Facts {
    let facts = this.#rendered.get(file);
    if (facts === undefined) {
      const { sourceFile } = this.#modules.parse(file, false);
      const skips = browserOnlyIn(sourceFile);
      const untracked =
        firstIn([sourceFile], untrackedAt, skips) ??
        (loadsUnnamed(sourceFile, skips) ? UNNAMED_LOAD : undefined);
      const kept = firstIn([sourceFile], (node) => this.#keptAt(node), skips);
      facts = renderTimeOf(
        mergedFacts(this.#ownOf(file).imported, {
          ...(untracked !== undefined && { untracked }),
          ...(kept !== undefined && { kept }),
        }),
      );
      this.#rendered.set(file, facts);
    }
    return facts;
  }

  /** Runtime dependency reach, or value-bearing paths alone for component render discovery. */
  #reached(files: Iterable<string>, follow: Follow, valuesOnly = false): ReadonlySet<string> {
    const seen = new Set<string>();
    const queue = [...files];
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      if (seen.has(file)) {
        continue;
      }
      seen.add(file);
      for (const next of this.#ownOf(file).reached) {
        if (
          (!valuesOnly || next.value) &&
          follow(next.kind) &&
          isScript(next.file) &&
          !seen.has(next.file)
        ) {
          queue.push(next.file);
        }
      }
    }
    return seen;
  }

  /**
   * What `bindings` make of facts by what they import — an identity API or a request's of the
   * framework's or Next.js's, a library, a module of the platform's — and the application's modules
   * they import that `follow` lets.
   */
  #boundOf(
    bindings: readonly ImportBinding[],
    follow: Follow,
  ): { readonly facts: Facts; readonly files: readonly string[] } {
    let facts: Facts = {};
    const files: string[] = [];
    for (const binding of bindings) {
      if (binding.typeOnly) {
        continue;
      }
      const { specifier, target } = binding.module;
      const name = binding.form === 'namespace' ? '*' : binding.exported;
      facts = mergedFacts(facts, importedFacts({ names: [name], specifier }));
      if (target.file !== undefined && follow(target.kind) && isScript(target.file)) {
        files.push(target.file);
      } else if (target.file === undefined && isLibrary(specifier, target.kind)) {
        facts = mergedFacts(facts, { library: specifier });
      } else if (target.file === undefined && isPlatformModule(specifier)) {
        facts = mergedFacts(facts, { untracked: specifier });
      }
    }
    return { facts, files };
  }

  /**
   * What the modules `files` reach as Next.js renders them (`followRenderedCode`) — a Client
   * Component's among them, which the server renders too — hold as it renders them (`#renderedOf`).
   */
  #clientFacts(files: Iterable<string>): Facts {
    let facts: Facts = {};
    for (const file of this.#reached(files, followRenderedCode)) {
      facts = mergedFacts(facts, this.#renderedOf(file));
    }
    return facts;
  }

  /**
   * The first name among `nodes` that the code holds once and a function of it writes each time
   * it is called — assigns, changes in place, or calls a method of that writes through `this` — of
   * what runs, as `firstIn` reads it (with `outsideFunctions`, as `untrackedIn` does): what the code
   * keeps between calls; none the database commits.
   */
  keptIn(nodes: readonly Node[], outsideFunctions = false): string | undefined {
    return firstIn(nodes, (node) => this.#keptAt(node), outsideFunctions ? runsElsewhere : WHOLE);
  }

  /** What `files`, modules of the application's, and every module they reach through `follow`, hold. */
  facts(files: Iterable<string>, follow: Follow): Facts {
    let facts: Facts = {};
    for (const file of this.#reached(files, follow)) {
      facts = mergedFacts(facts, this.#ownOf(file).facts);
    }
    return facts;
  }

  /**
   * What the code that reads `bindings` — the imports a component's server part or a guard reads —
   * reaches: what they import (`#boundOf`), and through the application's modules they import, what
   * they hold.
   */
  bindingFacts(bindings: readonly ImportBinding[]): Facts {
    const { facts, files } = this.#boundOf(bindings, followServer);
    return mergedFacts(facts, this.facts(files, followServer));
  }

  /**
   * What the code that reads `bindings` — the imports a component's browser part reads — reaches as
   * the server renders it: what they import (`#boundOf`), and through the application's modules
   * they import, what they hold outside the code of the browser alone (`#clientFacts`).
   */
  browserFacts(bindings: readonly ImportBinding[]): Facts {
    const { facts, files } = this.#boundOf(bindings, followRenderedCode);
    return renderTimeOf(mergedFacts(facts, this.#clientFacts(files)));
  }

  /**
   * What `file` — a page, or a layout, a template or a loading state around one — reaches as
   * Next.js renders it: what reads the request, through every module of the application's but a
   * component; what reads its query (`useSearchParams`), through every module of the application's,
   * a Client Component's and a component's browser part among them, as the server renders them too;
   * and the session's identity, an input nothing tracks and a library, through the modules that run
   * where it runs, as a component's server part is judged — itself read whole, as every line of a
   * Server Component may run as it renders, and no Client Component it renders, whose handlers run
   * in the browser. A reactive component it renders is judged as a root's are
   * (`renderedComponents`). And a use of the application's database, through what Next.js runs as
   * it renders it (`followRenderedCode`), which the authority's evaluation alone answers.
   */
  renderedFacts(file: string): Facts {
    const { request } = this.facts([file], followRendered);
    const { query } = this.facts([file], followAll);
    const served = mergedFacts(this.facts([file], followServer), this.#clientFacts([file]));
    const database = this.#useIn(this.#reached([file], followRenderedCode));
    return {
      ...served,
      ...(database !== undefined && { database }),
      ...(request !== undefined && { request }),
      ...(query !== undefined && { query }),
    };
  }

  /**
   * The ids of the reactive components `files` — a page, and the layouts, templates and loading
   * states around it — render as Next.js renders them: each one of them, or a module of the
   * application's they reach but a component, imports. What a component renders in turn the compile
   * reads of the component itself (`sides.refs`), as it reads a root's. With `valuesOnly`, guard
   * association follows value-bearing paths; runtime effects and other facts keep their own reach.
   */
  renderedComponents(files: Iterable<string>, valuesOnly = false): ReadonlySet<string> {
    const components = new Set<string>();
    for (const file of this.#reached(files, followRendered, valuesOnly)) {
      for (const next of this.#ownOf(file).reached) {
        const id =
          next.kind === 'component' && (!valuesOnly || next.value)
            ? this.#modules.idOf(next.file, next.kind)
            : undefined;
        if (id !== undefined) {
          components.add(id);
        }
      }
    }
    return components;
  }
}
