import {
  type BindingName,
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isExportAssignment,
  isExportDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isNamedExports,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
  type SourceFile,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, answersLater, isAnswering } from './answers.ts';
import { declarationOf } from './framed.ts';
import { metadataCallee } from './input-callees.ts';
import { readsOf } from './local-module-reads.ts';
import { bindsTarget, peelPlatform, platformPathsOf } from './platform-uses.ts';
import { proxyOrigin } from './proxy-origins.ts';
import { bindingIdentifiers, isTypeOnly } from './scope.ts';

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

/** Exported data expressions, synchronous callables, and exported binding identifiers. */
interface ExportRoots {
  readonly bindings: Set<Identifier>;
  readonly callables: Answering[];
  readonly values: Expression[];
}

/** A Proxy exported directly, assigned to an exported binding, or returned by a shared callable. */
export function sharedProxyOrigin(sourceFile: SourceFile): Node | undefined {
  const roots: ExportRoots = { bindings: new Set(), callables: [], values: [] };
  for (const statement of sourceFile.statements) {
    statementOrigins(statement, roots);
  }
  collectExportedBindingWrites(sourceFile, roots);
  return proxyOrigin(roots.values, { callables: roots.callables });
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
function recordVariableExport(
  decl: Node & { readonly initializer?: Expression | undefined; readonly name: BindingName },
  roots: ExportRoots,
): void {
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

/** Scans `sourceFile` for assignments and mutating calls targeting any exported binding. */
function collectExportedBindingWrites(sourceFile: SourceFile, roots: ExportRoots): void {
  if (roots.bindings.size === 0) {
    return;
  }
  const readers = [...roots.bindings].map((id) => readsOf(id, sourceFile));
  const isExported = (node: Node): node is Identifier => readers.some((fn) => fn(node));
  const visit = (node: Node): void => {
    if (isTypeOnly(node)) {
      return;
    }
    if (
      isBinaryExpression(node) &&
      VALUE_ASSIGNMENTS.has(node.operatorToken.kind) &&
      bindsTarget(node.left, isExported, true)
    ) {
      exportedOrigins(node.right, roots);
      collectAssignmentTargetDefaults(node.left, isExported, roots);
    } else if (isCallExpression(node)) {
      collectMutatingCallExports(node, isExported, roots);
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
}

/** Collects default values inside destructuring assignment targets (`({ x = proxy } = {})`). */
function collectAssignmentTargetDefaults(
  target: Expression,
  isExported: (node: Node) => node is Identifier,
  roots: ExportRoots,
): void {
  const clean = peelPlatform(target);
  if (isBinaryExpression(clean) && clean.operatorToken.kind === SyntaxKind.EqualsToken) {
    if (bindsTarget(clean.left, isExported, true)) {
      exportedOrigins(clean.right, roots);
    }
    collectAssignmentTargetDefaults(clean.left, isExported, roots);
  } else if (isObjectLiteralExpression(clean)) {
    collectObjectPatternDefaults(clean.properties, isExported, roots);
  } else if (isArrayLiteralExpression(clean)) {
    for (const el of clean.elements) {
      collectAssignmentTargetDefaults(isSpreadElement(el) ? el.expression : el, isExported, roots);
    }
  }
}

/** Walks properties of an object assignment pattern to collect default initializers. */
function collectObjectPatternDefaults(
  properties: readonly Node[],
  isExported: (node: Node) => node is Identifier,
  roots: ExportRoots,
): void {
  for (const prop of properties) {
    if (
      isShorthandPropertyAssignment(prop) &&
      prop.objectAssignmentInitializer !== undefined &&
      isExported(prop.name)
    ) {
      exportedOrigins(prop.objectAssignmentInitializer, roots);
    } else if (isPropertyAssignment(prop)) {
      collectAssignmentTargetDefaults(prop.initializer, isExported, roots);
    } else if (isSpreadAssignment(prop)) {
      collectAssignmentTargetDefaults(prop.expression, isExported, roots);
    }
  }
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
