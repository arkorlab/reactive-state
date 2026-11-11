import {
  type BindingElement,
  type ClassDeclaration,
  type EnumDeclaration,
  type EnumMember,
  type Expression,
  type Identifier,
  type ImportEqualsDeclaration,
  type FunctionDeclaration,
  isArrayBindingPattern,
  isBindingElement,
  isBlock,
  isCallExpression,
  isCaseBlock,
  isCaseClause,
  isCatchClause,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isDefaultClause,
  isElementAccessExpression,
  isEnumDeclaration,
  isIdentifier,
  isFunctionDeclaration,
  isFunctionExpression,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isImportEqualsDeclaration,
  isInterfaceDeclaration,
  isModuleBlock,
  isModuleDeclaration,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectBindingPattern,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isSourceFile,
  isStringLiteral,
  isTypeAliasDeclaration,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  type Node,
  NodeFlags,
  type ParameterDeclaration,
  type Statement,
  type TypeNode,
  type VariableDeclaration,
  isSignatureDeclaration,
  type ModuleDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { namespaceStatements } from './local-type-namespaces.ts';
import { constantValue } from './numbers.ts';
import { bindingIdentifiers, hoistedIn, isBlockScoped } from './scope.ts';

/** Written binding paths and constant keys, keeping the scope of each original syntax node. */

export type FrameBinding = ParameterDeclaration | VariableDeclaration;
export type FrameDeclaration = FrameBinding | FunctionDeclaration | ClassDeclaration;

export interface FrameSelection {
  readonly binding: FrameBinding;
  readonly keys: readonly string[];
}

export interface FrameTypeSelection {
  readonly type: TypeNode;
  readonly keys: readonly string[];
}

const RESOLVING_KEYS = new WeakSet<Node>();

/** The vars each function body, static block or source file holds, by the node that holds them. */
const HOISTED = new WeakMap<Node, readonly VariableDeclaration[]>();

/** The names of the members of each enum and of those merged with it (`hasEnumMember`), by the enum. */
const MEMBERS = new WeakMap<EnumDeclaration, ReadonlySet<string>>();

/** The names the namespaces that merge with a namespace export (`exportedElsewhere`), by it. */
const EXPORTED = new WeakMap<ModuleDeclaration, ReadonlySet<string>>();

/** What each block's statements declare (`declaredBy`), by the node that holds them. */
const DECLARED = new WeakMap<Node, ReadonlyMap<string, FrameDeclaration | null>>();

/** The stable member name recorded after a framed read is classified, including coercion calls. */
export function framedInputName(node: Node): string {
  return (
    frameMemberName(node) ??
    (isCallExpression(node) ? frameMemberName(unwrapped(node.expression)) : undefined) ??
    'toString'
  );
}

/** The written, immutable name of a member or a destructured object field. */
export function frameMemberName(node: Node): string | undefined {
  if (isPropertyAccessExpression(node)) return node.name.text;
  if (isElementAccessExpression(node)) return constantKey(node.argumentExpression);
  if (!isBindingElement(node) || !isObjectBindingPattern(node.parent)) return undefined;
  const name = node.propertyName ?? node.name;
  if (name === undefined) return undefined;
  if (isIdentifier(name)) return name.text;
  if (isComputedPropertyName(name)) return constantKey(name.expression);
  return isStringLiteral(name) || isNoSubstitutionTemplateLiteral(name) || isNumericLiteral(name)
    ? constantKey(name)
    : undefined;
}

/** The parameter or variable nearest a read, including names taken apart by a binding pattern. */
export function frameBindingOf(name: Identifier): FrameSelection | undefined {
  const binding = frameDeclarationOf(name);
  return binding !== undefined &&
    (isParameterDeclaration(binding) || isVariableDeclaration(binding))
    ? selectedBinding(binding, name.text)
    : undefined;
}

/**
 * The nearest written value declaration, with unsupported own expression names, and the enums,
 * namespaces and import aliases of a scope, kept opaque.
 */
export function frameDeclarationOf(name: Identifier): FrameDeclaration | undefined {
  let within: Node = name;
  for (let at: Node = name.parent; ; within = at, at = at.parent) {
    const binding = localBinding(at, within, name.text);
    if (binding === null) return undefined;
    if (binding !== undefined) return binding;
    if (isSourceFile(at)) return undefined;
  }
}

/** The container a binding element selects from, before it reads its own final member. */
export function frameBindingContainer(element: BindingElement): FrameSelection | undefined {
  const selected = elementSelection(element);
  return selected === undefined ? undefined : { ...selected, keys: selected.keys.slice(0, -1) };
}

/** The written type of an expression, selecting members after following lexical variable aliases. */
export function frameTypeOf(node: Expression): FrameTypeSelection | undefined {
  let value = unwrapped(node);
  let keys: readonly string[] = [];
  const seen = new Set<FrameBinding>();
  for (;;) {
    if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
      const key = frameMemberName(value);
      if (key === undefined) return undefined;
      keys = [key, ...keys];
      value = unwrapped(value.expression);
      continue;
    }
    if (!isIdentifier(value)) return undefined;
    const selected = frameBindingOf(value);
    if (selected === undefined || seen.has(selected.binding)) return undefined;
    const { binding } = selected;
    seen.add(binding);
    keys = [...selected.keys, ...keys];
    if (binding.type !== undefined) return { keys, type: binding.type };
    if (binding.initializer === undefined) return undefined;
    value = unwrapped(binding.initializer);
  }
}

