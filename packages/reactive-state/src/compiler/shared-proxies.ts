import {
  type BinaryExpression,
  type BindingName,
  type CallExpression,
  type Expression,
  type ForOfStatement,
  type Identifier,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isElementAccessExpression,
  isExportAssignment,
  isExportDeclaration,
  isExpression,
  isForOfStatement,
  isFunctionDeclaration,
  isIdentifier,
  isNamedExports,
  isNewExpression,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  type Node,
  type SourceFile,
  type Statement,
  SyntaxKind,
  type VariableDeclaration,
  type VariableDeclarationList,
} from 'typescript/ast';

import { type Answering, answersLater, isAnswering } from './answers.ts';
import { declarationOf } from './framed.ts';
import { metadataCallee } from './input-callees.ts';
import { readsOf } from './local-module-reads.ts';
import { bindsTarget, peelPlatform, platformPathsOf } from './platform-uses.ts';
import { proxyOrigin } from './proxy-origins.ts';
import { patternTargetOrigins } from './proxy-parameter-patterns.ts';
import {
  type Context,
  createPresenceCache,
  type Origin,
  type ProjectedSeed,
} from './proxy-values.ts';
import { bindingIdentifiers, isBlockScoped, isTypeOnly, withinFunction } from './scope.ts';

/** Assignment operators whose right-hand operand can flow into the target binding. */
const VALUE_ASSIGNMENTS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** Array mutator methods whose arguments populate elements of an exported array. */
const ARRAY_ELEMENT_MUTATORS: ReadonlySet<string> = new Set(['fill', 'push', 'unshift']);

/** Starting index of inserted element arguments in `splice(start, deleteCount, ...items)` and `Reflect.set`. */
const VALUE_ARG_INDEX = 2;

/** Exported data expressions, projected seeds, synchronous callables, and exported binding identifiers. */
interface ExportRoots {
  readonly bindings: Set<Identifier>;
  readonly callables: Answering[];
  readonly seeds: ProjectedSeed[];
  readonly values: Expression[];
}

/** A Proxy exported directly, assigned to an exported binding, or returned by a shared callable. */
export function sharedProxyOrigin(sourceFile: SourceFile): Node | undefined {
  const roots: ExportRoots = { bindings: new Set(), callables: [], seeds: [], values: [] };
  for (const statement of sourceFile.statements) {
    statementOrigins(statement, roots);
  }
  collectExportedBindingWrites(sourceFile, roots);
  return proxyOrigin(roots.values, { callables: roots.callables, seeds: roots.seeds });
}

/** Collects value roots and declared binding identifiers from one top-level export statement. */
function statementOrigins(statement: Statement, roots: ExportRoots): void {
  if (isFunctionDeclaration(statement)) {
    if (hasExport(statement.modifiers) && !answersLater(statement)) {
      roots.callables.push(statement);
    }
    return;
  }
  if (isVariableStatement(statement)) {
    if (hasExport(statement.modifiers)) {
      for (const decl of statement.declarationList.declarations) {
        recordVariableExport(decl, roots);
      }
    }
    return;
  }
  if (isExportAssignment(statement)) {
    exportedOrigins(statement.expression, roots);
    const clean = peelPlatform(statement.expression);
    if (isIdentifier(clean)) {
      recordLocalIdentifierExport(clean, roots);
    }
    return;
  }
  namedOrigins(statement, roots);
}

/** Records initializer, pattern defaults, and binding identifiers for an exported variable declaration. */
function recordVariableExport(decl: VariableDeclaration, roots: ExportRoots): void {
  if (decl.initializer !== undefined) {
    exportedOrigins(decl.initializer, roots);
  }
  collectPatternDefaults(decl.name, roots);
  for (const id of bindingIdentifiers(decl.name)) {
    roots.bindings.add(id);
  }
}

/** Collects default initializers from destructured variable binding patterns. */
function collectPatternDefaults(name: BindingName | undefined, roots: ExportRoots): void {
  if (name === undefined || (!isObjectBindingPattern(name) && !isArrayBindingPattern(name))) {
    return;
  }
  for (const element of name.elements) {
    if (isBindingElement(element)) {
      if (element.initializer !== undefined) {
        exportedOrigins(element.initializer, roots);
      }
      collectPatternDefaults(element.name, roots);
    }
  }
}

