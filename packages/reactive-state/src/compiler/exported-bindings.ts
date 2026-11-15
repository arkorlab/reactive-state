import {
  type ClassDeclaration,
  type ExportDeclaration,
  type Expression,
  type FunctionDeclaration,
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
import { holdsValues } from './local-type-namespaces.ts';
import type { Modules } from './modules.ts';
import { bindingIdentifiers } from './scope.ts';
import { isConstant } from './statements.ts';

/** A value a module declares: a function's or a class's declaration, or a constant's initializer. */
export type DeclaredValue = ClassDeclaration | Expression | FunctionDeclaration;

interface ExportLookup {
  readonly kind: 'exported' | 'none';
  readonly value?: DeclaredValue | undefined;
}

interface LookupState {
  cycled: boolean;
  readonly memo: Map<string, ExportLookup>;
  readonly visiting: Set<string>;
}

interface ModuleReading {
  readonly file: string;
  readonly modules: Modules;
  readonly sourceFile: SourceFile;
  readonly state: LookupState;
}

const NO_EXPORT: ExportLookup = { kind: 'none' };
const EXPORTED_UNKNOWN: ExportLookup = { kind: 'exported', value: undefined };

/**
 * What `file` exports as `name`, where it declares it — its own explicit runtime export first, and
 * only when none exists what `export *` re-exports unambiguously.
 */
export function exportedValue(
  modules: Modules,
  file: string,
  name: string,
): DeclaredValue | undefined {
  return lookupExport(modules, file, name, freshState()).value;
}

/** Settles `value` against the declarations and imports of the module `value` stands in. */
export function settledValue(modules: Modules, value: DeclaredValue): DeclaredValue | undefined {
  const sourceFile = value.getSourceFile();
  return settled(value, {
    file: sourceFile.fileName,
    modules,
    sourceFile,
    state: freshState(),
  });
}

function freshState(): LookupState {
  return { cycled: false, memo: new Map(), visiting: new Set() };
}

function lookupExport(
  modules: Modules,
  file: string,
  name: string,
  state: LookupState,
): ExportLookup {
  const key = `${file}#${name}`;
  const cached = state.memo.get(key);
  if (cached !== undefined) {
    return cached;
  }
  if (state.visiting.has(key)) {
    state.cycled = true;
    return NO_EXPORT;
  }
  const savedCycled = state.cycled;
  state.cycled = false;
  state.visiting.add(key);
  const reading: ModuleReading = {
    file,
    modules,
    sourceFile: modules.parse(file, false).sourceFile,
    state,
  };
  const result = resolveModuleExport(reading, name);
  state.visiting.delete(key);
  const childCycled = state.cycled;
  state.cycled = savedCycled || childCycled;
  if (!childCycled) {
    state.memo.set(key, result);
  }
  return result;
}

function resolveModuleExport(reading: ModuleReading, name: string): ExportLookup {
  const { statements } = reading.sourceFile;
  for (const statement of statements) {
    const found = exportedBy(statement, name, reading);
    if (found.kind === 'exported') {
      return found;
    }
  }
  return name === 'default' ? NO_EXPORT : starExported(statements, name, reading);
}

/** What `export * from …` re-exports as `name`, where the file declares no explicit export of it. */
function starExported(
  statements: readonly Statement[],
  name: string,
  reading: ModuleReading,
): ExportLookup {
  let star: ExportLookup = NO_EXPORT;
  for (const statement of statements) {
    const other = starTargetOf(statement, reading);
    if (other === undefined) {
      continue;
    }
    const found = lookupExport(reading.modules, other, name, reading.state);
    if (found.kind === 'exported') {
      star = mergeStarLookup(star, found);
    }
  }
  return star;
}

function starTargetOf(statement: Statement, reading: ModuleReading): string | undefined {
  return isExportDeclaration(statement) &&
    !statement.isTypeOnly &&
    statement.exportClause === undefined
    ? fileOf(statement.moduleSpecifier, reading)
    : undefined;
}

function mergeStarLookup(current: ExportLookup, next: ExportLookup): ExportLookup {
  if (current.kind === 'none') {
    return next;
  }
  return current.value !== undefined && current.value === next.value ? current : EXPORTED_UNKNOWN;
}

/** What `statement` explicitly exports at run time as `name`. */
function exportedBy(statement: Statement, name: string, reading: ModuleReading): ExportLookup {
  if (isExportDeclaration(statement)) {
    return namedExport(statement, name, reading);
  }
  if (isExportAssignment(statement)) {
    return name === 'default' && !statement.isExportEquals
      ? settledExport(statement.expression, reading)
      : NO_EXPORT;
  }
  if (!isExported(statement) || isDeclaredAmbient(statement)) {
    return NO_EXPORT;
  }
  return exportedDeclaration(statement, name, reading);
}

function exportedDeclaration(
  statement: Statement,
  name: string,
  reading: ModuleReading,
): ExportLookup {
  if (isFunctionDeclaration(statement)) {
    return statement.body !== undefined && exportName(statement) === name
      ? { kind: 'exported', value: statement }
      : NO_EXPORT;
  }
  if (isClassDeclaration(statement)) {
    return exportName(statement) === name ? { kind: 'exported', value: statement } : NO_EXPORT;
  }
  if (isVariableStatement(statement)) {
    return variableExport(statement, name, reading);
  }
  return exportsOpaqueRuntimeBinding(statement, name) ? EXPORTED_UNKNOWN : NO_EXPORT;
}

function variableExport(
  statement: VariableStatement,
  name: string,
  reading: ModuleReading,
): ExportLookup {
  if (!declaresVariable(statement, name)) {
    return NO_EXPORT;
  }
  const found = constantIn(statement, name, reading);
  return found === undefined ? EXPORTED_UNKNOWN : settledExport(found, reading);
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
): ExportLookup {
  const { exportClause: clause } = statement;
  if (statement.isTypeOnly || clause === undefined) {
    return NO_EXPORT;
  }
  if (!isNamedExports(clause)) {
    return clause.name.text === name ? EXPORTED_UNKNOWN : NO_EXPORT;
  }
  const element = clause.elements.find((each) => !each.isTypeOnly && each.name.text === name);
  if (element === undefined) {
    return NO_EXPORT;
  }
  const original = (element.propertyName ?? element.name).text;
  if (statement.moduleSpecifier === undefined) {
    const local = localValue(original, reading);
    return local === undefined ? EXPORTED_UNKNOWN : settledExport(local, reading);
  }
  const other = fileOf(statement.moduleSpecifier, reading);
  const remote =
    other === undefined
      ? undefined
      : lookupExport(reading.modules, other, original, reading.state).value;
  return remote === undefined ? EXPORTED_UNKNOWN : settledExport(remote, reading);
}

function settledExport(value: DeclaredValue, reading: ModuleReading): ExportLookup {
  return { kind: 'exported', value: settled(value, reading) };
}

/**
 * `value`, or, where it is a name the file declares otherwise — `export default fill`,
 * `export const helper = fill` — what that declares, followed so, but a name under way already; a
 * global's name — `Infinity`, `undefined` — as itself, which what reads it reads as the global.
 */
type SettledStep =
  | { readonly done: false; readonly next: DeclaredValue }
  | { readonly done: true; readonly value: DeclaredValue | undefined };

function settled(value: DeclaredValue, reading: ModuleReading): DeclaredValue | undefined {
  const localKeys: string[] = [];
  let each = value;
  try {
    for (;;) {
      const stepped = stepSettled(each, reading, localKeys);
      if (stepped.done) {
        return stepped.value;
      }
      each = stepped.next;
    }
  } finally {
    for (const key of localKeys) {
      reading.state.visiting.delete(key);
    }
  }
}

function stepSettled(
  each: DeclaredValue,
  reading: ModuleReading,
  localKeys: string[],
): SettledStep {
  // What another module declares, it settled where it declares it (`exportedValue`).
  if (
    isFunctionDeclaration(each) ||
    isClassDeclaration(each) ||
    each.getSourceFile() !== reading.sourceFile
  ) {
    return { done: true, value: each };
  }
  const named = unwrapped(each);
  if (!isIdentifier(named)) {
    return { done: true, value: each };
  }
  const key = `${reading.file}#local:${named.text}`;
  if (reading.state.visiting.has(key)) {
    reading.state.cycled = true;
    return { done: true, value: undefined };
  }
  reading.state.visiting.add(key);
  localKeys.push(key);
  const found = localValue(named.text, reading);
  if (found === undefined) {
    return { done: true, value: globalOf(named) === undefined ? undefined : named };
  }
  return { done: false, next: found };
}

/** What the file declares, or imports, as `name`. */
function localValue(name: string, reading: ModuleReading): DeclaredValue | undefined {
  for (const statement of reading.sourceFile.statements) {
    const found = localStatementValue(statement, name, reading);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function localStatementValue(
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
  if (isVariableStatement(statement)) {
    return constantIn(statement, name, reading);
  }
  return isImportDeclaration(statement) ? importedValue(statement, name, reading) : undefined;
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

/** What an import declaration binds as `name`, as the module it imports exports it. */
function importedValue(
  statement: ImportDeclaration,
  name: string,
  reading: ModuleReading,
): DeclaredValue | undefined {
  const clause = statement.importClause;
  if (clause === undefined || clause.phaseModifier === SyntaxKind.TypeKeyword) {
    return undefined;
  }
  let exported: string | undefined;
  if (clause.name?.text === name) {
    exported = 'default';
  } else if (clause.namedBindings !== undefined && isNamedImports(clause.namedBindings)) {
    const element = clause.namedBindings.elements.find(
      (each) => !each.isTypeOnly && each.name.text === name,
    );
    exported = element === undefined ? undefined : (element.propertyName ?? element.name).text;
  }
  const other = exported === undefined ? undefined : fileOf(statement.moduleSpecifier, reading);
  return other === undefined || exported === undefined
    ? undefined
    : lookupExport(reading.modules, other, exported, reading.state).value;
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
