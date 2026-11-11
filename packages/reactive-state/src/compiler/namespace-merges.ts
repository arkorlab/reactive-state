import {
  type EntityName,
  type EnumDeclaration,
  type EnumMember,
  type ImportEqualsDeclaration,
  isBlock,
  isCaseBlock,
  isCaseClause,
  isClassDeclaration,
  isDefaultClause,
  isEnumDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isExternalModuleReference,
  isImportDeclaration,
  isNamespaceImport,
  isQualifiedName,
  isImportEqualsDeclaration,
  isInterfaceDeclaration,
  isModuleBlock,
  isModuleDeclaration,
  isSourceFile,
  isStringLiteral,
  isTypeAliasDeclaration,
  isVariableStatement,
  type ModuleBlock,
  type ModuleDeclaration,
  type Node,
  NodeFlags,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { namespaceStatements } from './local-type-namespaces.ts';
import { bindingIdentifiers } from './scope.ts';

/** How namespaces and enums merge their declarations, and what each name they bind is. */

/** The names of the members of each enum and of those merged with it (`hasEnumMember`), by the enum. */
const MEMBERS = new WeakMap<EnumDeclaration, ReadonlySet<string>>();

/** The names the namespaces that merge with a namespace export (`exportedElsewhere`), by it. */
const EXPORTED = new WeakMap<ModuleDeclaration, ReadonlyMap<string, Known>>();

/** What each `import … =` alias gives (`aliasMeaning`), by it. */
const MEANINGS = new WeakMap<ImportEqualsDeclaration, Meaning>();

/** What a name given by an alias is: a value, a type alone, or what the file cannot tell. */
export type Meaning = 'value' | 'type' | 'unknown';

/** What a name that may be a value is: one, or what the file cannot tell. */
export type Known = Exclude<Meaning, 'type'>;

/**
 * Whether an enum, or one merged with it, has a member named `name`: within their initializers the
 * bare name is that member, before any binding around them. The names are gathered once
 * (`MEMBERS`), for every name looked up within the enum.
 */
export function hasEnumMember(enumeration: EnumDeclaration, name: string): boolean {
  let names = MEMBERS.get(enumeration);
  if (names === undefined) {
    names = new Set(
      mergedEnums(enumeration).flatMap((each) =>
        each.members.flatMap((member) => memberText(member)),
      ),
    );
    MEMBERS.set(enumeration, names);
  }
  return names.has(name);
}

/** The name a member gives by an identifier or by text; none of another. */
function memberText(member: EnumMember): readonly string[] {
  return isIdentifier(member.name) || isStringLiteral(member.name) ? [member.name.text] : [];
}

/**
 * The enums that merge with `enumeration`, itself among them: those of its name in its scope and,
 * where the other bodies of its namespace see it, exported or ambient, those they export
 * (`namespaceStatements`); one that is private to its body merges with its own scope's alone.
 */
function mergedEnums(enumeration: EnumDeclaration): readonly EnumDeclaration[] {
  const { parent } = enumeration;
  const scope = isCaseClause(parent) || isDefaultClause(parent) ? parent.parent : parent;
  const merging = isModuleBlock(scope) && exposed(enumeration);
  const statements = merging ? bodyStatements(scope) : statementsOf(scope);
  return (statements ?? [enumeration]).flatMap((statement) => {
    return isEnumDeclaration(statement) && statement.name.text === enumeration.name.text
      ? [statement]
      : [];
  });
}

/**
 * What the namespaces that merge with `namespace`, its other declarations, export as `name`: a
 * value — a variable, a function, a class, an enum, a namespace of a value, an alias of a value, or
 * a dotted namespace's own name, `B` of `namespace A.B` — so that a bare `name` within its body is
 * `N.name`, before any binding around it; `unknown` for an alias of what the file does not declare,
 * which may be one; none otherwise. The names are gathered once (`EXPORTED`), for every name
 * looked up in the namespace.
 */
export function exportedElsewhere(
  namespace: ModuleDeclaration,
  within: Node,
  name: string,
): Known | undefined {
  // Of what is within its body, a block or the dotted namespace that is it, and nothing beside.
  if (!isModuleBlock(within) && !isModuleDeclaration(within)) return undefined;
  let names = EXPORTED.get(namespace);
  if (names === undefined) {
    names = exportedNames(namespace);
    EXPORTED.set(namespace, names);
  }
  return names.get(name);
}

/** The names the declarations that merge with `namespace` export, each as what it is there. */
function exportedNames(namespace: ModuleDeclaration): ReadonlyMap<string, Known> {
  const names = new Map<string, Known>();
  const entries = mergedDeclarations(namespace).flatMap((each) =>
    exposedContents(each).flatMap((statement) => valueNames(statement)),
  );
  for (const [name, meaning] of entries) {
    if (names.get(name) !== 'value') names.set(name, meaning);
  }
  return names;
}

/**
 * The declarations that merge with `namespace`, itself among them: those of its name among what
 * its scope holds — among what the other bodies of the namespace around it export too
 * (`namespaceStatements`), where it is exported or ambient; one that is private stays in its
 * body — and, for the inner part of a dotted namespace, among what the declarations that merge with
 * its outer part expose.
 */
function mergedDeclarations(namespace: ModuleDeclaration): readonly ModuleDeclaration[] {
  const { name, parent } = namespace;
  if (!isIdentifier(name)) return [namespace];
  let among: readonly Statement[];
  if (isModuleDeclaration(parent)) {
    among = mergedDeclarations(parent).flatMap((each) => exposedContents(each));
  } else if (isModuleBlock(parent) && exposed(namespace)) {
    among = bodyStatements(parent);
  } else {
    among = statementsOf(parent) ?? [namespace];
  }
  return among.flatMap((statement) => {
    const found =
      isModuleDeclaration(statement) &&
      isIdentifier(statement.name) &&
      statement.name.text === name.text;
    return found ? [statement] : [];
  });
}

/**
 * What a namespace declaration lets the others that merge with it see: the dotted inner namespace
 * that is its body, or the statements of its body that are exported, or all of them where it is
 * ambient but for the imports.
 */
function exposedContents(namespace: ModuleDeclaration): readonly Statement[] {
  const { body } = namespace;
  if (body === undefined) return [];
  if (isModuleDeclaration(body)) return [body];
  return isModuleBlock(body) ? body.statements.filter((statement) => exposed(statement)) : [];
}

/**
 * What is in scope in a namespace's body: its own statements, and those the other bodies of its
 * namespace expose, which are members of it (`namespaceStatements`, but for what the context of a
 * body does not export, nor for what is within a namespace that an enclosing body keeps private).
 */
function bodyStatements(block: ModuleBlock): readonly Statement[] {
  const around = new Set<Node>();
  for (let at: Node = block; !isSourceFile(at); at = at.parent) around.add(at);
  return namespaceStatements(block).filter((statement) => shown(statement, around));
}

/**
 * Whether a statement of another body is a member of a namespace that `around`, the nodes about
 * the one that looks, are within: the statement is exposed in its body, and so is each namespace
 * of it, in its own enclosing body, up to the body that holds the looker too. Declarations that
 * share a body merge by their names, whether exported or not (`namespace A` twice in one body);
 * a namespace that an enclosing body does not export is private to that body (`namespace N` of an
 * ambient body with an `export {}`), with whatever it holds, to the other bodies of its outer
 * namespace.
 */
function shown(statement: Statement, around: ReadonlySet<Node>): boolean {
  let at: Statement = statement;
  while (!around.has(at.parent)) {
    const { parent } = at;
    // The dotted inner namespace of a name is exported by the parser, so only a block's can lack it.
    if (isModuleBlock(parent) && !exposed(at)) return false;
    const holder = isModuleBlock(parent) ? parent.parent : parent;
    if (!isModuleDeclaration(holder)) return true;
    at = holder;
  }
  return true;
}

/**
 * Whether a statement of a namespace's body is a member of the namespace: it is exported, or the
 * namespace is ambient with no export declaration, where every statement is but an `import … =`
 * alias (`ExportContext`, which TypeScript sets of the namespace, not of each statement: a `declare`
 * statement in a body that is not ambient is private).
 */
function exposed(statement: Statement): boolean {
  const { modifiers } = statement as { readonly modifiers?: readonly Node[] };
  if (modifiers?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword) === true) {
    return true;
  }
  const holder = isModuleBlock(statement.parent) ? statement.parent.parent : undefined;
  return (
    holder !== undefined &&
    isModuleDeclaration(holder) &&
    // eslint-disable-next-line no-bitwise -- TypeScript says an export context in these flags alone.
    (holder.flags & NodeFlags.ExportContext) !== 0 &&
    !isImportEqualsDeclaration(statement)
  );
}