/** Locally named value exports (`export { local as exported }`); re-exports are checked per module. */
function namedOrigins(statement: Statement, roots: ExportRoots): void {
  if (
    !isExportDeclaration(statement) ||
    statement.moduleSpecifier !== undefined ||
    statement.isTypeOnly ||
    statement.exportClause === undefined ||
    !isNamedExports(statement.exportClause)
  ) {
    return;
  }
  for (const entry of statement.exportClause.elements) {
    if (!entry.isTypeOnly) {
      const localId = entry.propertyName ?? entry.name;
      if (isIdentifier(localId)) {
        exportedOrigins(localId, roots);
        recordLocalIdentifierExport(localId, roots);
      }
    }
  }
}

/** Resolves a locally exported identifier to its module-level declaration for write tracking. */
function recordLocalIdentifierExport(id: Identifier, roots: ExportRoots): void {
  const declared = declarationOf(id);
  if (declared !== undefined) {
    if (isFunctionDeclaration(declared)) {
      if (!answersLater(declared)) {
        roots.callables.push(declared);
      }
    } else if (isVariableDeclaration(declared)) {
      recordVariableExport(declared, roots);
    }
    return;
  }
  for (const statement of id.getSourceFile().statements) {
    if (!isVariableStatement(statement)) {
      continue;
    }
    for (const decl of statement.declarationList.declarations) {
      const match = bindingIdentifiers(decl.name).find((bound) => bound.text === id.text);
      if (match !== undefined) {
        recordVariableExport(decl, roots);
      }
    }
  }
}

