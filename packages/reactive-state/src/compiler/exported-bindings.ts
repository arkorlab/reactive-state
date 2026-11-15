import {
  type ClassDeclaration,
  type ExportDeclaration,
  type Expression,
  type FunctionDeclaration,
  type ImportClause,
  type ImportDeclaration,
  isClassDeclaration,
  isEnumDeclaration,
  isExportAssignment,
  isExportDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isModuleDeclaration,
  isNamedExports,
  isNamedImports,
  isStringLiteral,
  isVariableStatement,
  type Node,
  type SourceFile,
  type Statement,
  SyntaxKind,
  type VariableStatement,
} from 'typescript/ast';

import { globalOf, unwrapped } from './bounded.ts';
import {
  EXPORTED_UNKNOWN,
  type ExportLookup,
  type ExportRule,
  type ExportTarget,
  exportTarget,
  NO_EXPORT,
  resolveExportGraph,
} from './exported-graph.ts';
import { holdsValues } from './local-type-namespaces.ts';
import type { Modules } from './modules.ts';
import { bindingIdentifiers } from './scope.ts';
import { isConstant } from './statements.ts';

/** A value a module declares: a function's or a class's declaration, or a constant's initializer. */
export type DeclaredValue = ClassDeclaration | Expression | FunctionDeclaration;

interface ModuleReading {
  readonly file: string;
  readonly modules: Modules;
  readonly sourceFile: SourceFile;
}

interface ImportTarget {
  readonly exported: string;
  readonly file: string | undefined;
}

type LocalTrace =
  | { readonly dep: ExportTarget; readonly kind: 'import' }
  | { readonly kind: 'next'; readonly next: DeclaredValue }
  | { readonly kind: 'value'; readonly value: DeclaredValue | undefined };

type TracedValue =
  | { readonly dep: ExportTarget; readonly kind: 'import' }
  | { readonly kind: 'value'; readonly value: DeclaredValue | undefined };

const CONST_NONE: ExportRule<DeclaredValue> = { kind: 'const', lookup: NO_EXPORT };
const CONST_UNKNOWN: ExportRule<DeclaredValue> = { kind: 'const', lookup: EXPORTED_UNKNOWN };
const MODULE_MEMOS = new WeakMap<Modules, Map<string, ExportLookup<DeclaredValue>>>();

/**
 * What `file` exports as `name`, where it declares it — its own explicit runtime export first, and
 * only when none exists what `export *` re-exports unambiguously.
 */
export function exportedValue(
  modules: Modules,
  file: string,
  name: string,
): DeclaredValue | undefined {
  return lookupModuleExport(modules, file, name, memoOf(modules)).value;
}

/** Settles `value` against the declarations and imports of the module `value` stands in. */
export function settledValue(modules: Modules, value: DeclaredValue): DeclaredValue | undefined {
  const sourceFile = value.getSourceFile();
  const traced = traceLocalValue(value, {
    file: sourceFile.fileName,
    modules,
    sourceFile,
  });
  return traced.kind === 'value'
    ? traced.value
    : lookupModuleExport(modules, traced.dep.file, traced.dep.name, memoOf(modules)).value;
}

function memoOf(modules: Modules): Map<string, ExportLookup<DeclaredValue>> {
  const existing = MODULE_MEMOS.get(modules);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Map<string, ExportLookup<DeclaredValue>>();
  MODULE_MEMOS.set(modules, created);
  return created;
}

function lookupModuleExport(
  modules: Modules,
  file: string,
  name: string,
  memo: Map<string, ExportLookup<DeclaredValue>>,
): ExportLookup<DeclaredValue> {
  return resolveExportGraph(
    exportTarget(file, name),
    (target) =>
      inspectModuleExport(
        {
          file: target.file,
          modules,
          sourceFile: modules.parse(target.file, false).sourceFile,
        },
        target.name,
      ),
    memo,
  );
}

function inspectModuleExport(reading: ModuleReading, name: string): ExportRule<DeclaredValue> {
  const { statements } = reading.sourceFile;
  for (const statement of statements) {
    const explicit = exportedBy(statement, name, reading);
    if (explicit !== undefined) {
      return explicit;
    }
  }
  if (name === 'default') {
    return CONST_NONE;
  }
  return starExportRule(statements, name, reading);
}

/** What `export * from …` re-exports as `name`, where the file declares no explicit export of it. */
function starExportRule(
  statements: readonly Statement[],
  name: string,
  reading: ModuleReading,
): ExportRule<DeclaredValue> {
  const deps: ExportTarget[] = [];
  const seenFiles = new Set<string>();
  for (const statement of statements) {
    const other = starTargetOf(statement, reading);
    if (other !== undefined && !seenFiles.has(other)) {
      seenFiles.add(other);
      deps.push(exportTarget(other, name));
    }
  }
  return deps.length === 0 ? CONST_NONE : { deps, kind: 'star' };
}

function starTargetOf(statement: Statement, reading: ModuleReading): string | undefined {
  return isExportDeclaration(statement) &&
    !statement.isTypeOnly &&
    statement.exportClause === undefined
    ? fileOf(statement.moduleSpecifier, reading)
    : undefined;
}

