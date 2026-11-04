import {
  type EntityName,
  type EnumDeclaration,
  type ExportDeclaration,
  type ImportDeclaration,
  type InterfaceDeclaration,
  isClassDeclaration,
  isEnumDeclaration,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isInterfaceDeclaration,
  isNamedExports,
  isNamespaceImport,
  isQualifiedName,
  isStringLiteral,
  isTypeAliasDeclaration,
  type Node,
  type SourceFile,
  type Statement,
  SyntaxKind,
  type TypeAliasDeclaration,
  type TypeParameterDeclaration,
  isExpressionWithTypeArguments,
  isPropertyAccessExpression,
  isTypeQueryNode,
  isTypeReferenceNode,
} from 'typescript/ast';

import type { Modules } from './modules.ts';

/**
 * What a name of a type names where the code writes it: an alias, an interface or an enum its file
 * declares, or one an application's file it imports it of exports — re-exported too, by
 * `export { … } from` and `export *` — each file read as the compile's modules parse it.
 */

/** Where a type is written: its file, whose names it reads. */
export interface TypeSite {
  readonly file: string;
  readonly sourceFile: SourceFile;
}

/** What types are read with: the compile's modules, and what is read under way, each once. */
export interface TypeReading {
  readonly modules: Modules;
  /** The declarations read under way, which one that reads itself does not read again. */
  readonly aliases: Set<Node>;
  /** The exports looked for under way, `file#name`, which a cycle of re-exports does not again. */
  readonly exports: Set<string>;
  /** The type parameters of the function the types are written for — a generic hook's — in its file. */
  readonly parameters?: {
    readonly file: string;
    readonly declarations: readonly TypeParameterDeclaration[];
    /**
     * Whether each call gives them, as what it is given — a function's whose answer is read — so
     * that they say nothing of the values of the types read, rather than their constraints do.
     */
    readonly given?: boolean;
  };
}

/** A name of a type declared as an alias, an interface or an enum, and where. */
export interface Declared {
  readonly declaration: EnumDeclaration | InterfaceDeclaration | TypeAliasDeclaration;
  readonly at: TypeSite;
}

/** Where a name is imported of: the name its module exports it as, and the file, but a package's. */
interface Imported {
  readonly name: string;
  readonly file: string | undefined;
}

export function typeReading(modules: Modules, parameters?: TypeReading['parameters']): TypeReading {
  return {
    aliases: new Set(),
    exports: new Set(),
    modules,
    ...(parameters !== undefined && { parameters }),
  };
}

/** The type parameter `name` names where it is written — a generic hook's — none of another name. */
export function typeParameterOf(
  name: EntityName,
  at: TypeSite,
  reading: TypeReading,
): TypeParameterDeclaration | undefined {
  const { parameters } = reading;
  return parameters?.file === at.file && isIdentifier(name)
    ? parameters.declarations.find((each) => each.name.text === name.text)
    : undefined;
}

/**
 * Whether `name` is one of the language's own types — `Array`, `Readonly` — as its file neither
 * declares a type of that name nor imports one.
 */
export function isLanguageType(name: EntityName, at: TypeSite): boolean {
  if (!isIdentifier(name)) {
    return false;
  }
  return !at.sourceFile.statements.some((statement) => {
    return isImportDeclaration(statement)
      ? importedName(statement, name.text) !== undefined
      : declares(statement, name.text);
  });
}

/**
 * The alias, interface or enum `name` names where it is written: its file's, or the one the file
 * it is imported of exports as it, re-exported too; none where it names what the compile does not
 * read — a package's, a class, the language's own, a default export.
 */
export function declarationOf(
  name: EntityName,
  at: TypeSite,
  reading: TypeReading,
): Declared | undefined {
  if (isQualifiedName(name)) {
    // `ns.Selection`, of `import type * as ns from '…'`.
    const imported = isIdentifier(name.left) ? importOf(name.left.text, at, reading) : undefined;
    return imported?.file === undefined || imported.name !== '*'
      ? undefined
      : exportedOf(name.right.text, siteOf(imported.file, reading), reading);
  }
  return namedIn(name.text, at, reading);
}

/** What `name`, a name of its own, names in `at`'s file, as `declarationOf` reads it. */
function namedIn(name: string, at: TypeSite, reading: TypeReading): Declared | undefined {
  const statement = at.sourceFile.statements.find((each) => declares(each, name));
  if (statement !== undefined) {
    const declaration = typeDeclaration(statement);
    return declaration === undefined ? undefined : { at, declaration };
  }
  const imported = importOf(name, at, reading);
  return imported?.file === undefined || imported.name === '*' || imported.name === 'default'
    ? undefined
    : exportedOf(imported.name, siteOf(imported.file, reading), reading);
}

/** Whether `statement` declares a type named `name`: an alias, an interface, an enum or a class. */
function declares(statement: Statement, name: string): boolean {
  return (
    (isTypeAliasDeclaration(statement) ||
      isInterfaceDeclaration(statement) ||
      isEnumDeclaration(statement) ||
      isClassDeclaration(statement)) &&
    statement.name?.text === name
  );
}

/** The alias, interface or enum `statement` declares; none of anything else, a class among it. */
function typeDeclaration(statement: Statement): Declared['declaration'] | undefined {
  return isTypeAliasDeclaration(statement) ||
    isInterfaceDeclaration(statement) ||
    isEnumDeclaration(statement)
    ? statement
    : undefined;
}