/** Scans `sourceFile` for assignments, `for..of` loops, and mutating calls targeting exported bindings. */
function collectExportedBindingWrites(sourceFile: SourceFile, roots: ExportRoots): void {
  if (roots.bindings.size === 0) {
    return;
  }
  const readers = [...roots.bindings].map((id) => readsOf(id, sourceFile));
  const isExported = (node: Node): node is Identifier => readers.some((fn) => fn(node));
  const patternContext: Context = {
    calls: new Set(),
    frames: [],
    presence: createPresenceCache(),
    spreadKeys: new Map(),
  };
  const visit = (node: Node): void => {
    if (isTypeOnly(node)) {
      return;
    }
    if (
      isBinaryExpression(node) &&
      VALUE_ASSIGNMENTS.has(node.operatorToken.kind) &&
      bindsTarget(node.left, isExported, true)
    ) {
      collectAssignmentExports(node, patternContext, isExported, roots);
    } else if (isForOfStatement(node)) {
      collectForOfExports(node, patternContext, isExported, roots);
    } else if (isCallExpression(node)) {
      collectMutatingCallExports(node, isExported, roots);
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
}

/** Collects direct or destructuring assignment values written to exported bindings or members. */
function collectAssignmentExports(
  node: BinaryExpression,
  context: Context,
  isExported: (candidate: Node) => candidate is Identifier,
  roots: ExportRoots,
): void {
  const left = peelPlatform(node.left);
  if (
    node.operatorToken.kind !== SyntaxKind.EqualsToken ||
    (!isObjectLiteralExpression(left) && !isArrayLiteralExpression(left))
  ) {
    exportedOrigins(node.right, roots);
    return;
  }
  const source: Origin = { context, keys: [], seen: new Set(), value: node.right };
  collectProjectedTargetExports(left, source, isExported, roots);
}

/** Collects element projections from `for..of` loop targets assigning into exported bindings. */
function collectForOfExports(
  node: ForOfStatement,
  context: Context,
  isExported: (candidate: Node) => candidate is Identifier,
  roots: ExportRoots,
): void {
  const { initializer } = node;
  if (isVariableDeclarationList(initializer)) {
    if (!isBlockScoped(initializer) && !withinFunction(node, node.getSourceFile())) {
      collectHoistedForOfVarExports(initializer, node.expression, roots);
    }
    return;
  }
  if (!isExpression(initializer) || !bindsTarget(initializer, isExported, true)) {
    return;
  }
  const source: Origin = {
    context,
    keys: [null],
    seen: new Set(),
    value: unwrapIterableSource(node.expression),
  };
  collectProjectedTargetExports(initializer, source, isExported, roots);
}

/** Records module-scope `for (var exported of iterable)` redeclarations of exported `var` bindings. */
function collectHoistedForOfVarExports(
  list: VariableDeclarationList,
  iterable: Expression,
  roots: ExportRoots,
): void {
  const exportedNames = new Set([...roots.bindings].map((id) => id.text));
  for (const decl of list.declarations) {
    collectPatternDefaults(decl.name, roots);
    if (bindingIdentifiers(decl.name).some((id) => exportedNames.has(id.text))) {
      roots.seeds.push({
        keys: [null],
        topLevelBinding: true,
        value: unwrapIterableSource(iterable),
      });
    }
  }
}

/** Unwraps `new Set(items)` and `Array.from(items)` so `for..of` element projection sees `items`. */
function unwrapIterableSource(iterable: Expression): Expression {
  const clean = peelPlatform(iterable);
  if (isNewExpression(clean) && platformPathsOf(clean.expression).includes('Set')) {
    const first = clean.arguments?.[0];
    return first === undefined || isSpreadElement(first) ? clean : first;
  }
  if (isCallExpression(clean) && platformPathsOf(clean.expression).includes('Array.from')) {
    const first = clean.arguments[0];
    return first === undefined || isSpreadElement(first) ? clean : first;
  }
  return clean;
}

/** Projects `target` against `source` for both exported bindings and exported member targets. */
function collectProjectedTargetExports(
  target: Expression,
  source: Origin,
  isExported: (candidate: Node) => candidate is Identifier,
  roots: ExportRoots,
): void {
  const readAt: Origin = { context: source.context, keys: [], seen: new Set(), value: target };
  const bindingHits = patternTargetOrigins(
    target,
    source,
    readAt,
    (leaf) => isIdentifier(leaf) && isExported(leaf),
  );
  for (const hit of bindingHits) {
    recordProjectedHit(hit, true, roots);
  }
  const memberHits = patternTargetOrigins(target, source, readAt, (leaf) => {
    return (
      (isPropertyAccessExpression(leaf) || isElementAccessExpression(leaf)) &&
      bindsTarget(leaf, isExported, true)
    );
  });
  for (const hit of memberHits) {
    recordProjectedHit(hit, false, roots);
  }
}

/** Pushes an unprojected binding write to `exportedOrigins`, or stores a projected `ProjectedSeed`. */
function recordProjectedHit(hit: Origin, topLevelBinding: boolean, roots: ExportRoots): void {
  if (
    topLevelBinding &&
    hit.keys.length === 0 &&
    hit.spread !== true &&
    hit.excluded === undefined
  ) {
    exportedOrigins(hit.value, roots);
    return;
  }
  roots.seeds.push({
    excluded: hit.excluded,
    keys: hit.keys,
    spread: hit.spread,
    topLevelBinding,
    value: hit.value,
  });
}

/** Collects Proxy values written into exported containers via `Object.assign`, `Reflect.set`, or array mutators. */
function collectMutatingCallExports(
  call: CallExpression,
  isExported: (node: Node) => node is Identifier,
  roots: ExportRoots,
): void {
  if (collectStaticObjectMutation(call, isExported, roots)) {
    return;
  }
  const callee = peelPlatform(call.expression);
  if (!isPropertyAccessExpression(callee) || !bindsTarget(callee.expression, isExported, true)) {
    return;
  }
  for (const arg of mutatorValueArguments(call, callee.name.text)) {
    exportedOrigins(isSpreadElement(arg) ? arg.expression : arg, roots);
  }
}

/** Handles `Object.assign`, `Reflect.set`, and `Object.defineProperty` on an exported target. */
function collectStaticObjectMutation(
  call: CallExpression,
  isExported: (node: Node) => node is Identifier,
  roots: ExportRoots,
): boolean {
  const first = call.arguments[0];
  const firstClean =
    first === undefined || isSpreadElement(first) ? undefined : peelPlatform(first);
  if (firstClean === undefined || !bindsTarget(firstClean, isExported, true)) {
    return false;
  }
  const paths = platformPathsOf(call.expression);
  if (paths.includes('Object.assign')) {
    for (const src of call.arguments.slice(1)) {
      exportedOrigins(isSpreadElement(src) ? src.expression : src, roots);
    }
    return true;
  }
  const valArg = call.arguments[VALUE_ARG_INDEX];
  if (
    valArg !== undefined &&
    (paths.includes('Reflect.set') || paths.includes('Object.defineProperty'))
  ) {
    exportedOrigins(isSpreadElement(valArg) ? valArg.expression : valArg, roots);
    return true;
  }
  return false;
}

/** Returns arguments written into an array by `method`. */
function mutatorValueArguments(call: CallExpression, method: string): readonly Expression[] {
  if (ARRAY_ELEMENT_MUTATORS.has(method)) {
    return call.arguments;
  }
  return method === 'splice' ? call.arguments.slice(VALUE_ARG_INDEX) : [];
}

/** An exported callable kept with its parameter frame, or the exported data value itself. */
function exportedOrigins(value: Expression, roots: ExportRoots): void {
  const fn = metadataCallee(value);
  if (fn !== undefined && isAnswering(fn)) {
    if (!answersLater(fn)) {
      roots.callables.push(fn);
    }
    return;
  }
  roots.values.push(value);
}

/** Whether a declaration is exported as a value. */
function hasExport(modifiers: readonly Node[] | undefined): boolean {
  return modifiers?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword) === true;
}
