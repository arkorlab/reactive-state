import {
  type ArrowFunction,
  type BindingName,
  type ClassDeclaration,
  type ClassExpression,
  type ElementAccessExpression,
  type ConstructorDeclaration,
  type FunctionDeclaration,
  type FunctionExpression,
  type GetAccessorDeclaration,
  type Identifier,
  isArrowFunction,
  isAsExpression,
  isBinaryExpression,
  isBlock,
  isCaseBlock,
  isCatchClause,
  isClassDeclaration,
  isClassStaticBlockDeclaration,
  isComputedPropertyName,
  isConstructorDeclaration,
  isDecorator,
  isEnumDeclaration,
  isExpressionWithTypeArguments,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isModuleDeclaration,
  isNonNullExpression,
  isParameterDeclaration,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyDeclaration,
  isSatisfiesExpression,
  isSetAccessorDeclaration,
  isSourceFile,
  isTypeAssertion,
  isVariableDeclarationList,
  type MethodDeclaration,
  type Node,
  type PropertyAccessExpression,
  type SetAccessorDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { bindingIdentifiers, isBlockScoped, isTypeOnly } from './scope.ts';

export type AccessMode = 'read' | 'readwrite' | 'write';

export type CallableNode =
  | ArrowFunction
  | ConstructorDeclaration
  | FunctionDeclaration
  | FunctionExpression
  | GetAccessorDeclaration
  | MethodDeclaration
  | SetAccessorDeclaration;

export type DeferredMember =
  | ConstructorDeclaration
  | GetAccessorDeclaration
  | MethodDeclaration
  | SetAccessorDeclaration;

export type TargetSpec =
  | { readonly kind: 'elements'; readonly source: Node }
  | { readonly key: string | undefined; readonly kind: 'member'; readonly source: Node }
  | { readonly kind: 'value'; readonly node: Node };

export interface Binding {
  escaped: boolean;
  invoked: boolean;
  readonly specs: TargetSpec[];
}

export interface LexicalScope {
  readonly bindings: Map<string, Binding>;
  readonly parent: LexicalScope | undefined;
}

export interface ScopeTable {
  readonly collected: Set<Node>;
  readonly root: Node;
  readonly scopes: Map<Node, LexicalScope>;
}

export function createScopeTable(root: Node): ScopeTable {
  const scopes = new Map<Node, LexicalScope>([[root, { bindings: new Map(), parent: undefined }]]);
  return { collected: new Set(), root, scopes };
}

export function getOrCreateScope(
  node: Node,
  parent: LexicalScope | undefined,
  table: ScopeTable,
): LexicalScope {
  const existing = table.scopes.get(node);
  if (existing !== undefined) {
    return existing;
  }
  const created: LexicalScope = { bindings: new Map(), parent };
  table.scopes.set(node, created);
  return created;
}

export function ensureBinding(scope: LexicalScope, name: string): Binding {
  const existing = scope.bindings.get(name);
  if (existing !== undefined) {
    return existing;
  }
  const created: Binding = { escaped: false, invoked: false, specs: [] };
  scope.bindings.set(name, created);
  return created;
}

export function enclosingScope(node: Node, table: ScopeTable): LexicalScope {
  let previousChild: Node | undefined;
  let child = node;
  while (child !== table.root && !isSourceFile(child)) {
    const current = child.parent;
    if (!evaluatesOutsideNodeScope(child, current, previousChild)) {
      const scope = table.scopes.get(current);
      if (scope !== undefined) {
        return scope;
      }
    }
    previousChild = child;
    child = current;
  }
  return getOrCreateScope(table.root, undefined, table);
}

export function resolveLexicalBinding(
  identifier: Identifier,
  table: ScopeTable,
): Binding | undefined {
  for (
    let scope: LexicalScope | undefined = enclosingScope(identifier, table);
    scope !== undefined;
    scope = scope.parent
  ) {
    const found = scope.bindings.get(identifier.text);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

export function nearestVarScopeNode(node: Node, root: Node): Node {
  let child: Node = node;
  while (child !== root && !isSourceFile(child)) {
    const current = child.parent;
    if (
      isBlock(child) &&
      (isCallableNode(current) || isClassStaticBlockDeclaration(current)) &&
      current.body === child
    ) {
      return child;
    }
    if (isModuleDeclaration(current)) {
      return current;
    }
    child = current;
  }
  return root;
}

export function childContainerScope(
  node: Node,
  outerScope: LexicalScope,
  table: ScopeTable,
): LexicalScope {
  if (isEnumDeclaration(node)) {
    const enumScope = getOrCreateScope(node, outerScope, table);
    for (const member of node.members) {
      if (isIdentifier(member.name)) {
        ensureBinding(enumScope, member.name.text);
      }
    }
    return enumScope;
  }
  if (isBlock(node) || isCaseBlock(node) || isModuleDeclaration(node) || isCatchClause(node)) {
    return getOrCreateScope(node, outerScope, table);
  }
  if (
    (isForStatement(node) || isForInStatement(node) || isForOfStatement(node)) &&
    node.initializer !== undefined &&
    isVariableDeclarationList(node.initializer) &&
    isBlockScoped(node.initializer)
  ) {
    return getOrCreateScope(node, outerScope, table);
  }
  return outerScope;
}

export function resetPatternBindings(name: BindingName, scope: LexicalScope): void {
  for (const bound of bindingIdentifiers(name)) {
    scope.bindings.set(bound.text, { escaped: false, invoked: false, specs: [] });
  }
}

export function seedVarFromParentParameters(name: BindingName, varScope: LexicalScope): void {
  const paramScope = varScope.parent;
  if (paramScope === undefined) {
    return;
  }
  for (const bound of bindingIdentifiers(name)) {
    if (!varScope.bindings.has(bound.text)) {
      const inherited = paramScope.bindings.get(bound.text);
      const created = ensureBinding(varScope, bound.text);
      if (inherited !== undefined) {
        created.specs.push(...inherited.specs);
      }
    }
  }
}

export function recordClassOrNamespaceDeclaration(node: Node, outerScope: LexicalScope): void {
  if (isClassDeclaration(node) && node.name !== undefined) {
    ensureBinding(outerScope, node.name.text).specs.push({ kind: 'value', node });
  } else if (isEnumDeclaration(node) || (isModuleDeclaration(node) && isIdentifier(node.name))) {
    ensureBinding(outerScope, node.name.text);
  }
}

export function unwrapExpression(node: Node): Node {
  let current = node;
  while (
    isParenthesizedExpression(current) ||
    isAsExpression(current) ||
    isSatisfiesExpression(current) ||
    isNonNullExpression(current) ||
    isTypeAssertion(current) ||
    isExpressionWithTypeArguments(current)
  ) {
    current = current.expression;
  }
  return current;
}

export function isErasedOrAmbient(node: Node): boolean {
  if (isTypeOnly(node) || hasModifier(node, SyntaxKind.DeclareKeyword)) {
    return true;
  }
  return isPropertyDeclaration(node) && hasModifier(node, SyntaxKind.AbstractKeyword);
}

export function hasModifier(node: Node, kind: SyntaxKind): boolean {
  return (
    (node as { readonly modifiers?: readonly Node[] }).modifiers?.some(
      (each) => each.kind === kind,
    ) === true
  );
}

export function isPassiveDeferredFunction(node: Node): boolean {
  return isFunctionDeclaration(node) || isArrowFunction(node) || isFunctionExpression(node);
}

export function isDeferredMember(node: Node): node is DeferredMember {
  return (
    isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node) ||
    isConstructorDeclaration(node)
  );
}

export function isCallableNode(node: Node): node is CallableNode {
  return isPassiveDeferredFunction(node) || isDeferredMember(node);
}

export function forEachDecorator(
  modifiers: readonly Node[] | undefined,
  visit: (child: Node) => void,
): void {
  if (modifiers === undefined) {
    return;
  }
  for (const modifier of modifiers) {
    if (isDecorator(modifier)) {
      visit(modifier);
    }
  }
}

export function forEachHeaderNode(member: DeferredMember, visit: (child: Node) => void): void {
  forEachDecorator(member.modifiers, visit);
  if (!isConstructorDeclaration(member) && isComputedPropertyName(member.name)) {
    visit(member.name);
  }
  for (const parameter of member.parameters) {
    forEachDecorator(parameter.modifiers, visit);
  }
}

function evaluatesOutsideNodeScope(
  child: Node,
  parent: Node,
  previousChild: Node | undefined,
): boolean {
  if (isDecorator(child)) {
    return true;
  }
  if (previousChild !== undefined && isParameterDeclaration(child) && isDecorator(previousChild)) {
    return true;
  }
  return (
    (isMethodDeclaration(parent) ||
      isGetAccessorDeclaration(parent) ||
      isSetAccessorDeclaration(parent) ||
      isFunctionDeclaration(parent)) &&
    (parent.name as Node | undefined) === child
  );
}

export function accessModeOf(
  access: ElementAccessExpression | PropertyAccessExpression,
): AccessMode {
  let current: Node = access;
  while (isParenthesizedExpression(current.parent)) {
    current = current.parent;
  }
  const { parent } = current;
  if (isBinaryExpression(parent) && parent.left === current) {
    const { kind } = parent.operatorToken;
    if (kind === SyntaxKind.EqualsToken) {
      return 'write';
    }
    if (kind >= SyntaxKind.FirstCompoundAssignment && kind <= SyntaxKind.LastCompoundAssignment) {
      return 'readwrite';
    }
  }
  if (
    (isPrefixUnaryExpression(parent) || isPostfixUnaryExpression(parent)) &&
    (parent.operator === SyntaxKind.PlusPlusToken || parent.operator === SyntaxKind.MinusMinusToken)
  ) {
    return 'readwrite';
  }
  return 'read';
}

export function extendsExpressionOf(cls: ClassDeclaration | ClassExpression): Node | undefined {
  if (cls.heritageClauses === undefined) {
    return undefined;
  }
  for (const clause of cls.heritageClauses) {
    const firstType = clause.token === SyntaxKind.ExtendsKeyword ? clause.types[0] : undefined;
    if (firstType !== undefined && isExpressionWithTypeArguments(firstType)) {
      return firstType.expression;
    }
  }
  return undefined;
}