/** What `statement` explicitly exports at run time as `name`, or `undefined` when it does not. */
function exportedBy(
  statement: Statement,
  name: string,
  reading: ModuleReading,
): ExportRule<DeclaredValue> | undefined {
  if (isExportDeclaration(statement)) {
    return namedExport(statement, name, reading);
  }
  if (isExportAssignment(statement)) {
    return name === 'default' && !statement.isExportEquals
      ? settledRuleOf(statement.expression, reading)
      : undefined;
  }
  if (!isExported(statement) || isDeclaredAmbient(statement)) {
    return undefined;
  }
  return exportedDeclaration(statement, name, reading);
}

function exportedDeclaration(
  statement: Statement,
  name: string,
  reading: ModuleReading,
): ExportRule<DeclaredValue> | undefined {
  if (isFunctionDeclaration(statement)) {
    return statement.body !== undefined && exportName(statement) === name
      ? constKnownRule(statement)
      : undefined;
  }
  if (isClassDeclaration(statement)) {
    return exportName(statement) === name ? constKnownRule(statement) : undefined;
  }
  if (isVariableStatement(statement)) {
    return variableExport(statement, name, reading);
  }
  return exportsOpaqueRuntimeBinding(statement, name) ? CONST_UNKNOWN : undefined;
}

function constKnownRule(value: DeclaredValue | undefined): ExportRule<DeclaredValue> {
  return { kind: 'const', lookup: { kind: 'exported', value } };
}

function variableExport(
  statement: VariableStatement,
  name: string,
  reading: ModuleReading,
): ExportRule<DeclaredValue> | undefined {
  if (!declaresVariable(statement, name)) {
    return undefined;
  }
  const found = constantIn(statement, name, reading);
  return found === undefined ? CONST_UNKNOWN : settledRuleOf(found, reading);
}

function declaresVariable(statement: VariableStatement, name: string): boolean {
  return statement.declarationList.declarations.some((declaration) =>
    bindingIdentifiers(declaration.name).some((identifier) => identifier.text === name),
  );
}

function exportsOpaqueRuntimeBinding(statement: Statement, name: string): boolean {
  if (isEnumDeclaration(statement)) {
    return statement.name.text === name;
  }
  if (isModuleDeclaration(statement)) {
    return isIdentifier(statement.name) && statement.name.text === name && holdsValues(statement);
  }
  return (
    isImportEqualsDeclaration(statement) && !statement.isTypeOnly && statement.name.text === name
  );
}

/** What `export { … }`, `export { … } from …`, or `export * as … from …` exports as `name`. */
function namedExport(
  statement: ExportDeclaration,
  name: string,
  reading: ModuleReading,
): ExportRule<DeclaredValue> | undefined {
  const { exportClause: clause } = statement;
  if (statement.isTypeOnly || clause === undefined) {
    return undefined;
  }
  if (!isNamedExports(clause)) {
    return clause.name.text === name ? CONST_UNKNOWN : undefined;
  }
  const element = clause.elements.find((each) => !each.isTypeOnly && each.name.text === name);
  if (element === undefined) {
    return undefined;
  }
  const original = (element.propertyName ?? element.name).text;
  return statement.moduleSpecifier === undefined
    ? localNamedExport(original, reading)
    : reexportRule(fileOf(statement.moduleSpecifier, reading), original);
}

function localNamedExport(original: string, reading: ModuleReading): ExportRule<DeclaredValue> {
  for (const statement of reading.sourceFile.statements) {
    if (isImportDeclaration(statement)) {
      const target = importTargetOf(statement, original, reading);
      if (target !== undefined) {
        return reexportRule(target.file, target.exported);
      }
    }
  }
  const local = localDeclarationOf(original, reading);
  return local === undefined ? CONST_UNKNOWN : settledRuleOf(local, reading);
}

function reexportRule(other: string | undefined, exported: string): ExportRule<DeclaredValue> {
  return other === undefined
    ? CONST_UNKNOWN
    : { dep: exportTarget(other, exported), kind: 'reexport' };
}

function settledRuleOf(value: DeclaredValue, reading: ModuleReading): ExportRule<DeclaredValue> {
  const traced = traceLocalValue(value, reading);
  return traced.kind === 'value'
    ? constKnownRule(traced.value)
    : { dep: traced.dep, kind: 'settledImport' };
}

/**
 * Follows `value` through local `const` aliases within `reading.sourceFile`, stopping at a
 * declaration, expression, global identifier, or cross-module import target.
 */
function traceLocalValue(value: DeclaredValue, reading: ModuleReading): TracedValue {
  const seenLocal = new Set<string>();
  let each = value;
  for (;;) {
    const stepped = stepLocalValue(each, reading, seenLocal);
    if (stepped.kind !== 'next') {
      return stepped;
    }
    each = stepped.next;
  }
}

