import {
  type BindingElement,
  type BindingName,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBindingElement,
  isCatchClause,
  isClassExpression,
  isComputedPropertyName,
  isDecorator,
  isForOfStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isOmittedExpression,
  isParameterDeclaration,
  isPrivateIdentifier,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadElement,
  isStringLiteral,
  isVariableDeclarationList,
  type Node,
  type ObjectLiteralElementLike,
  type PropertyName,
  SyntaxKind,
  type VariableDeclarationList,
} from 'typescript/ast';

import { isBlockScoped } from './scope.ts';
import {
  type Binding,
  type CallableNode,
  childContainerScope,
  enclosingScope,
  ensureBinding,
  forEachHeaderNode,
  getOrCreateScope,
  isCallableNode,
  isDeferredMember,
  isErasedOrAmbient,
  type LexicalScope,
  nearestVarScopeNode,
  recordClassOrNamespaceDeclaration,
  resetPatternBindings,
  resolveLexicalBinding,
  type ScopeTable,
  seedVarFromParentParameters,
  type TargetSpec,
  unwrapExpression,
} from './statement-call-scopes.ts';

interface ScanFrame {
  readonly execRoot: Node;
  readonly onSpecAdded: (binding: Binding, spec: TargetSpec) => void;
  readonly table: ScopeTable;
}

const VALUE_ASSIGNMENT_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

export function collectExecutableRoot(
  execRoot: Node,
  table: ScopeTable,
  onSpecAdded: (binding: Binding, spec: TargetSpec) => void,
): void {
  if (table.collected.has(execRoot)) {
    return;
  }
  table.collected.add(execRoot);
  const startScope =
    execRoot === table.root
      ? getOrCreateScope(table.root, undefined, table)
      : enclosingScope(execRoot, table);
  const frame: ScanFrame = { execRoot, onSpecAdded, table };
  scanDeclarations(execRoot, startScope, frame);
  scanWrites(execRoot, frame);
}

