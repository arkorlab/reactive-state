import {
  type ImportDeclaration,
  isCallExpression,
  isExportDeclaration,
  isImportDeclaration,
  isNamedImports,
  isNamespaceImport,
  isNoSubstitutionTemplateLiteral,
  isStringLiteral,
  type Node,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import type { DatabaseExport } from './database-handle.ts';
import { defaultImportNames } from './default-imports.ts';
import type { CompiledComponent } from './emit-app.ts';
import type { ModuleClass, Modules } from './modules.ts';
import { type PageRender, pageRenderOf } from './page-render.ts';
import { pageShapeOf } from './page-shape.ts';
import { exportedNames, importEqualsSpecifier, Reach } from './reach.ts';
import type { PageEntry, RouteName } from './route-scan.ts';

/**
 * A page of the application, read for the root it renders: a page of a root of its route's params
 * alone, in one of the two shapes such a page is written in (`page-shape.ts`), whose document may be
 * one artifact for every visitor; or a page of one reactive root of more than those — its search
 * params, constants (`page-render.ts`) — which is the request's, registered all the same so that
 * the root's entry names its route, and the route's guards are run wherever the root renders.
 */

export interface RoutingContext {
  readonly appDir: string;
  readonly outDir: string;
  readonly modules: Modules;
  readonly components: readonly CompiledComponent[];
  /**
   * The application's database, where the compile resolves the one it names: what is written
   * through a table of it is a commit the authority tracks, which no route's judgement takes for
   * state kept.
   */
  readonly database: DatabaseExport | undefined;
  /** Runs `run`, recording what it refuses. */
  readonly attempt: <T>(run: () => T) => T | undefined;
  /**
   * Whether the application turned sharing off (`share: false`): no route's view is every visitor's.
   */
  readonly unshared?: boolean | undefined;
}

/** A page of one reactive root, read: the route it registers, its root, and the root's props. */
export interface ShapedPage {
  readonly page: PageEntry;
  readonly name: RouteName;
  readonly root: string;
  /** Where what is refused of the root it renders stands: its first element. */
  readonly element: Node;
  /** Each of the root's props the page gives a param of the route as it is, by the param. */
  readonly props: Readonly<Record<string, string>>;
  /** Whether the page awaits its params, or its search params, outside any `<Suspense>`. */
  readonly blocking: boolean;
  /**
   * A page of a root of its params alone, and what it runs beside rendering the root (a document
   * that may be shared); or why the route is the request's.
   */
  readonly exact: { readonly beside: string | undefined } | { readonly reason: string };
}

/** The params of the page's route its root is not given, in the order the route names them. */
export function paramsNotGiven(shaped: Pick<ShapedPage, 'name' | 'props'>): readonly string[] {
  const given = new Set(Object.values(shaped.props));
  return shaped.name.params.filter((param) => !given.has(param));
}

/** Why a page of one root of more than its route's params is the request's, in a few words. */
function reasonOf(render: PageRender, root: string): string {
  if (render.given.length > 0) {
    const given = render.given.map((name) => `\`${name}\``).join(', ');
    return `\`${root}\` is given props beside its route's params (${given})`;
  }
  return render.searched
    ? 'the page reads its `searchParams`'
    : 'the page renders more than its root of its params';
}

/** The page's root, where it renders one the compile compiled, and its props. */
export function shapedPage(
  page: PageEntry,
  context: RoutingContext,
  compiled: ReadonlySet<string>,
): ShapedPage | undefined {
  const name = page.route;
  if (name === undefined) {
    return undefined;
  }
  const { modules } = context;
  const rootOf = (specifier: string): string | undefined => {
    const target = modules.targetOf(specifier, page.file);
    const { id } = target;
    return id !== undefined && target.kind === 'component' && compiled.has(id) ? id : undefined;
  };
  const routed = (destructured: readonly string[]): boolean =>
    destructured.every((param) => name.params.includes(param));
  const { sourceFile } = modules.parse(page.file, false);
  const shape = pageShapeOf(sourceFile);
  const exact = shape === undefined ? undefined : rootOf(shape.specifier);
  // What is registered is read whole: a page that does not parse is refused, not registered.
  if (shape !== undefined && exact !== undefined && routed(shape.destructured)) {
    modules.parse(page.file, true);
    const { beside, blocking, element, props } = shape;
    return { blocking, element, exact: { beside }, name, page, props, root: exact };
  }
  const render = pageRenderOf(sourceFile, (specifier) => rootOf(specifier) !== undefined);
  const root = render === undefined ? undefined : rootOf(render.specifier);
  const [element] = render?.elements ?? [];
  if (
    render === undefined ||
    root === undefined ||
    element === undefined ||
    !routed(render.destructured)
  ) {
    return undefined;
  }
  modules.parse(page.file, true);
  const reason = reasonOf(render, root);
  const { blocking, props } = render;
  return { blocking, element, exact: { reason }, name, page, props, root };
}

/** Whether an import brings a value, rather than types alone or only a module's side effects. */
function importsValue(statement: ImportDeclaration): boolean {
  const clause = statement.importClause;
  if (clause === undefined || clause.phaseModifier === SyntaxKind.TypeKeyword) return false;
  if (clause.name !== undefined) return true;
  const named = clause.namedBindings;
  return (
    named !== undefined &&
    (isNamespaceImport(named) ||
      (isNamedImports(named) && named.elements.some((element) => !element.isTypeOnly)))
  );
}

/** Reactive roots reached through page imports, stopping at each component's authority boundary. */
export function rootsImported(
  page: Pick<PageEntry, 'file'>,
  modules: Modules,
): readonly { readonly root: string; readonly at: Node }[] {
  const { sourceFile } = modules.parse(page.file, false);
  const reach = new Reach(modules, undefined);
  const imported = sourceFile.statements.flatMap((statement) => {
    if (
      !isImportDeclaration(statement) ||
      !isStringLiteral(statement.moduleSpecifier) ||
      !importsValue(statement)
    ) {
      return [];
    }
    const clause = statement.importClause;
    const named = clause?.namedBindings;
    const namespace =
      clause?.phaseModifier !== SyntaxKind.TypeKeyword &&
      named !== undefined &&
      isNamespaceImport(named);
    const target = modules.targetOf(statement.moduleSpecifier.text, page.file);
    if (target.kind === 'component') {
      return target.id !== undefined && (namespace || defaultImportNames(statement).length > 0)
        ? [{ at: statement, root: target.id }]
        : [];
    }
    if (target.file === undefined) return [];
    const roots = reach.renderedComponents([target.file], true);
    return [...roots].map((root) => ({ at: statement, root }));
  });
  return [
    ...imported,
    ...rootsDeclared(sourceFile, modules, reach),
    ...rootsLoaded(sourceFile, modules, reach),
  ];
}

/** Value declarations use the same re-export and external-import names as transitive reach. */
function rootsDeclared(
  sourceFile: SourceFile,
  modules: Modules,
  reach: Reach,
): readonly { readonly root: string; readonly at: Node }[] {
  return sourceFile.statements.flatMap((statement) => {
    const external = importEqualsSpecifier(statement);
    if (external !== undefined)
      return loadedComponents(modules.targetOf(external, sourceFile.fileName), reach).map(
        (root) => ({ at: statement, root }),
      );
    if (
      !isExportDeclaration(statement) ||
      statement.moduleSpecifier === undefined ||
      !isStringLiteral(statement.moduleSpecifier)
    )
      return [];
    const names = exportedNames(statement);
    if (names === undefined || names.length === 0) return [];
    const target = modules.targetOf(statement.moduleSpecifier.text, sourceFile.fileName);
    return loadedComponents(target, reach).map((root) => ({ at: statement, root }));
  });
}

/** Literal module loads keep their source location without guessing a computed specifier. */
function loadedSpecifier(at: Node): string | undefined {
  if (!isCallExpression(at)) return undefined;
  const nativeLoad =
    at.expression.kind === SyntaxKind.ImportKeyword ||
    globalPathOf(unwrapped(at.expression))?.join('.') === 'require';
  if (!nativeLoad) return undefined;
  const [specifier] = at.arguments;
  return specifier !== undefined &&
    (isStringLiteral(specifier) || isNoSubstitutionTemplateLiteral(specifier))
    ? specifier.text
    : undefined;
}

/** The roots an explicitly loaded local module can render, at the authority boundary. */
function loadedComponents(target: ModuleClass, reach: Reach): readonly string[] {
  if (target.kind === 'component') return target.id === undefined ? [] : [target.id];
  return target.file === undefined ? [] : [...reach.renderedComponents([target.file], true)];
}

/** Literal dynamic imports and unshadowed CommonJS loads retain roots in local rendering functions. */
function rootsLoaded(
  sourceFile: SourceFile,
  modules: Modules,
  reach: Reach,
): readonly { readonly root: string; readonly at: Node }[] {
  const roots: { readonly root: string; readonly at: Node }[] = [];
  const pending: Node[] = [sourceFile];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const specifier = loadedSpecifier(at);
    if (specifier !== undefined) {
      const target = modules.targetOf(specifier, sourceFile.fileName);
      for (const root of loadedComponents(target, reach)) roots.push({ at, root });
    }
    at.forEachChild((child) => {
      pending.push(child);
    });
  }
  return roots;
}
