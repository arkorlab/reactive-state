import path from 'node:path';

import {
  type Expression,
  isAsExpression,
  isBinaryExpression,
  isClassDeclaration,
  isDecorator,
  isEnumDeclaration,
  isExportDeclaration,
  isExportSpecifier,
  isExportAssignment,
  isExpressionStatement,
  isFunctionDeclaration,
  isIdentifier,
  type Identifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isModuleDeclaration,
  isNamespaceImport,
  isNonNullExpression,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isSpreadAssignment,
  isSourceFile,
  isStringLiteral,
  isTypeAssertion,
  isVariableStatement,
  type Node,
  NodeFlags,
  type ObjectLiteralExpression,
  type SourceFile,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { bindingIdentifiers, freeReads, hoistedIn } from '../compiler/scope.ts';
import { openTypeScript, parseModule } from '../compiler/typescript.ts';

/**
 * What an application's `next.config` writes of the options the adapter turns on, read from its
 * source and never run: Next.js has run it once already, as it read the config it hands the adapter
 * — its defaults filled in, which say nothing of what the application wrote — and a config run
 * again may answer otherwise, a function of the phase or of state it keeps, a module that does
 * something as it is evaluated. Read where the config is written plainly: an object, as the module
 * exports it or a constant it exports, of options written as they are. Nothing is read of one
 * written otherwise — a function, a call, a spread, a decorator, an option computed, a constant read anywhere
 * else in the module, or a CommonJS export whose `module` is read elsewhere, which may change it —
 * which says nothing the adapter may go by.
 */

/** What a config writes of the options the adapter turns on: each as written, none where left out. */
export interface ConfigWritten {
  readonly cacheComponents: boolean | undefined;
  /** `experimental.useCache`. */
  readonly useCache: boolean | undefined;
  /** Whether `experimental.cachedNavigations` is written at all. */
  readonly cachedNavigations: boolean;
}

/** What a config writes that writes none of them: an application with no `next.config` among them. */
export const NOTHING_WRITTEN: ConfigWritten = {
  cacheComponents: undefined,
  cachedNavigations: false,
  useCache: undefined,
};

/** How many constants an export is followed through, to the object they are. */
const MAX_CONSTANTS = 8;

/** `expression` without what only tells TypeScript of its type, nor its parentheses. */
function bare(expression: Expression): Expression {
  let inner = expression;
  while (
    isParenthesizedExpression(inner) ||
    isSatisfiesExpression(inner) ||
    isAsExpression(inner) ||
    isTypeAssertion(inner) ||
    isNonNullExpression(inner)
  ) {
    inner = inner.expression;
  }
  return inner;
}

/** Whether `expression` is `module.exports`. */
function isModuleExports(expression: Expression): boolean {
  return (
    isPropertyAccessExpression(expression) &&
    isIdentifier(expression.expression) &&
    expression.expression.text === 'module' &&
    expression.name.text === 'exports'
  );
}

/**
 * What the module exports as its config: `export default …`, or `module.exports = …` with no other
 * mention of `module` that may change the export, through another property access or an alias.
 */
function exportedOf(sourceFile: SourceFile): Expression | undefined {
  let exported: Expression | undefined;
  for (const statement of sourceFile.statements) {
    if (isExportAssignment(statement) && !statement.isExportEquals) {
      exported = statement.expression;
    } else if (
      isExpressionStatement(statement) &&
      isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === SyntaxKind.EqualsToken &&
      isModuleExports(statement.expression.left) &&
      bindingCount(sourceFile, 'module') === 0 &&
      mentions(sourceFile, 'module') === 1
    ) {
      exported = statement.expression.right;
    }
  }
  return exported;
}

/** Whether a list of variables declares with `const`, as its flags say. */
function isConst(flags: number): boolean {
  // eslint-disable-next-line no-bitwise -- TypeScript says `const` in these flags alone.
  return (flags & NodeFlags.Const) !== 0;
}

/** The module-level value bindings of `name`, including `var`s hoisted from its blocks. */
function bindingCount(sourceFile: SourceFile, name: string): number {
  const bindings = new Set<Identifier>();
  for (const statement of sourceFile.statements) {
    for (const binding of statementBindings(statement)) bindings.add(binding);
  }
  for (const declaration of hoistedIn(sourceFile.statements)) {
    for (const binding of bindingIdentifiers(declaration.name)) bindings.add(binding);
  }
  let count = 0;
  for (const binding of bindings) {
    if (binding.text === name) count += 1;
  }
  return count;
}

/** Direct value declarations of one statement, excluding erased imports and type declarations. */
function statementBindings(statement: Statement): readonly Identifier[] {
  if (isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      bindingIdentifiers(declaration.name),
    );
  }
  if (isImportEqualsDeclaration(statement)) return statement.isTypeOnly ? [] : [statement.name];
  if (
    isFunctionDeclaration(statement) ||
    isClassDeclaration(statement) ||
    isEnumDeclaration(statement) ||
    isModuleDeclaration(statement)
  ) {
    return statement.name !== undefined && isIdentifier(statement.name) ? [statement.name] : [];
  }
  return importedBindings(statement);
}