/** The names of the values a statement declares: variables, functions, classes, enums, namespaces. */
function valueNames(statement: Statement): readonly (readonly [string, Known])[] {
  if (isVariableStatement(statement)) {
    return statement.declarationList.declarations
      .flatMap((declaration) => bindingIdentifiers(declaration.name))
      .map((bound): readonly [string, Known] => [bound.text, 'value']);
  }
  if (isFunctionDeclaration(statement) || isClassDeclaration(statement)) {
    return statement.name === undefined ? [] : [[statement.name.text, 'value']];
  }
  const bound = boundName(statement);
  return bound === undefined || bound[1] === 'type' ? [] : [[bound[0], bound[1]]];
}

/** Ordinary and namespace blocks keep their statements; a switch's clauses share one scope. */
export function statementsOf(node: Node): readonly Statement[] | undefined {
  if (isCaseBlock(node)) return node.clauses.flatMap((clause) => clause.statements);
  return isBlock(node) || isModuleBlock(node) || isSourceFile(node) ? node.statements : undefined;
}

/**
 * The name an enum, a namespace or an `import … =` alias of a value gives; none of another
 * statement, of a module the code names by text (`declare module 'x'`), of a namespace of types
 * alone, or of an alias of a type. An alias of what the file does not declare is read as a value.
 */