export function staticPropertyNameKey(name: PropertyName, table: ScopeTable): string | undefined {
  if (
    isIdentifier(name) ||
    isPrivateIdentifier(name) ||
    isStringLiteral(name) ||
    isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  if (isNumericLiteral(name)) {
    return String(Number(name.text));
  }
  return isComputedPropertyName(name) ? staticExpressionKey(name.expression, table) : undefined;
}

export function staticExpressionKey(expr: Node, table: ScopeTable): string | undefined {
  const seen = new Set<Binding>();
  let current = unwrapExpression(expr);
  for (;;) {
    if (isStringLiteral(current) || isNoSubstitutionTemplateLiteral(current)) {
      return current.text;
    }
    if (isNumericLiteral(current)) {
      return String(Number(current.text));
    }
    if (!isIdentifier(current)) {
      return undefined;
    }
    const binding = resolveLexicalBinding(current, table);
    const onlySpec = binding?.specs.length === 1 ? binding.specs[0] : undefined;
    if (binding === undefined || onlySpec?.kind !== 'value' || seen.has(binding)) {
      return undefined;
    }
    seen.add(binding);
    current = unwrapExpression(onlySpec.node);
  }
}

export function bindingElementKey(element: BindingElement, table: ScopeTable): string | undefined {
  const keyNode = element.propertyName ?? element.name;
  if (keyNode === undefined) {
    return undefined;
  }
  return isIdentifier(keyNode) ||
    isStringLiteral(keyNode) ||
    isNumericLiteral(keyNode) ||
    isNoSubstitutionTemplateLiteral(keyNode) ||
    isComputedPropertyName(keyNode)
    ? staticPropertyNameKey(keyNode, table)
    : undefined;
}

function scanDeclarations(node: Node, outerScope: LexicalScope, frame: ScanFrame): void {
  if (isErasedOrAmbient(node)) {
    return;
  }
  if (node !== frame.execRoot && isCallableNode(node)) {
    if (isFunctionDeclaration(node) && node.name !== undefined) {
      ensureBinding(outerScope, node.name.text).specs.push({ kind: 'value', node });
    } else if (isDeferredMember(node)) {
      forEachHeaderNode(node, (headerChild) => {
        scanDeclarations(headerChild, outerScope, frame);
      });
    }
    return;
  }
  if (isVariableDeclarationList(node)) {
    registerVariableList(node, outerScope, frame.table);
  } else {
    recordClassOrNamespaceDeclaration(node, outerScope);
  }
  scanScopedChildren(node, outerScope, frame);
}

function scanScopedChildren(node: Node, outerScope: LexicalScope, frame: ScanFrame): void {
  if (isCallableNode(node)) {
    scanFunctionScope(node, outerScope, frame);
    return;
  }
  if (isClassExpression(node)) {
    const clsScope = getOrCreateScope(node, outerScope, frame.table);
    if (node.name !== undefined) {
      ensureBinding(clsScope, node.name.text).specs.push({ kind: 'value', node });
    }
    node.forEachChild((child) => {
      scanDeclarations(child, isDecorator(child) ? outerScope : clsScope, frame);
    });
    return;
  }
  const childScope = childContainerScope(node, outerScope, frame.table);
  if (isCatchClause(node) && node.variableDeclaration !== undefined) {
    bindPatternSpecs(
      node.variableDeclaration.name,
      node.variableDeclaration.initializer,
      childScope,
      frame.table,
    );
  }
  node.forEachChild((child) => {
    scanDeclarations(child, childScope, frame);
  });
}

function scanFunctionScope(fn: CallableNode, outerScope: LexicalScope, frame: ScanFrame): void {
  const fnScope = getOrCreateScope(fn, outerScope, frame.table);
  if (isFunctionExpression(fn) && fn.name !== undefined) {
    ensureBinding(fnScope, fn.name.text).specs.push({ kind: 'value', node: fn });
  }
  for (const parameter of fn.parameters) {
    resetPatternBindings(parameter.name, fnScope);
    bindPatternSpecs(parameter.name, parameter.initializer, fnScope, frame.table);
  }
  const headerName: Node | undefined =
    isMethodDeclaration(fn) || isGetAccessorDeclaration(fn) || isSetAccessorDeclaration(fn)
      ? fn.name
      : undefined;
  fn.forEachChild((child) => {
    if (child === headerName || isDecorator(child)) {
      scanDeclarations(child, outerScope, frame);
    } else if (isParameterDeclaration(child)) {
      child.forEachChild((paramChild) => {
        scanDeclarations(paramChild, isDecorator(paramChild) ? outerScope : fnScope, frame);
      });
    } else {
      scanDeclarations(child, fnScope, frame);
    }
  });
}

function registerVariableList(
  list: VariableDeclarationList,
  outerScope: LexicalScope,
  table: ScopeTable,
): void {
  const varScopeNode = isBlockScoped(list) ? undefined : nearestVarScopeNode(list, table.root);
  const targetScope =
    varScopeNode === undefined ? outerScope : getOrCreateScope(varScopeNode, outerScope, table);
  const loopParent = list.parent;
  for (const declaration of list.declarations) {
    if (varScopeNode !== undefined) {
      seedVarFromParentParameters(declaration.name, targetScope);
    }
    if (isForOfStatement(loopParent)) {
      bindIterablePattern(declaration.name, loopParent.expression, targetScope);
    } else {
      bindPatternSpecs(declaration.name, declaration.initializer, targetScope, table);
    }
  }
}

function bindIterablePattern(name: BindingName, iterable: Node, scope: LexicalScope): void {
  if (isIdentifier(name)) {
    ensureBinding(scope, name.text).specs.push({ kind: 'elements', source: iterable });
    return;
  }
  resetPatternBindings(name, scope);
}

function bindPatternSpecs(
  name: BindingName,
  source: Node | undefined,
  scope: LexicalScope,
  table: ScopeTable,
): void {
  if (isIdentifier(name)) {
    const binding = ensureBinding(scope, name.text);
    if (source !== undefined) {
      binding.specs.push({ kind: 'value', node: source });
    }
    return;
  }
  if (isObjectBindingPattern(name)) {
    for (const element of name.elements) {
      bindObjectElementSpecs(element, source, scope, table);
    }
    return;
  }
  for (const [index, element] of name.elements.entries()) {
    if (!isOmittedExpression(element) && isBindingElement(element)) {
      bindArrayElementSpecs(element, { index, source }, scope, table);
    }
  }
}

function bindObjectElementSpecs(
  element: BindingElement,
  source: Node | undefined,
  scope: LexicalScope,
  table: ScopeTable,
): void {
  if (element.name === undefined) {
    return;
  }
  if (element.dotDotDotToken !== undefined) {
    bindPatternSpecs(element.name, source, scope, table);
    return;
  }
  const key = bindingElementKey(element, table);
  bindSelectedElement(element, { key, source }, scope, table);
}

function bindArrayElementSpecs(
  element: BindingElement,
  slot: { readonly index: number; readonly source: Node | undefined },
  scope: LexicalScope,
  table: ScopeTable,
): void {
  if (element.name === undefined) {
    return;
  }
  if (element.dotDotDotToken !== undefined) {
    bindIterablePattern(element.name, slot.source ?? element, scope);
    return;
  }
  bindSelectedElement(element, { key: String(slot.index), source: slot.source }, scope, table);
}

function bindSelectedElement(
  element: BindingElement,
  selection: { readonly key: string | undefined; readonly source: Node | undefined },
  scope: LexicalScope,
  table: ScopeTable,
): void {
  if (element.name === undefined) {
    return;
  }
  if (!isIdentifier(element.name)) {
    bindPatternSpecs(element.name, element.initializer, scope, table);
    return;
  }
  const binding = ensureBinding(scope, element.name.text);
  if (selection.source !== undefined) {
    binding.specs.push({ key: selection.key, kind: 'member', source: selection.source });
  }
  if (element.initializer !== undefined) {
    binding.specs.push({ kind: 'value', node: element.initializer });
  }
}

function scanWrites(node: Node, frame: ScanFrame): void {
  if (isErasedOrAmbient(node)) {
    return;
  }
  if (node !== frame.execRoot && isCallableNode(node)) {
    if (isDeferredMember(node)) {
      forEachHeaderNode(node, (headerChild) => {
        scanWrites(headerChild, frame);
      });
    }
    return;
  }
  observeWriteNode(node, frame);
  node.forEachChild((child) => {
    scanWrites(child, frame);
  });
}

function observeWriteNode(node: Node, frame: ScanFrame): void {
  if (isBinaryExpression(node) && VALUE_ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)) {
    recordAssignmentWrites(node.left, node.right, frame);
    return;
  }
  if (isForOfStatement(node) && !isVariableDeclarationList(node.initializer)) {
    const target = unwrapExpression(node.initializer);
    if (isIdentifier(target)) {
      appendSpec(target, { kind: 'elements', source: node.expression }, frame);
    }
  }
}