/** Runtime imports' local names, excluding the source's labels and erased type imports. */
function importedBindings(statement: Statement): readonly Identifier[] {
  if (!isImportDeclaration(statement)) return [];
  const clause = statement.importClause;
  if (clause === undefined || clause.phaseModifier === SyntaxKind.TypeKeyword) return [];
  const bindings: Identifier[] = clause.name === undefined ? [] : [clause.name];
  const named = clause.namedBindings;
  if (named === undefined) return bindings;
  if (isNamespaceImport(named)) return [...bindings, named.name];
  for (const element of named.elements) {
    if (!element.isTypeOnly) bindings.push(element.name);
  }
  return bindings;
}

/** Actual reads or writes of the module's binding, without property labels or local shadows. */
function mentions(sourceFile: SourceFile, name: string): number {
  let count = 0;
  for (const statement of sourceFile.statements) {
    for (const reference of freeReads(statement)) {
      if (reference.text === name && runtimeReference(reference)) count += 1;
    }
  }
  return count;
}

/** Imported and exported names are labels; a local value exported under another name still escapes. */
function runtimeReference(reference: Identifier): boolean {
  const parent = reference.parent;
  if (
    isExportSpecifier(parent) &&
    (parent.isTypeOnly || (parent.propertyName ?? parent.name) !== reference)
  )
    return false;
  for (let at = parent; !isSourceFile(at); at = at.parent) {
    if (isImportDeclaration(at) || isImportEqualsDeclaration(at)) return false;
    if (isExportDeclaration(at) && (at.isTypeOnly || at.moduleSpecifier !== undefined))
      return false;
  }
  return true;
}

/**
 * The value of the top-level `const` `name` is declared with in `sourceFile`, where `name` is
 * declared only once and read only where the module exports it, so that nothing changes it.
 */
function constantOf(sourceFile: SourceFile, name: string): Expression | undefined {
  // Any further use of this binding may change what its object holds.
  if (bindingCount(sourceFile, name) !== 1 || mentions(sourceFile, name) !== 1) {
    return undefined;
  }
  for (const statement of sourceFile.statements) {
    if (isVariableStatement(statement) && isConst(statement.declarationList.flags)) {
      const declared = statement.declarationList.declarations.find(
        (declaration) => isIdentifier(declaration.name) && declaration.name.text === name,
      );
      if (declared !== undefined) {
        return declared.initializer;
      }
    }
  }
  return undefined;
}

/** The object `expression` is, written as one, through constants of the module; none otherwise. */
function objectOf(
  expression: Expression,
  sourceFile: SourceFile,
): ObjectLiteralExpression | undefined {
  let value: Expression | undefined = bare(expression);
  for (let followed = 0; value !== undefined && followed < MAX_CONSTANTS; followed += 1) {
    if (isObjectLiteralExpression(value)) {
      return value;
    }
    if (!isIdentifier(value)) {
      return undefined;
    }
    const constant = constantOf(sourceFile, value.text);
    value = constant === undefined ? undefined : bare(constant);
  }
  return undefined;
}