export function valueName(statement: Statement): string | undefined {
  const bound = boundName(statement);
  return bound === undefined || bound[1] === 'type' ? undefined : bound[0];
}

/** The name an enum, a namespace or an alias gives, and what it is there. */
function boundName(statement: Statement): readonly [string, Meaning] | undefined {
  if (isEnumDeclaration(statement)) return [statement.name.text, 'value'];
  if (isModuleDeclaration(statement)) {
    return isIdentifier(statement.name)
      ? [statement.name.text, instantiated(statement) ? 'value' : 'type']
      : undefined;
  }
  return isImportEqualsDeclaration(statement)
    ? [statement.name.text, aliasMeaning(statement)]
    : undefined;
}

/**
 * Whether a namespace holds a value: one of interfaces, type aliases, namespaces of those and
 * `import … =` aliases that are not exported, alone, or of nothing, is erased with the types, and a
 * bare reference passes it to the name around it.
 */
export function instantiated(namespace: ModuleDeclaration): boolean {
  let { body } = namespace;
  while (body !== undefined && isModuleDeclaration(body)) {
    ({ body } = body);
  }
  if (body === undefined) return true;
  return (
    !isModuleBlock(body) ||
    body.statements.some((statement) => {
      return !(
        isInterfaceDeclaration(statement) ||
        isTypeAliasDeclaration(statement) ||
        (isImportEqualsDeclaration(statement) && !isExported(statement)) ||
        (isModuleDeclaration(statement) && !instantiated(statement))
      );
    })
  );
}

/** Whether an `import … =` alias is exported, which makes it a member of the namespace. */
function isExported(alias: ImportEqualsDeclaration): boolean {
  return alias.modifiers?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword) === true;
}

/**
 * What the alias `import X = Q` is. A name `Q` that a variable, a function, a class, an enum or a
 * namespace of values gives, or a module the code requires, is a value; an interface, a type alias
 * or a namespace of types alone is a type, which a bare reference passes by to the name around it.
 * What the file does not declare — an import, a global — is unknown, as is an enum member:
 * TypeScript emits no member for an exported alias of one, so what a bare name reaches is not what
 * the alias says. Each is told once (`MEANINGS`).
 */
export function aliasMeaning(alias: ImportEqualsDeclaration): Meaning {
  let meaning = MEANINGS.get(alias);
  if (meaning === undefined) {
    meaning = meaningOf(alias, []);
    MEANINGS.set(alias, meaning);
  }
  return meaning;
}

/** What `alias` is, `following` the aliases on the way to it: one of them again is unknown. */
function meaningOf(alias: ImportEqualsDeclaration, following: readonly Statement[]): Meaning {
  if (alias.isTypeOnly) return 'type';
  if (isExternalModuleReference(alias.moduleReference)) return 'value';
  const targets = entityTargets(alias.moduleReference, alias, [...following, alias]);
  const meanings = targets?.map((target) => meaningOfTarget(target, [...following, alias]));
  if (meanings === undefined || meanings.length === 0) return 'unknown';
  if (meanings.includes('value')) return 'value';
  return meanings.includes('unknown') ? 'unknown' : 'type';
}

/** What a declaration that an alias names gives. */
function meaningOfTarget(target: Statement, following: readonly Statement[]): Meaning {
  if (isImportEqualsDeclaration(target)) {
    return following.includes(target) ? 'unknown' : meaningOf(target, following);
  }
  if (isInterfaceDeclaration(target) || isTypeAliasDeclaration(target)) return 'type';
  if (isModuleDeclaration(target)) return instantiated(target) ? 'value' : 'type';
  const known =
    isVariableStatement(target) ||
    isFunctionDeclaration(target) ||
    isClassDeclaration(target) ||
    isEnumDeclaration(target);
  return known ? 'value' : 'unknown';
}

/**
 * The declarations the entity name of an alias names, the last of its parts among what the one
 * before exports; none where the file does not tell.
 */