function recordAssignmentWrites(left: Node, right: Node, frame: ScanFrame): void {
  const target = unwrapExpression(left);
  if (isIdentifier(target)) {
    appendSpec(target, { kind: 'value', node: right }, frame);
  } else if (isObjectLiteralExpression(target)) {
    recordObjectAssignmentWrites(target.properties, right, frame);
  } else if (isArrayLiteralExpression(target)) {
    recordArrayAssignmentWrites(target.elements, right, frame);
  }
}

function recordObjectAssignmentWrites(
  properties: readonly ObjectLiteralElementLike[],
  right: Node,
  frame: ScanFrame,
): void {
  for (const property of properties) {
    if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
      appendSpec(property.name, { key: property.name.text, kind: 'member', source: right }, frame);
      if (property.objectAssignmentInitializer !== undefined) {
        appendSpec(
          property.name,
          { kind: 'value', node: property.objectAssignmentInitializer },
          frame,
        );
      }
    } else if (isPropertyAssignment(property)) {
      const key = staticPropertyNameKey(property.name, frame.table);
      recordAssignedMemberSlot(property.initializer, { key, source: right }, frame);
    }
  }
}

function recordArrayAssignmentWrites(
  elements: readonly Node[],
  right: Node,
  frame: ScanFrame,
): void {
  for (const [index, element] of elements.entries()) {
    if (isOmittedExpression(element)) {
      continue;
    }
    if (isSpreadElement(element)) {
      const inner = unwrapExpression(element.expression);
      if (isIdentifier(inner)) {
        appendSpec(inner, { kind: 'elements', source: right }, frame);
      }
      continue;
    }
    recordAssignedMemberSlot(element, { key: String(index), source: right }, frame);
  }
}

function recordAssignedMemberSlot(
  lhs: Node,
  slot: { readonly key: string | undefined; readonly source: Node },
  frame: ScanFrame,
): void {
  const clean = unwrapExpression(lhs);
  if (isIdentifier(clean)) {
    appendSpec(clean, { key: slot.key, kind: 'member', source: slot.source }, frame);
    return;
  }
  if (isBinaryExpression(clean) && clean.operatorToken.kind === SyntaxKind.EqualsToken) {
    const inner = unwrapExpression(clean.left);
    if (isIdentifier(inner)) {
      appendSpec(inner, { key: slot.key, kind: 'member', source: slot.source }, frame);
      appendSpec(inner, { kind: 'value', node: clean.right }, frame);
    }
  }
}

function appendSpec(identifier: Identifier, spec: TargetSpec, frame: ScanFrame): void {
  const binding = resolveLexicalBinding(identifier, frame.table);
  if (binding === undefined) {
    return;
  }
  binding.specs.push(spec);
  frame.onSpecAdded(binding, spec);
}