/** A constant key follows only const variables, with parameter and block shadows left intact. */
function constantKey(node: Expression): string | undefined {
  if (RESOLVING_KEYS.has(node)) return undefined;
  RESOLVING_KEYS.add(node);
  try {
    return resolvedKey(node);
  } finally {
    RESOLVING_KEYS.delete(node);
  }
}

/** A key's constant syntax, with re-entry through computed binding patterns cut above. */
function resolvedKey(node: Expression): string | undefined {
  const value = constantValue(node, (name) => {
    const selected = frameBindingOf(name);
    if (selected === undefined) return;
    if (selected.keys.length > 0) return;
    const { binding } = selected;
    if (!isVariableDeclaration(binding) || !isVariableDeclarationList(binding.parent)) return;
    const statement = binding.parent.parent;
    return isVariableStatement(statement) &&
      /^const\s/u.test(binding.parent.getText(binding.getSourceFile()))
      ? binding.initializer
      : undefined;
  });
  return value === undefined ? undefined : String(value);
}

/** A scope's direct written binding, with parameters checked where their function is reached. */
function localBinding(node: Node, within: Node, name: string): FrameDeclaration | null | undefined {
  const loop = loopBinding(node, name);
  if (loop !== undefined) return loop;
  if (isEnumDeclaration(node) && hasEnumMember(node, name)) return null;
  if (
    isCatchClause(node) &&
    node.variableDeclaration !== undefined &&
    bindingIdentifiers(node.variableDeclaration.name).some((bound) => bound.text === name)
  )
    return node.variableDeclaration;
  const binding = statementBinding(node, name);
  if (binding !== undefined) return binding;
  const parameters = isSignatureDeclaration(node) ? node.parameters : undefined;
  const declared =
    parameters?.find((parameter) =>
      bindingIdentifiers(parameter.name).some((bound) => bound.text === name),
    ) ?? hoistedBinding(node, within, name);
  if (declared !== undefined) return declared;
  if (isModuleDeclaration(node) && exportedElsewhere(node, within, name)) {
    return null;
  }
  return (isFunctionExpression(node) || isClassExpression(node)) && node.name?.text === name
    ? null
    : undefined;
}

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
  const merging = isModuleBlock(scope) && seenElsewhere(enumeration);
  const statements = merging ? namespaceStatements(scope) : statementsOf(scope);
  return (statements ?? [enumeration]).flatMap((statement) => {
    return isEnumDeclaration(statement) && statement.name.text === enumeration.name.text
      ? [statement]
      : [];
  });
}

/** Whether the other bodies of a namespace see an enum: it is exported, or ambient, where all are. */
function seenElsewhere(enumeration: EnumDeclaration): boolean {
  return (
    enumeration.modifiers?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword) ===
      true ||
    // eslint-disable-next-line no-bitwise -- TypeScript says a declaration is ambient in these flags alone.
    (enumeration.flags & NodeFlags.Ambient) !== 0
  );
}