function entityTargets(
  name: EntityName,
  alias: ImportEqualsDeclaration,
  following: readonly Statement[],
): readonly Statement[] | undefined {
  const parts: { readonly text: string }[] = [];
  let at = name;
  while (isQualifiedName(at)) {
    parts.unshift(at.right);
    at = at.left;
  }
  parts.unshift(at);
  let targets = lexicalDeclarations(alias, parts[0]?.text ?? '');
  for (const [index, part] of parts.entries()) {
    if (index === 0) continue;
    if (targets === undefined) return undefined;
    const namespaces = namespacesOf(targets, following);
    if (namespaces === undefined) return undefined;
    const members = namespaces.flatMap((each) => exposedContents(each));
    targets = members.filter(
      (member) =>
        declaresName(member, part.text) && (index === parts.length - 1 || isNamespaceLike(member)),
    );
  }
  return targets;
}

/**
 * The namespaces that `targets` are, through the aliases among them; none if one is not known. The
 * declarations beside a namespace that merge with it, a class or a function, have none of their own.
 */
function namespacesOf(
  targets: readonly Statement[],
  following: readonly Statement[],
): readonly ModuleDeclaration[] | undefined {
  const namespaces: ModuleDeclaration[] = [];
  for (const target of targets) {
    if (isModuleDeclaration(target)) {
      namespaces.push(target);
    } else if (isImportEqualsDeclaration(target) && !following.includes(target)) {
      if (target.isTypeOnly || isExternalModuleReference(target.moduleReference)) return undefined;
      const behind = entityTargets(target.moduleReference, target, [...following, target]);
      const inner = behind === undefined ? undefined : namespacesOf(behind, [...following, target]);
      if (inner === undefined) return undefined;
      namespaces.push(...inner);
    } else if (isImportEqualsDeclaration(target) || isImportDeclaration(target)) {
      return undefined;
    }
    // A class, a function, an enum or a type that a namespace merges with has no namespace to add.
  }
  return namespaces;
}

/**
 * The declarations of `name` in the nearest scope around `from` that has a namespace, an enum, an
 * alias or an import of it, among what the scope holds and the other bodies of its namespace
 * export: all of them, a class or a function that a namespace merges with too.
 */
function lexicalDeclarations(from: Node, name: string): readonly Statement[] | undefined {
  let within: Node = from;
  for (let at: Node = from.parent; ; within = at, at = at.parent) {
    let statements: readonly Statement[] | undefined;
    if (isModuleBlock(at)) statements = bodyStatements(at);
    else if (isModuleDeclaration(at)) {
      statements = isModuleDeclaration(within)
        ? mergedDeclarations(at).flatMap((each) => exposedContents(each))
        : undefined;
    } else statements = statementsOf(at);
    const found = statements?.filter(
      (statement) => statement !== from && declaresName(statement, name),
    );
    if (found?.some((statement) => isNamespaceLike(statement)) === true) return found;
    if (isSourceFile(at)) return undefined;
  }
}

/** Whether a statement declares `name`, whatever it is. */
function declaresName(statement: Statement, name: string): boolean {
  if (isVariableStatement(statement)) {
    return statement.declarationList.declarations.some((declaration) =>
      bindingIdentifiers(declaration.name).some((bound) => bound.text === name),
    );
  }
  if (isImportDeclaration(statement)) {
    const clause = statement.importClause;
    const named = clause?.namedBindings;
    return (
      clause?.name?.text === name ||
      (named !== undefined &&
        (isNamespaceImport(named)
          ? named.name.text === name
          : named.elements.some((each) => each.name.text === name)))
    );
  }
  if (isModuleDeclaration(statement)) {
    return isIdentifier(statement.name) && statement.name.text === name;
  }
  return (
    (isFunctionDeclaration(statement) ||
      isClassDeclaration(statement) ||
      isEnumDeclaration(statement) ||
      isInterfaceDeclaration(statement) ||
      isTypeAliasDeclaration(statement) ||
      isImportEqualsDeclaration(statement)) &&
    statement.name?.text === name
  );
}

/** Whether a declaration can have members to name: a namespace, an enum, an alias or an import. */
function isNamespaceLike(statement: Statement): boolean {
  return (
    isModuleDeclaration(statement) ||
    isEnumDeclaration(statement) ||
    isImportEqualsDeclaration(statement) ||
    isImportDeclaration(statement)
  );
}

/**
 * Whether a statement of a namespace's body, or of a file's, is erased with no export: `declare`,
 * which a body that is not ambient itself may carry on a statement of its own, binds no value that
 * the code of the body could read, so that a bare reference passes it to the name around it.
 */
export function erased(statement: Statement): boolean {
  const { modifiers } = statement as { readonly modifiers?: readonly Node[] };
  return (
    isModuleBlock(statement.parent) &&
    modifiers?.some((modifier) => modifier.kind === SyntaxKind.DeclareKeyword) === true &&
    modifiers.every((modifier) => modifier.kind !== SyntaxKind.ExportKeyword)
  );
}
