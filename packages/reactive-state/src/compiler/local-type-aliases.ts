import {
  type BindingName,
  type ClassDeclaration,
  type ClassExpression,
  type Identifier,
  type ImportDeclaration,
  type InterfaceDeclaration,
  isBlock,
  isCaseBlock,
  isCatchClause,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isConditionalTypeNode,
  isDecorator,
  isEnumDeclaration,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isInferTypeNode,
  isInterfaceDeclaration,
  isModuleBlock,
  isModuleDeclaration,
  isNamespaceImport,
  isParameterDeclaration,
  isSourceFile,
  isTypeAliasDeclaration,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  type Node,
  NodeFlags,
  type Statement,
  type TypeAliasDeclaration,
  type TypeNode,
  type TypeParameterDeclaration,
  type VariableDeclaration,
  isSignatureDeclaration,
} from 'typescript/ast';

import { namespaceStatements } from './local-type-namespaces.ts';
import { bindingIdentifiers, hoistedIn } from './scope.ts';

/** Local type declarations a reference names, with each nearer binding taking precedence. */

export type LocalTypeBinding =
  | TypeAliasDeclaration
  | InterfaceDeclaration
  | TypeParameterDeclaration
  | ClassDeclaration
  | ClassExpression
  | null
  | undefined;

/**
 * The nearest local alias, interface, type parameter or class of `name`: `undefined` for no binding,
 * `null` for an import or enum, whose name cannot be read as an outer alias or a built-in.
 */
export function localTypeBinding(name: Identifier): LocalTypeBinding {
  let within: Node = name;
  let inParameterDecorator = false;
  for (let at: Node = name.parent; ; within = at, at = at.parent) {
    const own = ownTypeBinding(at, within, name.text, inParameterDecorator);
    if (own !== undefined) {
      return own;
    }
    const statements = statementsOf(at);
    const declaration = statements === undefined ? undefined : typeBindingIn(statements, name.text);
    if (declaration !== undefined) {
      return declaration;
    }
    if (isSourceFile(at)) {
      return undefined;
    }
    inParameterDecorator = isParameterDeclaration(at) && isDecorator(within);
  }
}

/** The type binding in one scope, retaining a class merged with an interface of its name. */
function typeBindingIn(statements: readonly Statement[], name: string): LocalTypeBinding {
  const declaration = statements.find((statement) => bindsType(statement, name));
  if (declaration === undefined) {
    return undefined;
  }
  if (isTypeAliasDeclaration(declaration) || isClassDeclaration(declaration)) {
    return declaration;
  }
  if (!isInterfaceDeclaration(declaration)) {
    return null;
  }
  return (
    statements.find(
      (statement): statement is ClassDeclaration =>
        isClassDeclaration(statement) && statement.name?.text === name,
    ) ?? declaration
  );
}

/** The written class or interface bases belonging to one type or constructor reference. */
export function mergedHeritageDeclarations(
  declaration: ClassDeclaration | ClassExpression | InterfaceDeclaration,
  typeReference: boolean,
): readonly (ClassDeclaration | ClassExpression | InterfaceDeclaration)[] {
  if (isClassExpression(declaration) || (!typeReference && isClassDeclaration(declaration))) {
    return [declaration];
  }
  const interfaces = mergedInterfaceDeclarations(declaration);
  return isInterfaceDeclaration(declaration) ? interfaces : [declaration, ...interfaces];
}

/** The interfaces merged with a type declaration in its own scope and exported namespace bodies. */
function mergedInterfaceDeclarations(
  declaration: InterfaceDeclaration | ClassDeclaration,
): readonly InterfaceDeclaration[] {
  for (let at = declaration.parent; ; at = at.parent) {
    const statements = statementsOf(at);
    if (statements !== undefined) {
      return statements.filter(
        (statement): statement is InterfaceDeclaration =>
          isInterfaceDeclaration(statement) && statement.name.text === declaration.name?.text,
      );
    }
  }
}

/**
 * The nearest class `name` reads as a runtime value, without type-only declarations hiding it.
 * Other local values return `null`, and only a name with no value binding returns `undefined`.
 */
export function localClassBinding(
  name: Identifier,
): ClassDeclaration | ClassExpression | null | undefined {
  const binding = localClassValueBinding(name);
  return binding !== undefined && binding !== null && isVariableDeclaration(binding)
    ? null
    : binding;
}

/** A lexical class or constant's declaration, with other runtime value bindings kept opaque. */
export function localClassValueBinding(
  name: Identifier,
): ClassDeclaration | ClassExpression | VariableDeclaration | null | undefined {
  let within: Node = name;
  let inParameterDecorator = false;
  for (let at: Node = name.parent; ; within = at, at = at.parent) {
    const own = ownClassBinding(at, within, name.text, inParameterDecorator);
    if (own !== undefined) {
      return own;
    }
    const declaration = statementsOf(at)?.find((statement) => bindsValue(statement, name.text));
    if (declaration !== undefined) {
      return valueBindingIn(declaration, name.text);
    }
    if (isSourceFile(at)) {
      return undefined;
    }
    inParameterDecorator = isParameterDeclaration(at) && isDecorator(within);
  }
}

/** The class or plain constant identifier one statement binds, never a destructuring projection. */
function valueBindingIn(
  statement: Statement,
  name: string,
): ClassDeclaration | VariableDeclaration | null {
  if (isClassDeclaration(statement)) return statement;
  // eslint-disable-next-line no-bitwise -- TypeScript records const declarations in these flags.
  if (!isVariableStatement(statement) || (statement.declarationList.flags & NodeFlags.Const) === 0)
    return null;
  return (
    statement.declarationList.declarations.find(
      (declaration) => isIdentifier(declaration.name) && declaration.name.text === name,
    ) ?? null
  );
}