/**
 * Whether the namespaces that merge with `namespace`, its other declarations, export `name` as a
 * value — as a variable, a function, a class, an enum or a namespace of a value, or as a dotted
 * namespace's own name, `B` of `namespace A.B`: they merge with its own, so that a bare `name`
 * within its body is `N.name`, before any binding around it. The names are gathered once
 * (`EXPORTED`), for every name looked up in the namespace.
 */
export function exportedElsewhere(
  namespace: ModuleDeclaration,
  within: Node,
  name: string,
): boolean {
  // Of what is within its body, a block or the dotted namespace that is it, and nothing beside.
  if (!isModuleBlock(within) && !isModuleDeclaration(within)) return false;
  let names = EXPORTED.get(namespace);
  if (names === undefined) {
    names = new Set(
      mergedDeclarations(namespace).flatMap((each) =>
        exposedContents(each).flatMap((statement) => valueNames(statement)),
      ),
    );
    EXPORTED.set(namespace, names);
  }
  return names.has(name);
}

/**
 * The declarations that merge with `namespace`, itself among them: those of its name among what
 * its scope holds (`namespaceStatements`) and, for the inner part of a dotted namespace, among what
 * the declarations that merge with its outer part expose.
 */
function mergedDeclarations(namespace: ModuleDeclaration): readonly ModuleDeclaration[] {
  const { name, parent } = namespace;
  if (!isIdentifier(name)) return [namespace];
  let among: readonly Statement[];
  if (isModuleDeclaration(parent)) {
    among = mergedDeclarations(parent).flatMap((each) => exposedContents(each));
  } else if (isModuleBlock(parent)) {
    among = namespaceStatements(parent);
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

/** Whether a statement of a namespace's body is exported, or is ambient, where all but imports are. */
function exposed(statement: Statement): boolean {
  const { modifiers } = statement as { readonly modifiers?: readonly Node[] };
  return (
    modifiers?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword) === true ||
    // eslint-disable-next-line no-bitwise -- TypeScript says a declaration is ambient in these flags alone.
    ((statement.flags & NodeFlags.Ambient) !== 0 && !isImportEqualsDeclaration(statement))
  );
}

/** The names of the values a statement declares: variables, functions, classes, enums, namespaces. */
function valueNames(statement: Statement): readonly string[] {
  if (isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      bindingIdentifiers(declaration.name).map((bound) => bound.text),
    );
  }
  if (isFunctionDeclaration(statement) || isClassDeclaration(statement)) {
    return statement.name === undefined ? [] : [statement.name.text];
  }
  const name = valueName(statement);
  return name === undefined ? [] : [name];
}

/** Ordinary and namespace blocks keep their statements; a switch's clauses share one scope. */
function statementsOf(node: Node): readonly Statement[] | undefined {
  if (isCaseBlock(node)) return node.clauses.flatMap((clause) => clause.statements);
  return isBlock(node) || isModuleBlock(node) || isSourceFile(node) ? node.statements : undefined;
}

/**
 * A function, static block or source file owns its nested vars; nested functions and classes do
 * not. Each scope's are gathered once (`HOISTED`), for every name looked up in it.
 */
function hoistedBinding(node: Node, within: Node, name: string): FrameBinding | undefined {
  let root: Node;
  if (isSourceFile(node)) root = node;
  else if ('body' in node && node.body === within) root = within;
  else return undefined;
  let declarations = HOISTED.get(root);
  if (declarations === undefined) {
    declarations = hoistedIn(isSourceFile(root) ? root.statements : [root]).filter(
      (declaration) => !ownedByNamespace(declaration, root),
    );
    HOISTED.set(root, declarations);
  }
  return declarations.find((declaration) =>
    bindingIdentifiers(declaration.name).some((bound) => bound.text === name),
  );
}

/** Whether a namespace within `root` holds the var: a namespace's own vars are those of its body. */
function ownedByNamespace(declaration: VariableDeclaration, root: Node): boolean {
  for (let at = declaration.parent; at !== root; at = at.parent) {
    if (isModuleDeclaration(at)) return true;
  }
  return false;
}

