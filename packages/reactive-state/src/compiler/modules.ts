import { readFileSync, realpathSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';

import {
  type CallExpression,
  type ExportDeclaration,
  type ImportDeclaration,
  isCallExpression,
  isExportDeclaration,
  isExpressionStatement,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isJsxElement,
  isJsxFragment,
  isJsxSelfClosingElement,
  isStringLiteral,
  type Node,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';
import type { API } from 'typescript/sync';

import {
  type Aliases,
  aliasesOf,
  NO_ALIASES,
  nearestTsconfig,
  resolveAliasFiles,
} from '../authority/aliases.ts';
import { isErased, readsCodeGlobal } from './code-globals.ts';
import { literalSpecifier } from './load-specifiers.ts';
import { moduleFile, type ModuleResolution } from './module-resolutions.ts';
import { browserMapped, ManifestStore, packageFiles, type Side } from './packages.ts';
import { unsettledIn } from './settled.ts';
import { TypeSession } from './type-checker.ts';
import { checkSyntax, isScript, parseModule } from './typescript.ts';

/**
 * What each module a component or a custom hook imports is to the compile, read off the module's
 * own file where it is the application's:
 *
 * - `component`: a `.reactive.tsx` component, which renders as an element;
 * - `operations`: a `'use server'` module, whose functions a page calls through the authority;
 * - `client`: a `'use client'` module, the browser's, whose components the host renders by name;
 * - `hooks`: a module of custom hooks, which import `framework/react`;
 * - `shared`: a module of the application's that runs anywhere, the same on every side — its own
 *   imports only other such modules, or types, and it makes no code of text (`holdsRunTime`) —
 *   which the authority, an update and the browser may all read;
 * - `server`: a module that runs on the authority alone — one that reads the framework's server, a
 *   Node built-in, or another such module — which no browser code may read;
 * - `element`: React and Next.js, whose components the host renders by name;
 * - `package`: anything else — a library, a module of the application's that reads one — which is
 *   imported on the one side that reads it, as the second protocol had every module.
 */
export type ModuleKind =
  | 'client'
  | 'component'
  | 'element'
  | 'hooks'
  | 'operations'
  | 'package'
  | 'server'
  | 'shared';

/** One module, as a specifier names it from one file. */
export interface ModuleClass {
  readonly kind: ModuleKind;
  /** The application's file the module is, for one of its own; none for a package. */
  readonly file: string | undefined;
  /**
   * Its id: its path in the compile's source directory, `/`-separated, without its extension — or,
   * for a component, without `.reactive.tsx`. None for a module outside the directory.
   */
  readonly id: string | undefined;
  /**
   * Of a `shared` module, what makes its code answer otherwise each time, or on each side, it runs —
   * of chance, of the time, of where it runs, of what it keeps between calls — its own, or a shared
   * module's it imports (`settled.ts`); none of one of what it is given alone.
   */
  readonly unsettled?: string | undefined;
}

/** The suffix a component's file carries, which its id is named without. */
export const COMPONENT_SUFFIX = '.reactive.tsx';

/** The module the intrinsic is imported from, which no output imports. */
export const FRAMEWORK = 'framework/react';

/** The packages whose components the host renders by name: React's and Next.js's. */
const ELEMENT_PACKAGE = /^(?:next|react|react-dom)(?:\/|$)/u;

/** The framework's modules that run on the server alone; `program`, `react` and `store` run anywhere. */
const SERVER_PACKAGE = /^@arkorlab\/reactive-state\/(?!(?:program|react|store)$)/u;

/** What a module that opens with a directive is, whatever it imports. */
const DIRECTED = { 'use client': 'client', 'use server': 'operations' } as const;

/** Paths retain their existing package-identity classification. */
const PATH = /^(?:\.{1,2}(?:\/|$)|\/)/u;

/** What a package specifier is to the compile. */
function packageKind(specifier: string): ModuleKind {
  if (ELEMENT_PACKAGE.test(specifier)) {
    return 'element';
  }
  const server =
    specifier === 'server-only' ||
    specifier.startsWith('cloudflare:') ||
    isBuiltin(specifier) ||
    SERVER_PACKAGE.test(specifier);
  return server ? 'server' : 'package';
}

/** A module's text and its parse, held while the compile runs. */
export interface ParsedModule {
  readonly file: string;
  /** How what is refused names it: its path from the source directory. */
  readonly name: string;
  readonly text: string;
  readonly sourceFile: SourceFile;
}

/** One import of a module, as its classification reads it. */
interface Dependency {
  readonly specifier: string;
  /** Whether it brings types alone, which run nothing. */
  readonly typeOnly: boolean;
}

/** What a module of no directive is, by what it imports: shared, the authority's, or one side's. */
type DependedKind = 'package' | 'server' | 'shared';

/** The order the kinds a module's dependencies make it take precedence in. */
const RANK: Readonly<Record<DependedKind, number>> = {
  package: 1,
  server: 2,
  shared: 0,
};

/**
 * The application's modules as the compile reads them: where a specifier leads, what each file is,
 * and the text of every file read, which the build's id hashes.
 */
export class Modules implements Disposable {
  readonly #api: API;
  readonly #srcDir: string;
  readonly #stack = new DisposableStack();
  readonly #parsed = new Map<string, ParsedModule>();
  readonly #checked = new Set<string>();
  readonly #kinds = new Map<string, ModuleKind>();
  readonly #aliases = new Map<string, Aliases>();
  readonly #resolutions = new Map<string, ModuleResolution>();
  /** What each specifier names on each side, from each directory (`identities`). */
  readonly #identities = new Map<string, readonly string[]>();
  /** The manifests the compile's lookups read through `packages.ts`, each read once. */
  readonly #manifests = new ManifestStore();
  /** The files whose kind is being read: one read again is read through a cycle of imports. */
  readonly #reading = new Set<string>();
  /** Each file whose kind its imports made, which a cycle may raise once its other kinds are known. */
  readonly #derived = new Set<string>();
  /** Whether the read under way met a cycle, whose modules' kinds wait on one another's. */
  #cycled = false;
  /** What makes each shared file answer otherwise as it runs, read once: none of a settled one. */
  readonly #unsettled = new Map<string, { readonly reason: string | undefined }>();
  /** The compile's programs, which the checker reads the modules' declared types in. */
  readonly #types: TypeSession;

  /** `outDir`, where given, is where the compile writes: none of it is an input of the checker's. */
  constructor(api: API, srcDir: string, outDir?: string) {
    this.#api = api;
    this.#srcDir = srcDir;
    this.#types = this.#stack.use(new TypeSession(api, outDir));
  }

  /** What a module of no directive is, by what it imports and what it holds. */
  #dependedKind(file: string, sourceFile: SourceFile): ModuleKind {
    const dependencies = dependenciesOf(sourceFile);
    if (dependencies.some((dependency) => dependency.specifier === FRAMEWORK)) {
      return 'hooks';
    }
    let kind: DependedKind = holdsRunTime(sourceFile) ? 'package' : 'shared';
    for (const dependency of dependencies) {
      if (dependency.typeOnly) {
        continue;
      }
      const target = this.resolve(dependency.specifier, file);
      const depended =
        target === undefined ? packageKind(dependency.specifier) : this.kindOf(target);
      const as = dependedAs(depended);
      if (RANK[as] > RANK[kind]) {
        kind = as;
      }
    }
    return kind;
  }

  /**
   * The kinds a cycle read too early, raised: a module of a cycle read the kind of one still being
   * read — `shared` until it was known — so each module whose imports made its kind is read again
   * against the kinds known now, until none changes. A kind only rises (`RANK`), so it ends.
   */
  #settle(): void {
    for (let changed = true; changed;) {
      changed = false;
      for (const file of this.#derived) {
        const kind = this.#dependedKind(file, this.parse(file, false).sourceFile);
        if (kind !== this.#kinds.get(file)) {
          this.#kinds.set(file, kind);
          changed = true;
        }
      }
    }
  }

  #aliasesFor(importer: string): Aliases {
    const tsconfig = nearestTsconfig(importer);
    if (tsconfig === undefined) {
      return NO_ALIASES;
    }
    let aliases = this.#aliases.get(tsconfig);
    if (aliases === undefined) {
      aliases = aliasesOf(tsconfig);
      this.#aliases.set(tsconfig, aliases);
    }
    return aliases;
  }

  /**
   * What `specifier` names from `importer` on `side` (`identities`), of which `importer` gives its
   * directory alone: where its `tsconfig.json`, its package and the packages it imports are looked
   * for from.
   */
  #identitiesOf(specifier: string, importer: string, side: Side): readonly string[] {
    const aliased = resolveAliasFiles(this.#aliasesFor(importer), specifier);
    if (aliased.length > 0) {
      const mapped = aliased.flatMap((file) => [file, ...browserMapped(file, this.#manifests)]);
      return [specifier, ...new Set(mapped.map((file) => realFile(file)))];
    }
    if (isBuiltin(specifier)) {
      return [specifier, `node:${specifier.replace(/^node:/u, '')}`];
    }
    return PATH.test(specifier) || /^[a-z][\w+.-]*:/iu.test(specifier)
      ? [specifier]
      : [specifier, ...packageFiles(specifier, path.dirname(importer), side, this.#manifests)];
  }

  /** The application's shared modules `file` imports as it runs, not as types alone. */
  #sharedImports(file: string, sourceFile: SourceFile): readonly string[] {
    return dependenciesOf(sourceFile).flatMap((dependency) => {
      const target = dependency.typeOnly ? undefined : this.resolve(dependency.specifier, file);
      return target !== undefined && this.kindOf(target) === 'shared' ? [target] : [];
    });
  }

  [Symbol.dispose](): void {
    this.#stack.dispose();
  }

  /**
   * Every file the checker's programs read that no module of the compile's is, by its path, with
   * its text: none where the compile asked the checker nothing.
   */
  typeReads(): ReadonlyMap<string, string> {
    return this.#types.reads();
  }

  /** Every file the compile has read, by its path, with its text. */
  sources(): ReadonlyMap<string, string> {
    return new Map([...this.#parsed].map(([file, parsed]) => [file, parsed.text]));
  }

  /**
   * Every configuration the compile has read its aliases from — the `tsconfig.json` nearest each
   * module it resolved a specifier of, and each that one extends — by its path, with its text.
   */
  configurations(): ReadonlyMap<string, string> {
    return new Map(
      [...this.#aliases.values()].flatMap((aliases) =>
        aliases.files.map(({ file, text }) => [file, text] as const),
      ),
    );
  }

  /** Every distinct module choice made during admission, including unresolved candidates. */
  resolutions(): readonly ModuleResolution[] {
    return [...this.#resolutions.values()];
  }

  /** How what is refused names `file`: its path from the source directory, `/`-separated. */
  nameOf(file: string): string {
    return path.relative(this.#srcDir, file).split(path.sep).join('/');
  }

  /** The parse of `file`, its syntax refused where it is wrong when `checked`. */
  parse(file: string, checked: boolean): ParsedModule {
    let parsed = this.#parsed.get(file);
    if (parsed === undefined) {
      const text = readFileSync(file, 'utf8');
      const lease = this.#stack.use(parseModule(this.#api, file, text, this.#types));
      parsed = { file, name: this.nameOf(file), sourceFile: lease.sourceFile, text };
      this.#parsed.set(file, parsed);
    }
    if (checked && !this.#checked.has(file)) {
      checkSyntax(this.#api, file, parsed.text, parsed.name);
      this.#checked.add(file);
    }
    return parsed;
  }

  /** What `specifier`, imported by `importer`, is. */
  targetOf(specifier: string, importer: string): ModuleClass {
    const file = this.resolve(specifier, importer);
    if (file === undefined) {
      return { file: undefined, id: undefined, kind: packageKind(specifier) };
    }
    const kind = this.kindOf(file);
    const unsettled = kind === 'shared' ? this.unsettledOf(file) : undefined;
    return { file, id: this.idOf(file, kind), kind, unsettled };
  }

  /**
   * What makes the application's shared `file` answer otherwise each time, or on each side, it runs
   * (`ModuleClass.unsettled`): its own code (`unsettledIn`), or a shared module's it imports — through
   * what that imports in turn, a cycle too.
   */
  unsettledOf(file: string): string | undefined {
    const known = this.#unsettled.get(file);
    if (known !== undefined) {
      return known.reason;
    }
    const seen = new Set<string>([file]);
    const pending = [file];
    let reason: string | undefined;
    for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
      const { name, sourceFile } = this.parse(next, false);
      const own = unsettledIn(sourceFile);
      if (own !== undefined) {
        reason = next === file ? `its code ${own}` : `\`${name}\`, which it imports, ${own}`;
        break;
      }
      for (const target of this.#sharedImports(next, sourceFile)) {
        if (!seen.has(target)) {
          seen.add(target);
          pending.push(target);
        }
      }
    }
    this.#unsettled.set(file, { reason });
    return reason;
  }

  /**
   * The application's file `specifier` names from `importer` — a path, or an alias of its
   * `tsconfig.json` — as TypeScript resolves it; none for a package's.
   */
  resolve(specifier: string, importer: string): string | undefined {
    const file = moduleFile(specifier, importer, () => this.#aliasesFor(importer));
    const resolution = { importer, specifier, file: file ?? null };
    this.#resolutions.set(JSON.stringify(resolution), resolution);
    return file;
  }

  /**
   * The files `specifier` may name from `importer` on `side`, to each of what loads that side —
   * itself as written among them — so that two specifiers of one module are one module where a
   * module is imported on one side alone (`packages.ts`). Looked up once a compile, by the side, the
   * importer's directory and the specifier (`#identitiesOf`).
   */
  identities(specifier: string, importer: string, side: Side): readonly string[] {
    const key = JSON.stringify([side, path.dirname(importer), specifier]);
    let known = this.#identities.get(key);
    if (known === undefined) {
      known = this.#identitiesOf(specifier, importer, side);
      this.#identities.set(key, known);
    }
    return known;
  }

  /** What the application's `file` is. */
  kindOf(file: string): ModuleKind {
    const known = this.#kinds.get(file);
    if (known !== undefined) {
      if (this.#reading.has(file)) {
        this.#cycled = true;
      }
      return known;
    }
    if (file.endsWith(COMPONENT_SUFFIX)) {
      this.#kinds.set(file, 'component');
      return 'component';
    }
    if (!isScript(file)) {
      this.#kinds.set(file, 'package');
      return 'package';
    }
    // Shared while it is read, so that two modules that import each other are what the rest of
    // their imports make them, once the read that met the cycle is over (`#settle`).
    this.#kinds.set(file, 'shared');
    this.#reading.add(file);
    let kind: ModuleKind;
    try {
      const { sourceFile } = this.parse(file, false);
      const directive = directiveOf(sourceFile);
      if (directive === undefined) {
        kind = this.#dependedKind(file, sourceFile);
        this.#derived.add(file);
      } else {
        // What an operation runs is the authority's, and what a Client Component runs the page's,
        // as much as a component's own code is: what either imports is read too, which the build's
        // id hashes, so that a page of an older build is told it is one.
        this.#dependedKind(file, sourceFile);
        kind = DIRECTED[directive];
      }
    } finally {
      this.#reading.delete(file);
    }
    this.#kinds.set(file, kind);
    if (this.#reading.size === 0 && this.#cycled) {
      this.#cycled = false;
      this.#settle();
    }
    return this.#kinds.get(file) ?? kind;
  }

  idOf(file: string, kind: ModuleKind): string | undefined {
    const relative = path.relative(this.#srcDir, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return undefined;
    }
    const named = relative.split(path.sep).join('/');
    return named.slice(
      0,
      kind === 'component' ? -COMPONENT_SUFFIX.length : named.length - path.extname(named).length,
    );
  }
}

/** What importing a module of `kind` makes a module of no directive. */
function dependedAs(kind: ModuleKind): DependedKind {
  switch (kind) {
    case 'shared': {
      return 'shared';
    }
    case 'server':
    case 'operations': {
      return 'server';
    }
    case 'client':
    case 'component':
    case 'element':
    case 'hooks':
    case 'package': {
      return 'package';
    }
  }
}

function realFile(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

/** The directive a module opens with, `'use server'` or `'use client'`, if it does. */
function directiveOf(sourceFile: SourceFile): keyof typeof DIRECTED | undefined {
  for (const statement of sourceFile.statements) {
    if (!isExpressionStatement(statement) || !isStringLiteral(statement.expression)) {
      return undefined;
    }
    const { text } = statement.expression;
    if (Object.hasOwn(DIRECTED, text)) {
      return text as keyof typeof DIRECTED;
    }
  }
  return undefined;
}

/**
 * What an import declaration brings: a module, and whether types alone — only a declaration of
 * `import type` brings types alone. With `verbatimModuleSyntax`, `import { type T } from './x'` is
 * written `import {} from './x'` and the module runs, so inline `type` specifiers do not make one.
 */
function importDependency(statement: ImportDeclaration): Dependency | undefined {
  if (!isStringLiteral(statement.moduleSpecifier)) {
    return undefined;
  }
  const typeOnly = statement.importClause?.phaseModifier === SyntaxKind.TypeKeyword;
  return { specifier: statement.moduleSpecifier.text, typeOnly };
}

/**
 * What an export of another module's brings: a module, and whether types alone — only a declaration
 * of `export type` does, as of an import (`importDependency`).
 */
function exportDependency(statement: ExportDeclaration): Dependency | undefined {
  const { moduleSpecifier } = statement;
  if (moduleSpecifier === undefined || !isStringLiteral(moduleSpecifier)) {
    return undefined;
  }
  return { specifier: moduleSpecifier.text, typeOnly: statement.isTypeOnly };
}

/** Each module a module imports or exports from, and whether it brings types alone. */
function dependenciesOf(sourceFile: SourceFile): readonly Dependency[] {
  return [...declaredDependencies(sourceFile), ...runtimeLoads(sourceFile)];
}

/** What a module imports in its declarations: `import`, `export … from`, `import x = require()`. */
function declaredDependencies(sourceFile: SourceFile): readonly Dependency[] {
  return sourceFile.statements.flatMap((statement): readonly Dependency[] => {
    let dependency: Dependency | undefined;
    if (isImportDeclaration(statement)) {
      dependency = importDependency(statement);
    } else if (isExportDeclaration(statement)) {
      dependency = exportDependency(statement);
    } else if (
      isImportEqualsDeclaration(statement) &&
      isExternalModuleReference(statement.moduleReference) &&
      isStringLiteral(statement.moduleReference.expression)
    ) {
      dependency = {
        specifier: statement.moduleReference.expression.text,
        typeOnly: statement.isTypeOnly,
      };
    }
    return dependency === undefined ? [] : [dependency];
  });
}

/** Whether `node` loads a module as it runs: `import(…)`, or CommonJS's `require(…)`. */
function isRuntimeLoad(node: Node): node is CallExpression {
  return (
    isCallExpression(node) &&
    (node.expression.kind === SyntaxKind.ImportKeyword ||
      (isIdentifier(node.expression) && node.expression.text === 'require'))
  );
}

/**
 * What a module loads as it runs, where the specifier is written as a literal (`literalSpecifier`):
 * `import('./x')`, `require('./x')`, past the parentheses and assertions around it. The compile reads
 * it as it reads an import, so that what it loads is in the build's id too. One the code computes is
 * none the compile can name.
 */
function runtimeLoads(sourceFile: SourceFile): readonly Dependency[] {
  const loads: Dependency[] = [];
  const visit = (node: Node): void => {
    if (isRuntimeLoad(node)) {
      const specifier = literalSpecifier(node.arguments[0]);
      if (specifier !== undefined) {
        loads.push({ specifier, typeOnly: false });
      }
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return loads;
}

/**
 * Whether a module holds what makes it no module that runs anywhere alike: JSX, which compiles to an
 * import of React's runtime; an import made at run time; CommonJS's `require`; or what makes code of
 * text, `eval` and `Function` (`readsCodeGlobal`) — which, called by a dynamic site's code of what a
 * view sends, would run it on the authority.
 */
function holdsRunTime(sourceFile: SourceFile): boolean {
  let holds = false;
  const visit = (node: Node): void => {
    if (holds || isErased(node)) {
      return;
    }
    if (
      isJsxElement(node) ||
      isJsxSelfClosingElement(node) ||
      isJsxFragment(node) ||
      isRuntimeLoad(node) ||
      readsCodeGlobal(node)
    ) {
      holds = true;
      return;
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return holds;
}