/** The own class name or other value binding around a runtime expression. */
function ownClassBinding(
  node: Node,
  within: Node,
  name: string,
  inParameterDecorator: boolean,
): ClassExpression | null | undefined {
  if (isClassExpression(node) && node.name?.text === name) {
    return node;
  }
  if (isFunctionExpression(node) && node.name?.text === name) {
    return null;
  }
  if (inParameterDecorator || isComputedPropertyName(within) || isDecorator(within)) {
    return undefined;
  }
  const parameters = isSignatureDeclaration(node) ? node.parameters : undefined;
  if (parameters?.some((parameter) => bindingNames(parameter.name, name)) === true) {
    return null;
  }
  return bindsScopedValue(node, within, name) ? null : undefined;
}

/**
 * Whether a catch, loop or function body declares a value binding of `name` — or the module, by a
 * `var` of one of its blocks, which is the module's as a function's are the function's. A
 * namespace's `var`s are its own.
 */
function bindsScopedValue(node: Node, within: Node, name: string): boolean {
  if (isSourceFile(node)) {
    const code = node.statements.filter((statement) => !isModuleDeclaration(statement));
    return hoistedIn(code).some((declaration) => bindingNames(declaration.name, name));
  }
  if (isCatchClause(node)) {
    return (
      node.variableDeclaration !== undefined && bindingNames(node.variableDeclaration.name, name)
    );
  }
  if (isForStatement(node) || isForInStatement(node) || isForOfStatement(node)) {
    const { initializer } = node;
    if (
      initializer !== undefined &&
      isVariableDeclarationList(initializer) &&
      initializer.declarations.some((declaration) => bindingNames(declaration.name, name))
    ) {
      return true;
    }
  }
  return (
    'body' in node &&
    node.body === within &&
    hoistedIn([within]).some((declaration) => bindingNames(declaration.name, name))
  );
}

/** Whether `statement` declares or imports a value of `name`, even if its shape is unknown. */
function bindsValue(statement: Statement, name: string): boolean {
  if (isVariableStatement(statement)) {
    return statement.declarationList.declarations.some((declaration) =>
      bindingNames(declaration.name, name),
    );
  }
  if (isImportDeclaration(statement)) {
    return importBinds(statement, name);
  }
  if (isImportEqualsDeclaration(statement)) {
    return statement.name.text === name;
  }
  if (isModuleDeclaration(statement)) {
    return isIdentifier(statement.name) && statement.name.text === name;
  }
  return (
    (isClassDeclaration(statement) ||
      isFunctionDeclaration(statement) ||
      isEnumDeclaration(statement)) &&
    statement.name?.text === name
  );
}

/** Whether a name or destructuring pattern declares `name`. */
function bindingNames(binding: BindingName, name: string): boolean {
  return bindingIdentifiers(binding).some((identifier) => identifier.text === name);
}

/** The declarations of one lexical scope, with a switch's clauses sharing one scope. */
function statementsOf(node: Node): readonly Statement[] | undefined {
  if (isCaseBlock(node)) {
    return node.clauses.flatMap((clause) => clause.statements);
  }
  if (isModuleBlock(node)) {
    return namespaceStatements(node);
  }
  return isBlock(node) || isSourceFile(node) ? node.statements : undefined;
}

/**
 * The class name or type parameter `node` binds. A class expression's name includes its decorator;
 * member type parameters exclude computed names, member decorators and parameter decorators.
 */
function ownTypeBinding(
  node: Node,
  within: Node,
  name: string,
  inParameterDecorator: boolean,
): TypeParameterDeclaration | ClassExpression | undefined {
  if (isClassExpression(node) && node.name?.text === name) {
    return node;
  }
  if (isConditionalTypeNode(node) && node.trueType === within) {
    return inferredTypeBinding(node.extendsType, name);
  }
  if (inParameterDecorator || isComputedPropertyName(within) || isDecorator(within)) {
    return undefined;
  }
  const parameters =
    'typeParameters' in node
      ? (node.typeParameters as readonly TypeParameterDeclaration[] | undefined)
      : undefined;
  return parameters?.find((parameter) => parameter.name.text === name);
}

/** An inferred parameter of this condition, excluding another condition's extends pattern. */
function inferredTypeBinding(type: TypeNode, name: string): TypeParameterDeclaration | undefined {
  const pending: Node[] = [type];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (isInferTypeNode(at) && at.typeParameter.name.text === name) {
      return at.typeParameter;
    }
    if (isConditionalTypeNode(at)) {
      pending.push(at.checkType, at.trueType, at.falseType);
      continue;
    }
    at.forEachChild((child) => {
      pending.push(child);
    });
  }
  return undefined;
}

/** Whether `statement` binds `name` as a type, however its declaration binds it. */
function bindsType(statement: Statement, name: string): boolean {
  if (isImportDeclaration(statement)) {
    return importBinds(statement, name);
  }
  if (isImportEqualsDeclaration(statement)) {
    return statement.name.text === name;
  }
  return (
    (isTypeAliasDeclaration(statement) ||
      isClassDeclaration(statement) ||
      isInterfaceDeclaration(statement) ||
      isEnumDeclaration(statement)) &&
    statement.name?.text === name
  );
}

/** Whether `statement` imports a local type name, by default, by name or as a namespace. */
function importBinds(statement: ImportDeclaration, name: string): boolean {
  const clause = statement.importClause;
  if (clause?.name?.text === name) {
    return true;
  }
  const named = clause?.namedBindings;
  return (
    named !== undefined &&
    (isNamespaceImport(named)
      ? named.name.text === name
      : named.elements.some((element) => element.name.text === name))
  );
}