/** A property's name, as written; none for one computed. */
function nameOf(name: Node): string | undefined {
  return isIdentifier(name) || isStringLiteral(name) || isNoSubstitutionTemplateLiteral(name)
    ? name.text
    : undefined;
}

/**
 * What an object writes: each property's value by its name — `null` for one given as no value of
 * its own, a name of the module's or a function — or none for an object not read whole, of a spread
 * or a name computed.
 */
type Written = ReadonlyMap<string, Expression | null>;

function propertiesOf(object: ObjectLiteralExpression): Written | undefined {
  const written = new Map<string, Expression | null>();
  for (const property of object.properties) {
    if (isSpreadAssignment(property)) {
      return undefined;
    }
    const name = nameOf(property.name);
    if (name === undefined) {
      return undefined;
    }
    written.set(name, isPropertyAssignment(property) ? property.initializer : null);
  }
  return written;
}

/** `true` or `false`, as written; none for anything else. */
function booleanOf(expression: Expression): boolean | undefined {
  const { kind } = bare(expression);
  if (kind === SyntaxKind.TrueKeyword) {
    return true;
  }
  return kind === SyntaxKind.FalseKeyword ? false : undefined;
}

/**
 * An option written as `true` or `false`; `undefined` where it is left out; `null` where it is
 * written otherwise, which the adapter cannot go by.
 */
function optionOf(written: Written, name: string): boolean | null | undefined {
  if (!written.has(name)) {
    return undefined;
  }
  const value = written.get(name);
  return value === null || value === undefined ? null : (booleanOf(value) ?? null);
}

/** The properties of the object `expression` is, written as one; none otherwise. */
function propertiesOfObject(expression: Expression, sourceFile: SourceFile): Written | undefined {
  const object = objectOf(expression, sourceFile);
  return object === undefined ? undefined : propertiesOf(object);
}

/** What the config writes in `experimental`: nothing where it leaves it out; none where not plainly. */
function experimentalOf(written: Written, sourceFile: SourceFile): Written | undefined {
  if (!written.has('experimental')) {
    return new Map();
  }
  const value = written.get('experimental');
  return value === null || value === undefined ? undefined : propertiesOfObject(value, sourceFile);
}

/** What the config's own object writes of the options; none where it does not write them plainly. */
function writtenOf(
  object: ObjectLiteralExpression,
  sourceFile: SourceFile,
): ConfigWritten | undefined {
  const written = propertiesOf(object);
  const inner = written === undefined ? undefined : experimentalOf(written, sourceFile);
  if (written === undefined || inner === undefined) {
    return undefined;
  }
  const cacheComponents = optionOf(written, 'cacheComponents');
  const useCache = optionOf(inner, 'useCache');
  if (cacheComponents === null || useCache === null) {
    return undefined;
  }
  return { cacheComponents, cachedNavigations: inner.has('cachedNavigations'), useCache };
}

/** Whether the source contains a decorator whose evaluation scope the plain reader does not follow. */
function decorated(sourceFile: SourceFile): boolean {
  const pending: Node[] = [sourceFile];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (isDecorator(at)) return true;
    at.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/**
 * What the `next.config` at `file`, of `source`, writes of the options the adapter turns on, read
 * from its source and never run; none where it writes its config otherwise than plainly (see above).
 */
export function configWritten(file: string, source: string): ConfigWritten | undefined {
  using api = openTypeScript(path.dirname(file));
  using parsed = parseModule(api, file, source);
  const { sourceFile } = parsed;
  if (decorated(sourceFile)) return undefined;
  const exported = exportedOf(sourceFile);
  const object = exported === undefined ? undefined : objectOf(exported, sourceFile);
  return object === undefined ? undefined : writtenOf(object, sourceFile);
}