/** A block-scoped loop header binding shadows outer names throughout its body. */
function loopBinding(node: Node, name: string): FrameBinding | undefined {
  if (!isForStatement(node) && !isForOfStatement(node) && !isForInStatement(node)) return undefined;
  const list = node.initializer;
  return list !== undefined && isVariableDeclarationList(list) && isBlockScoped(list)
    ? list.declarations.find((declaration) =>
        bindingIdentifiers(declaration.name).some((bound) => bound.text === name),
      )
    : undefined;
}

/**
 * The variable a block declares, with named functions and classes stopping outer lookup: the first
 * of its statements to declare the name, or `null` where an enum, a namespace or an import alias
 * does, which stops it with no declaration to answer. Each block's are gathered once (`DECLARED`),
 * for every name looked up in it.
 */
function statementBinding(node: Node, name: string): FrameDeclaration | null | undefined {
  let declared = DECLARED.get(node);
  if (declared === undefined) {
    declared = declaredBy(statementsOf(node) ?? []);
    DECLARED.set(node, declared);
  }
  return declared.get(name);
}

/**
 * The functions, classes and block-scoped variables statements declare, the first of each name; and
 * `null` for each name an enum, a namespace or an import alias gives a value (`valueName`), whose
 * declaration no caller follows, but which an outer binding of the name does not reach.
 */
function declaredBy(
  statements: readonly Statement[],
): ReadonlyMap<string, FrameDeclaration | null> {
  const declared = new Map<string, FrameDeclaration | null>();
  const add = (name: string, declaration: FrameDeclaration | null): void => {
    if (!declared.has(name)) declared.set(name, declaration);
  };
  for (const statement of statements) {
    if (isFunctionDeclaration(statement) || isClassDeclaration(statement)) {
      if (statement.name !== undefined) add(statement.name.text, statement);
      continue;
    }
    const opaque = valueName(statement);
    if (opaque !== undefined) {
      add(opaque, null);
      continue;
    }
    if (!isVariableStatement(statement) || !isBlockScoped(statement.declarationList)) continue;
    for (const declaration of statement.declarationList.declarations) {
      for (const bound of bindingIdentifiers(declaration.name)) add(bound.text, declaration);
    }
  }
  return declared;
}

/**
 * The name an enum, a namespace or an `import … =` alias of a value gives; none of another
 * statement, of a module the code names by text (`declare module 'x'`), of a namespace of types
 * alone, or of an alias of a type.
 */
function valueName(statement: Statement): string | undefined {
  if (isEnumDeclaration(statement)) return statement.name.text;
  if (isModuleDeclaration(statement)) {
    return isIdentifier(statement.name) && instantiated(statement)
      ? statement.name.text
      : undefined;
  }
  return isImportEqualsDeclaration(statement) && !statement.isTypeOnly
    ? statement.name.text
    : undefined;
}

/**
 * Whether a namespace holds a value: one of interfaces, type aliases, namespaces of those and
 * `import … =` aliases that are not exported, alone, or of nothing, is erased with the types, and a
 * bare reference passes it to the name around it.
 */
function instantiated(namespace: ModuleDeclaration): boolean {
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

/** A declaration's binding path for one of the identifiers it binds. */
function selectedBinding(binding: FrameBinding, name: string): FrameSelection | undefined {
  if (isIdentifier(binding.name)) return { binding, keys: [] };
  const identifier = bindingIdentifiers(binding.name).find((bound) => bound.text === name);
  return identifier !== undefined && isBindingElement(identifier.parent)
    ? elementSelection(identifier.parent)
    : undefined;
}

/** The literal object and tuple keys from a binding's declared whole to one selected field. */
function elementSelection(element: BindingElement): FrameSelection | undefined {
  const keys: string[] = [];
  let each = element;
  for (;;) {
    if (each.dotDotDotToken !== undefined) return undefined;
    const pattern = each.parent;
    const key = isArrayBindingPattern(pattern)
      ? String(pattern.elements.indexOf(each))
      : frameMemberName(each);
    if (key === undefined) return undefined;
    keys.unshift(key);
    const owner = pattern.parent;
    if (isParameterDeclaration(owner) || isVariableDeclaration(owner))
      return { binding: owner, keys };
    if (!isBindingElement(owner)) return undefined;
    each = owner;
  }
}
