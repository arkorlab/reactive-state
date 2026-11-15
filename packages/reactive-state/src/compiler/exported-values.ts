import {
  type ArrayLiteralExpression,
  type ClassDeclaration,
  type ExportDeclaration,
  type Expression,
  type FunctionDeclaration,
  type GetAccessorDeclaration,
  type Identifier,
  isArrayLiteralExpression,
  isClassDeclaration,
  isComputedPropertyName,
  isElementAccessExpression,
  isExportAssignment,
  isExportDeclaration,
  isFunctionDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isImportDeclaration,
  isMethodDeclaration,
  isNamedExports,
  isNamedImports,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isVariableStatement,
  type MethodDeclaration,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type SourceFile,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { globalOf, unwrapped } from './bounded.ts';
import {
  isPrototypeEntry,
  laterPrototypeWork,
  prototypeInitializer,
} from './exported-prototypes.ts';
import type { Modules } from './modules.ts';
import { freeReads } from './scope.ts';
import { isConstant } from './statements.ts';

/**
 * What a value an application's module exports is, where the module declares it — followed through
 * `export { … }`, `export … from`, `export *` and what the module itself imports — and what an entry
 * of the objects and the arrays it writes holds, as the compile reads what a site's element is
 * given of it (`json-values.ts`): a function a `shared` module exports, or a date it holds, is no
 * JSON a reactive component is rendered with.
 */

/** A value a module declares: a function's or a class's declaration, or a constant's initializer. */
type DeclaredValue = ClassDeclaration | Expression | FunctionDeclaration;

/**
 * What an entry of an object a module writes holds: its value, the method it is, or the accessor
 * that answers it, read.
 */
export type MemberValue = DeclaredValue | GetAccessorDeclaration | MethodDeclaration;

/** A module's file, as the compile reads it, and the exports looked for under way. */
interface Reading {
  readonly modules: Modules;
  readonly file: string;
  readonly sourceFile: SourceFile;
  readonly seen: Set<string>;
}

/**
 * What `file` exports as `name`, where it declares it — its own export, then what an `export *`
 * re-exports — none where it exports none the compile reads, or the re-exports run in a cycle.
 */
function exportedValue(
  modules: Modules,
  file: string,
  name: string,
  seen = new Set<string>(),
): DeclaredValue | undefined {
  const key = `${file}#${name}`;
  if (seen.has(key)) {
    return undefined;
  }
  seen.add(key);
  const reading: Reading = {
    file,
    modules,
    seen,
    sourceFile: modules.parse(file, false).sourceFile,
  };
  const { statements } = reading.sourceFile;
  for (const statement of statements) {
    const found = exportedBy(statement, name, reading);
    if (found !== undefined) {
      return settled(found, reading);
    }
  }
  for (const statement of statements) {
    // `export * from './panels'`, where the file exports no such name of its own.
    if (isExportDeclaration(statement) && statement.exportClause === undefined) {
      const other = fileOf(statement.moduleSpecifier, reading);
      const found = other === undefined ? undefined : exportedValue(modules, other, name, seen);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

/**
 * What `file` exports as `name`, read at each of `keys` in turn — `when` of `payload.when`, of
 * `export const payload = { when: … }` — through the objects and the arrays its modules write, an
 * entry's value as its own module declares it; none where one is written otherwise: of a call, of
 * an entry a spread or a key the code computes may write, or of an accessor, which computes it.
 */
export function exportedMember(
  modules: Modules,
  file: string,
  name: string,
  keys: readonly string[],
): MemberValue | undefined {
  let value: MemberValue | undefined = exportedValue(modules, file, name);
  for (const key of keys) {
    if (value === undefined) {
      return undefined;
    }
    value = entryOf(modules, value, key);
  }
  return value;
}

/**
 * What the name `name` holds where its module writes it, as an export of it is read (`settled`): a
 * constant's initializer, a function's or a class's declaration, what an import binds, a global
 * itself — none of a name the module declares otherwise, a variable's, a parameter's.
 */
function declaredBy(modules: Modules, name: Identifier): DeclaredValue | undefined {
  return settled(name, readingOf(modules, name));
}

/** What the name `name` holds where its module declares it a constant (`declaredBy`); none of another. */
export function moduleValue(modules: Modules, name: Identifier): Expression | undefined {
  const found = declaredBy(modules, name);
  return found === undefined || isDeclaration(found) ? undefined : found;
}

/** The function the name `name` is of where its module declares it (`declaredBy`); none of another. */
export function moduleFunction(
  modules: Modules,
  name: Identifier,
): FunctionDeclaration | undefined {
  const found = readsModuleName(name) ? declaredBy(modules, name) : undefined;
  return found !== undefined && isFunctionDeclaration(found) ? found : undefined;
}

const MODULE_READS = new WeakMap<Node, ReadonlySet<Identifier>>();

/** A module name remains free inside its top-level statement, beyond nested parameters and locals. */
function readsModuleName(name: Identifier): boolean {
  let statement: Node = name;
  while (!isSourceFile(statement.parent)) {
    statement = statement.parent;
  }
  let reads = MODULE_READS.get(statement);
  if (reads === undefined) {
    reads = new Set(freeReads(statement));
    MODULE_READS.set(statement, reads);
  }
  return reads.has(name);
}

/** Whether the name `name` is of a function or a class its module declares (`declaredBy`). */
export function isModuleDeclaration(modules: Modules, name: Identifier): boolean {
  const found = declaredBy(modules, name);
  return found !== undefined && isDeclaration(found);
}

/** Whether what a module declares is a function's, a class's or a method's declaration, no value. */
export function isDeclaration(
  value: MemberValue,
): value is ClassDeclaration | FunctionDeclaration | MethodDeclaration {
  return isFunctionDeclaration(value) || isClassDeclaration(value) || isMethodDeclaration(value);
}

/** The key text or a number writes: `'when'`, `1` of `1.0`; none of another. */
export function literalKey(node: Node): string | undefined {
  if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return isNumericLiteral(node) ? String(Number(node.text)) : undefined;
}

/**
 * The keys `node` reads in turn, by name or by text or a number in brackets, and what it reads the
 * first of: `['when']` and `payload` of `payload.when`, none and `node` of anything else.
 */
export function memberPath(node: Expression): {
  readonly keys: readonly string[];
  readonly root: Expression;
} {
  const keys: string[] = [];
  let root = unwrapped(node);
  for (;;) {
    let key: string | undefined;
    if (isPropertyAccessExpression(root)) {
      key = root.name.text;
    } else if (isElementAccessExpression(root)) {
      key = literalKey(unwrapped(root.argumentExpression));
    }
    if (
      key === undefined ||
      !(isPropertyAccessExpression(root) || isElementAccessExpression(root))
    ) {
      return { keys, root };
    }
    keys.unshift(key);
    root = unwrapped(root.expression);
  }
}

/** What `value` holds at `key`: an entry of the object it writes, or an element of the array. */
function entryOf(modules: Modules, value: MemberValue, key: string): MemberValue | undefined {
  if (
    isFunctionDeclaration(value) ||
    isClassDeclaration(value) ||
    isMethodDeclaration(value) ||
    isGetAccessorDeclaration(value)
  ) {
    return undefined;
  }
  const written = unwrapped(value);
  const reading = readingOf(modules, written);
  if (isObjectLiteralExpression(written)) {
    return objectEntry(written, key, reading);
  }
  return isArrayLiteralExpression(written) ? arrayElement(written, key, reading) : undefined;
}

/**
 * What an object the code writes holds at a key, as `entryIn` reads it: what of its properties
 * writes it last, `held` — of `value`, none where that is a setter alone — a setter, `set`, which
 * the getter beside it answers; that none does, `none`; or that the compile cannot tell, `untold`,
 * of a spread or a key it cannot read, which may.
 */
interface Lookup {
  readonly kind: 'held' | 'none' | 'set' | 'untold';
  readonly value?: MemberValue | undefined;
  /** Whether what holds it is a getter, which a setter after it defines the entry with. */
  readonly getter?: boolean;
}

const NONE: Lookup = { kind: 'none' };
const UNTOLD: Lookup = { kind: 'untold' };

/** The deepest spreads `entryIn` reads into. */
const MAX_SPREADS = 16;

/**
 * The entry `key` of an object the code writes, of the last property that writes it: its value, as
 * the module declares it, the method, or the getter; none of a spread or a key the code computes
 * that may write it (`entryIn`).
 */
function objectEntry(
  object: ObjectLiteralExpression,
  key: string,
  reading: Reading,
): MemberValue | undefined {
  let current = object;
  let at = reading;
  const seen = new Set<ObjectLiteralExpression>();
  while (!seen.has(current)) {
    seen.add(current);
    const found = entryIn(current, key, at, 0);
    if (found.kind !== 'none') {
      return found.kind === 'held' ? found.value : undefined;
    }
    const expression = prototypeInitializer(current);
    const prototype =
      expression === undefined || laterPrototypeWork(current)
        ? undefined
        : settled(expression, { ...at, seen: new Set() });
    if (prototype === undefined || isDeclaration(prototype)) {
      return undefined;
    }
    const value = unwrapped(prototype);
    if (!isObjectLiteralExpression(value) || laterPrototypeWork(value)) {
      return undefined;
    }
    current = value;
    at = readingOf(at.modules, value);
  }
  return undefined;
}

/**
 * What `object` holds at `key` (`Lookup`), of its properties, last first (`propertyEntry`): past
 * what writes none of it; a setter defines the entry with the getter beside it, and none where
 * there is none, which what writes it before the setter would.
 */
function entryIn(
  object: ObjectLiteralExpression,
  key: string,
  reading: Reading,
  depth: number,
): Lookup {
  let isSet = false;
  for (const property of object.properties.toReversed()) {
    const found = propertyEntry(property, key, reading, depth);
    if (found.kind === 'set') {
      isSet = true;
    } else if (found.kind !== 'none') {
      return !isSet || found.kind === 'untold' || found.getter === true
        ? found
        : { kind: 'held', value: undefined };
    }
  }
  return isSet ? { kind: 'held', value: undefined } : NONE;
}

/**
 * What `property` writes at `key` (`Lookup`): a spread, what what it spreads holds
 * (`spreadEntry`); a property of another key, or of a key the code computes of a constant of other
 * text, none; one of a key the compile cannot read, untold.
 */
function propertyEntry(
  property: ObjectLiteralElementLike,
  key: string,
  reading: Reading,
  depth: number,
): Lookup {
  if (isSpreadAssignment(property)) {
    return spreadEntry(property.expression, key, reading, depth + 1);
  }
  if (isPrototypeEntry(property)) {
    return NONE;
  }
  const name = keyOf(property.name, reading);
  if (name === undefined) {
    return UNTOLD;
  }
  if (name !== key) {
    return NONE;
  }
  if (isSetAccessorDeclaration(property)) {
    return { kind: 'set' };
  }
  return {
    getter: isGetAccessorDeclaration(property),
    kind: 'held',
    value: propertyValue(property, reading),
  };
}

/**
 * What a spread of `expression` writes at `key` (`Lookup`): of an object the code writes, what it
 * holds; of `null` or `undefined`, none; of an array, none but at an index; anything else, untold.
 */
function spreadEntry(expression: Expression, key: string, reading: Reading, depth: number): Lookup {
  const value =
    depth > MAX_SPREADS ? undefined : settled(expression, { ...reading, seen: new Set() });
  if (value === undefined || isFunctionDeclaration(value) || isClassDeclaration(value)) {
    return UNTOLD;
  }
  const written = unwrapped(value);
  if (isObjectLiteralExpression(written)) {
    const found = entryIn(written, key, readingOf(reading.modules, written), depth);
    // What a spread writes, it writes as an entry of its own: a getter's answer, as it reads.
    return found.kind === 'held' ? { kind: 'held', value: found.value } : found;
  }
  if (isArrayLiteralExpression(written)) {
    const index = Number(key);
    return Number.isSafeInteger(index) && index >= 0 && String(index) === key ? UNTOLD : NONE;
  }
  const isNothing =
    written.kind === SyntaxKind.NullKeyword ||
    (isIdentifier(written) && globalOf(written) === 'undefined');
  return isNothing ? NONE : UNTOLD;
}

/** What an object's property holds, as `objectEntry` reads it: a getter, as what it answers. */
function propertyValue(
  property: ObjectLiteralElementLike,
  reading: Reading,
): MemberValue | undefined {
  if (isPropertyAssignment(property)) {
    return settled(property.initializer, reading);
  }
  if (isShorthandPropertyAssignment(property)) {
    return isIdentifier(property.name) ? settled(property.name, reading) : undefined;
  }
  return isMethodDeclaration(property) || isGetAccessorDeclaration(property) ? property : undefined;
}

/**
 * The key a property is written with, a name or what `literalKey` reads, in brackets too — of a
 * constant its module declares of one, `[KEY]` of `const KEY = 'when'`.
 */
function keyOf(name: Node | undefined, reading: Reading): string | undefined {
  if (name === undefined) {
    return undefined;
  }
  if (!isComputedPropertyName(name)) {
    return isIdentifier(name) ? name.text : literalKey(name);
  }
  const computed = unwrapped(name.expression);
  if (!isIdentifier(computed)) {
    return literalKey(computed);
  }
  const held = settled(computed, { ...reading, seen: new Set() });
  return held === undefined || isFunctionDeclaration(held) || isClassDeclaration(held)
    ? undefined
    : literalKey(unwrapped(held));
}

/** The element at the index `key` of an array the code writes: none past a spread, nor of a hole. */
function arrayElement(
  array: ArrayLiteralExpression,
  key: string,
  reading: Reading,
): MemberValue | undefined {
  const index = Number(key);
  if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key) {
    return undefined;
  }
  const elements = array.elements.slice(0, index + 1);
  const element = elements[index];
  return element === undefined ||
    isOmittedExpression(element) ||
    elements.some((each) => isSpreadElement(each))
    ? undefined
    : settled(element, reading);
}

/** The reading of the module `node` is written in. */
function readingOf(modules: Modules, node: Node): Reading {
  const sourceFile = node.getSourceFile();
  return { file: sourceFile.fileName, modules, seen: new Set(), sourceFile };
}

/** What `statement` exports as `name`, as `exportedValue` reads it. */
function exportedBy(
  statement: Statement,
  name: string,
  reading: Reading,
): DeclaredValue | undefined {
  if (isFunctionDeclaration(statement) || isClassDeclaration(statement)) {
    return isExported(statement) && exportName(statement) === name ? statement : undefined;
  }
  if (isVariableStatement(statement)) {
    return isExported(statement) ? constantIn(statement, name, reading) : undefined;
  }
  if (isExportAssignment(statement)) {
    // `export default value`.
    return name === 'default' && !statement.isExportEquals ? statement.expression : undefined;
  }
  return isExportDeclaration(statement) ? namedExport(statement, name, reading) : undefined;
}

/** What `export { … }` or `export { … } from …` exports as `name`. */
function namedExport(
  statement: ExportDeclaration,
  name: string,
  reading: Reading,
): DeclaredValue | undefined {
  const clause = statement.exportClause;
  if (clause === undefined) {
    return undefined;
  }
  const element = isNamedExports(clause)
    ? clause.elements.find((each) => each.name.text === name)
    : undefined;
  if (element === undefined) {
    return undefined;
  }
  const original = (element.propertyName ?? element.name).text;
  if (statement.moduleSpecifier === undefined) {
    // `export { fill as helper }`, of what the file declares or imports.
    return localValue(original, reading);
  }
  const other = fileOf(statement.moduleSpecifier, reading);
  return other === undefined
    ? undefined
    : exportedValue(reading.modules, other, original, reading.seen);
}

/**
 * `value`, or, where it is a name the file declares otherwise — `export default fill`,
 * `export const helper = fill` — what that declares, followed so, but a name under way already; a
 * global's name — `Infinity`, `undefined` — as itself, which what reads it reads as the global.
 */
function settled(value: DeclaredValue, reading: Reading): DeclaredValue | undefined {
  let each = value;
  for (;;) {
    if (isFunctionDeclaration(each) || isClassDeclaration(each)) {
      return each;
    }
    const named = unwrapped(each);
    if (!isIdentifier(named)) {
      return each;
    }
    const key = `${reading.file}#local:${named.text}`;
    if (reading.seen.has(key)) {
      return undefined;
    }
    reading.seen.add(key);
    const found = localValue(named.text, reading);
    if (found === undefined) {
      return globalOf(named) === undefined ? undefined : named;
    }
    // What another module declares, it settled where it declares it (`exportedValue`).
    if (found.getSourceFile() !== reading.sourceFile) {
      return found;
    }
    each = found;
  }
}

/** What the file declares, or imports, as `name`. */
function localValue(name: string, reading: Reading): DeclaredValue | undefined {
  for (const statement of reading.sourceFile.statements) {
    if (isFunctionDeclaration(statement) || isClassDeclaration(statement)) {
      if (statement.name?.text === name) {
        return statement;
      }
    } else if (isVariableStatement(statement)) {
      const found = constantIn(statement, name, reading);
      if (found !== undefined) {
        return found;
      }
    } else if (isImportDeclaration(statement)) {
      const found = importedValue(statement, name, reading);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

/** The initializer of the constant `name` a `const` statement declares. */
function constantIn(statement: Statement, name: string, reading: Reading): Expression | undefined {
  if (!isVariableStatement(statement) || !isConstant(statement, reading.sourceFile)) {
    return undefined;
  }
  const declaration = statement.declarationList.declarations.find(
    (each) => isIdentifier(each.name) && each.name.text === name,
  );
  return declaration?.initializer;
}

/** Whether the file `name` stands in imports it: `import name`, `{ name }`, `* as name`. */
export function isImportBinding(name: Identifier): boolean {
  return name.getSourceFile().statements.some((statement) => {
    const clause = isImportDeclaration(statement) ? statement.importClause : undefined;
    if (clause === undefined || clause.name?.text === name.text) {
      return clause !== undefined;
    }
    const bindings = clause.namedBindings;
    if (bindings === undefined) {
      return false;
    }
    return isNamedImports(bindings)
      ? bindings.elements.some((each) => each.name.text === name.text)
      : bindings.name.text === name.text;
  });
}

/** What an import declaration binds as `name`, as the module it imports exports it. */
function importedValue(
  statement: Statement,
  name: string,
  reading: Reading,
): DeclaredValue | undefined {
  if (!isImportDeclaration(statement) || statement.importClause === undefined) {
    return undefined;
  }
  const clause = statement.importClause;
  let exported: string | undefined;
  if (clause.name?.text === name) {
    exported = 'default';
  } else if (clause.namedBindings !== undefined && isNamedImports(clause.namedBindings)) {
    const element = clause.namedBindings.elements.find((each) => each.name.text === name);
    exported = element === undefined ? undefined : (element.propertyName ?? element.name).text;
  }
  const other = exported === undefined ? undefined : fileOf(statement.moduleSpecifier, reading);
  return other === undefined || exported === undefined
    ? undefined
    : exportedValue(reading.modules, other, exported, reading.seen);
}

/** Whether `statement` carries `export`. */
function isExported(statement: Statement): boolean {
  return (
    (statement as { readonly modifiers?: readonly Node[] }).modifiers?.some(
      (each) => each.kind === SyntaxKind.ExportKeyword,
    ) === true
  );
}

/** The name a declaration is exported as: its own, or `default`. */
function exportName(declaration: ClassDeclaration | FunctionDeclaration): string | undefined {
  const isDefault = declaration.modifiers?.some((each) => each.kind === SyntaxKind.DefaultKeyword);
  return isDefault === true ? 'default' : declaration.name?.text;
}

/** The application's file a specifier leads to from `reading`'s file; none of a package's. */
function fileOf(specifier: Node | undefined, reading: Reading): string | undefined {
  return specifier !== undefined && isStringLiteral(specifier)
    ? reading.modules.resolve(specifier.text, reading.file)
    : undefined;
}