function stepLocalValue(
  each: DeclaredValue,
  reading: ModuleReading,
  seenLocal: Set<string>,
): LocalTrace {
  if (
    isFunctionDeclaration(each) ||
    isClassDeclaration(each) ||
    each.getSourceFile() !== reading.sourceFile
  ) {
    return { kind: 'value', value: each };
  }
  const named = unwrapped(each);
  if (!isIdentifier(named)) {
    return { kind: 'value', value: each };
  }
  if (seenLocal.has(named.text)) {
    return { kind: 'value', value: undefined };
  }
  seenLocal.add(named.text);
  return resolveLocalIdentifier(named, reading);
}

function resolveLocalIdentifier(
  named: Node & { readonly text: string },
  reading: ModuleReading,
): LocalTrace {
  for (const statement of reading.sourceFile.statements) {
    const matched = matchLocalStatement(statement, named.text, reading);
    if (matched !== undefined) {
      return matched;
    }
  }
  const globalValue = isIdentifier(named) && globalOf(named) !== undefined ? named : undefined;
  return { kind: 'value', value: globalValue };
}

function matchLocalStatement(
  statement: Statement,
  name: string,
  reading: ModuleReading,
): LocalTrace | undefined {
  const declared = localStatementDeclaration(statement, name, reading);
  if (declared !== undefined) {
    return isVariableStatement(statement)
      ? { kind: 'next', next: declared }
      : { kind: 'value', value: declared };
  }
  return !isDeclaredAmbient(statement) && isImportDeclaration(statement)
    ? importedTrace(statement, name, reading)
    : undefined;
}

function localDeclarationOf(name: string, reading: ModuleReading): DeclaredValue | undefined {
  for (const statement of reading.sourceFile.statements) {
    const declared = localStatementDeclaration(statement, name, reading);
    if (declared !== undefined) {
      return declared;
    }
  }
  return undefined;
}

function localStatementDeclaration(
  statement: Statement,
  name: string,
  reading: ModuleReading,
): DeclaredValue | undefined {
  if (isDeclaredAmbient(statement)) {
    return undefined;
  }
  if (isFunctionDeclaration(statement)) {
    return statement.body !== undefined && statement.name?.text === name ? statement : undefined;
  }
  if (isClassDeclaration(statement)) {
    return statement.name?.text === name ? statement : undefined;
  }
  return isVariableStatement(statement) ? constantIn(statement, name, reading) : undefined;
}

/** The initializer of the constant `name` a `const` statement declares. */
function constantIn(
  statement: VariableStatement,
  name: string,
  reading: ModuleReading,
): Expression | undefined {
  if (!isConstant(statement, reading.sourceFile)) {
    return undefined;
  }
  const declaration = statement.declarationList.declarations.find(
    (each) => isIdentifier(each.name) && each.name.text === name,
  );
  return declaration?.initializer;
}

function importTargetOf(
  statement: ImportDeclaration,
  name: string,
  reading: ModuleReading,
): ImportTarget | undefined {
  const { importClause: clause } = statement;
  if (clause === undefined || clause.phaseModifier === SyntaxKind.TypeKeyword) {
    return undefined;
  }
  const exported = importedExportName(clause, name);
  return exported === undefined
    ? undefined
    : { exported, file: fileOf(statement.moduleSpecifier, reading) };
}

function importedExportName(clause: ImportClause, name: string): string | undefined {
  if (clause.name?.text === name) {
    return 'default';
  }
  if (clause.namedBindings === undefined || !isNamedImports(clause.namedBindings)) {
    return undefined;
  }
  const element = clause.namedBindings.elements.find(
    (each) => !each.isTypeOnly && each.name.text === name,
  );
  return element === undefined ? undefined : (element.propertyName ?? element.name).text;
}

function importedTrace(
  statement: ImportDeclaration,
  name: string,
  reading: ModuleReading,
): LocalTrace | undefined {
  const target = importTargetOf(statement, name, reading);
  if (target === undefined) {
    return undefined;
  }
  return target.file === undefined
    ? { kind: 'value', value: undefined }
    : { dep: exportTarget(target.file, target.exported), kind: 'import' };
}

function isExported(statement: Statement): boolean {
  return hasModifier(statement, SyntaxKind.ExportKeyword);
}

function isDeclaredAmbient(statement: Statement): boolean {
  return hasModifier(statement, SyntaxKind.DeclareKeyword);
}

function hasModifier(node: Node, kind: SyntaxKind): boolean {
  return (
    (node as { readonly modifiers?: readonly Node[] }).modifiers?.some(
      (each) => each.kind === kind,
    ) === true
  );
}

/** The name a declaration is exported as: its own, or `default`. */
function exportName(declaration: ClassDeclaration | FunctionDeclaration): string | undefined {
  return hasModifier(declaration, SyntaxKind.DefaultKeyword) ? 'default' : declaration.name?.text;
}

/** The application's file a specifier leads to from `reading`'s file; none of a package's. */
function fileOf(specifier: Node | undefined, reading: ModuleReading): string | undefined {
  return specifier !== undefined && isStringLiteral(specifier)
    ? reading.modules.resolve(specifier.text, reading.file)
    : undefined;
}