/** Where `name`, which `at`'s file imports, is exported of; none where the file imports no such name. */
function importOf(name: string, at: TypeSite, reading: TypeReading): Imported | undefined {
  for (const statement of at.sourceFile.statements) {
    const exported = isImportDeclaration(statement) ? importedName(statement, name) : undefined;
    if (
      exported !== undefined &&
      isImportDeclaration(statement) &&
      isStringLiteral(statement.moduleSpecifier)
    ) {
      return {
        file: reading.modules.resolve(statement.moduleSpecifier.text, at.file),
        name: exported,
      };
    }
  }
  return undefined;
}

/** The name `declaration` imports `name` as of its module — `default`, `*` — none of no such import. */
function importedName(declaration: ImportDeclaration, name: string): string | undefined {
  const clause = declaration.importClause;
  if (clause?.name?.text === name) {
    return 'default';
  }
  const named = clause?.namedBindings;
  if (named === undefined) {
    return undefined;
  }
  if (isNamespaceImport(named)) {
    return named.name.text === name ? '*' : undefined;
  }
  const element = named.elements.find((each) => each.name.text === name);
  return element === undefined ? undefined : (element.propertyName ?? element.name).text;
}

function siteOf(file: string, reading: TypeReading): TypeSite {
  return { file, sourceFile: reading.modules.parse(file, false).sourceFile };
}

/**
 * The alias, interface or enum `site`'s file exports as `name` — declared and exported there, or
 * exported of what it declares or imports, or re-exported of another of the application's files —
 * none where it exports none the compile reads, or where the re-exports run in a cycle.
 */
function exportedOf(name: string, site: TypeSite, reading: TypeReading): Declared | undefined {
  const key = `${site.file}#${name}`;
  if (reading.exports.has(key)) {
    return undefined;
  }
  reading.exports.add(key);
  try {
    const { statements } = site.sourceFile;
    for (const statement of statements) {
      const found = isStarExport(statement)
        ? undefined
        : exportedBy(statement, name, site, reading);
      if (found !== undefined) {
        return found;
      }
    }
    // What `export *` re-exports, where the file exports no such name of its own — none where two
    // of them re-export the name of what are not one declaration, which no import of it reads.
    const starred = new Set<Declared['declaration']>();
    let found: Declared | undefined;
    for (const statement of statements) {
      const each = isStarExport(statement) ? exportedBy(statement, name, site, reading) : undefined;
      if (each !== undefined) {
        starred.add(each.declaration);
        found = each;
      }
    }
    return starred.size === 1 ? found : undefined;
  } finally {
    reading.exports.delete(key);
  }
}

/** Whether `statement` is `export * from '…'`, which re-exports what another file exports. */
function isStarExport(statement: Statement): boolean {
  return isExportDeclaration(statement) && statement.exportClause === undefined;
}

/** What `statement` of `site`'s file exports as `name`, as `exportedOf` reads it. */
function exportedBy(
  statement: Statement,
  name: string,
  site: TypeSite,
  reading: TypeReading,
): Declared | undefined {
  const declaration = typeDeclaration(statement);
  if (declaration !== undefined) {
    const exported = declaration.modifiers?.some((each) => each.kind === SyntaxKind.ExportKeyword);
    return exported === true && declaration.name.text === name
      ? { at: site, declaration }
      : undefined;
  }
  return isExportDeclaration(statement) ? reExported(statement, name, site, reading) : undefined;
}

/** What `declaration` — `export … from`, `export { … }` — of `site`'s file exports as `name`. */
function reExported(
  declaration: ExportDeclaration,
  name: string,
  site: TypeSite,
  reading: TypeReading,
): Declared | undefined {
  const specifier = declaration.moduleSpecifier;
  const from = (): TypeSite | undefined => {
    const file =
      specifier !== undefined && isStringLiteral(specifier)
        ? reading.modules.resolve(specifier.text, site.file)
        : undefined;
    return file === undefined ? undefined : siteOf(file, reading);
  };
  const clause = declaration.exportClause;
  if (clause === undefined) {
    // `export * from './selection'`.
    const other = from();
    return other === undefined ? undefined : exportedOf(name, other, reading);
  }
  const element = isNamedExports(clause)
    ? clause.elements.find((each) => each.name.text === name)
    : undefined;
  if (element === undefined) {
    return undefined;
  }
  const original = (element.propertyName ?? element.name).text;
  if (specifier === undefined) {
    // `export { Selection as Chosen }`, of what the file declares or imports.
    return namedIn(original, site, reading);
  }
  const other = from();
  return other === undefined ? undefined : exportedOf(original, other, reading);
}

/**
 * The names a type refers by, leftmost — `Foo` of `Foo.Bar<T>`, `db` of `typeof db.todos` — which an
 * output that copies the type imports.
 */
export function typeNames(type: Node | undefined): ReadonlySet<string> {
  const found = new Set<string>();
  const visit = (node: Node): void => {
    let name: Node | undefined;
    if (isTypeReferenceNode(node)) {
      name = node.typeName;
    } else if (isTypeQueryNode(node)) {
      name = node.exprName;
    } else if (isExpressionWithTypeArguments(node)) {
      name = node.expression;
    }
    while (name !== undefined && (isQualifiedName(name) || isPropertyAccessExpression(name))) {
      name = isQualifiedName(name) ? name.left : name.expression;
    }
    if (name !== undefined && isIdentifier(name)) {
      found.add(name.text);
    }
    node.forEachChild(visit);
  };
  if (type !== undefined) {
    visit(type);
  }
  return found;
}
