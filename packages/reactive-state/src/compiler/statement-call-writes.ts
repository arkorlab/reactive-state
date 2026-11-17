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
  isForInStatement,
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
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPrivateIdentifier,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
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
  unwrapExpression,
  type ValueSpec,
} from './statement-call-scopes.ts';

interface ScanFrame {
  readonly execRoot: Node;
  readonly onSpecAdded: (binding: Binding) => void;
  readonly table: ScopeTable;
}

const VALUE_ASSIGNMENT_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

const UNKNOWN_SPEC: ValueSpec = { kind: 'unknown' };

export function collectExecutableRoot(
  execRoot: Node,
  table: ScopeTable,
  onSpecAdded: (binding: Binding) => void,
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

export function staticPropertyNameKey(
  name: PropertyName,
  table: ScopeTable,
  seenBindings?: Set<Binding>,
): string | undefined {
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
  return isComputedPropertyName(name)
    ? staticExpressionKey(name.expression, table, seenBindings)
    : undefined;
}

export function staticExpressionKey(
  expr: Node,
  table: ScopeTable,
  seenBindings?: Set<Binding>,
): string | undefined {
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
    if (binding !== undefined) {
      seenBindings?.add(binding);
    }
    const onlySpec = binding?.specs.length === 1 ? binding.specs[0] : undefined;
    if (binding === undefined || onlySpec?.kind !== 'value' || seen.has(binding)) {
      return undefined;
    }
    seen.add(binding);
    current = unwrapExpression(onlySpec.node);
  }
}

export function bindingElementKey(
  element: BindingElement,
  table: ScopeTable,
  seenBindings?: Set<Binding>,
): string | undefined {
  const keyNode = element.propertyName ?? element.name;
  if (keyNode === undefined) {
    return undefined;
  }
  return isIdentifier(keyNode) ||
    isStringLiteral(keyNode) ||
    isNumericLiteral(keyNode) ||
    isNoSubstitutionTemplateLiteral(keyNode) ||
    isComputedPropertyName(keyNode)
    ? staticPropertyNameKey(keyNode, table, seenBindings)
    : undefined;
}

function withOptionalDefault(spec: ValueSpec, defaultNode: Node | undefined): ValueSpec {
  return defaultNode === undefined
    ? spec
    : { kind: 'union', left: spec, right: { kind: 'value', node: defaultNode } };
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
    bindPatternSpecs(node.variableDeclaration.name, UNKNOWN_SPEC, childScope, frame.table);
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
    bindPatternSpecs(
      parameter.name,
      withOptionalDefault(UNKNOWN_SPEC, parameter.initializer),
      fnScope,
      frame.table,
    );
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

function declarationSourceSpec(parent: Node, initializer: Node | undefined): ValueSpec {
  if (isForOfStatement(parent)) {
    return { kind: 'elements', source: { kind: 'value', node: parent.expression } };
  }
  if (initializer === undefined || isForInStatement(parent)) {
    return UNKNOWN_SPEC;
  }
  return { kind: 'value', node: initializer };
}

function registerVariableList(
  list: VariableDeclarationList,
  outerScope: LexicalScope,
  table: ScopeTable,
): void {
  const varScopeNode = isBlockScoped(list) ? undefined : nearestVarScopeNode(list, table.root);
  const targetScope =
    varScopeNode === undefined ? outerScope : getOrCreateScope(varScopeNode, outerScope, table);
  for (const declaration of list.declarations) {
    if (varScopeNode !== undefined) {
      seedVarFromParentParameters(declaration.name, targetScope);
    }
    const spec = declarationSourceSpec(list.parent, declaration.initializer);
    bindPatternSpecs(declaration.name, spec, targetScope, table);
  }
}

function bindPatternSpecs(
  name: BindingName,
  source: ValueSpec,
  scope: LexicalScope,
  table: ScopeTable,
): void {
  if (isIdentifier(name)) {
    ensureBinding(scope, name.text).specs.push(source);
    return;
  }
  if (isObjectBindingPattern(name)) {
    bindObjectPatternSpecs(name.elements, source, scope, table);
    return;
  }
  for (const [index, element] of name.elements.entries()) {
    if (!isOmittedExpression(element) && isBindingElement(element)) {
      bindArrayElementSpecs(element, { index, source }, scope, table);
    }
  }
}

function bindObjectPatternSpecs(
  elements: readonly BindingElement[],
  source: ValueSpec,
  scope: LexicalScope,
  table: ScopeTable,
): void {
  const excluded = new Set<string>();
  for (const element of elements) {
    if (element.name === undefined) {
      continue;
    }
    if (element.dotDotDotToken !== undefined) {
      bindPatternSpecs(
        element.name,
        { excluded: new Set(excluded), kind: 'object-rest', source },
        scope,
        table,
      );
      continue;
    }
    const key = bindingElementKey(element, table);
    if (key !== undefined) {
      excluded.add(key);
    }
    const selected = withOptionalDefault({ key, kind: 'member', source }, element.initializer);
    bindPatternSpecs(element.name, selected, scope, table);
  }
}

function bindArrayElementSpecs(
  element: BindingElement,
  slot: { readonly index: number; readonly source: ValueSpec },
  scope: LexicalScope,
  table: ScopeTable,
): void {
  if (element.name === undefined) {
    return;
  }
  if (element.dotDotDotToken !== undefined) {
    bindPatternSpecs(
      element.name,
      { kind: 'array-rest', offset: slot.index, source: slot.source },
      scope,
      table,
    );
    return;
  }
  const selected = withOptionalDefault(
    { key: String(slot.index), kind: 'member', source: slot.source },
    element.initializer,
  );
  bindPatternSpecs(element.name, selected, scope, table);
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
  if (isBinaryExpression(node)) {
    const { kind } = node.operatorToken;
    if (VALUE_ASSIGNMENT_OPERATORS.has(kind)) {
      recordAssignmentTarget(node.left, { kind: 'value', node: node.right }, frame);
    } else if (
      kind >= SyntaxKind.FirstCompoundAssignment &&
      kind <= SyntaxKind.LastCompoundAssignment
    ) {
      recordAssignmentTarget(node.left, UNKNOWN_SPEC, frame);
    }
    return;
  }
  if (
    (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)) &&
    (node.operator === SyntaxKind.PlusPlusToken || node.operator === SyntaxKind.MinusMinusToken)
  ) {
    recordAssignmentTarget(node.operand, UNKNOWN_SPEC, frame);
    return;
  }
  if (isForOfStatement(node) && !isVariableDeclarationList(node.initializer)) {
    recordAssignmentTarget(
      node.initializer,
      { kind: 'elements', source: { kind: 'value', node: node.expression } },
      frame,
    );
  } else if (isForInStatement(node) && !isVariableDeclarationList(node.initializer)) {
    recordAssignmentTarget(node.initializer, UNKNOWN_SPEC, frame);
  }
}

function recordAssignmentTarget(lhs: Node, source: ValueSpec, frame: ScanFrame): void {
  const target = unwrapExpression(lhs);
  if (isBinaryExpression(target) && target.operatorToken.kind === SyntaxKind.EqualsToken) {
    recordAssignmentTarget(target.left, withOptionalDefault(source, target.right), frame);
    return;
  }
  if (isIdentifier(target)) {
    appendSpec(target, source, frame);
  } else if (isObjectLiteralExpression(target)) {
    recordObjectAssignmentWrites(target.properties, source, frame);
  } else if (isArrayLiteralExpression(target)) {
    recordArrayAssignmentWrites(target.elements, source, frame);
  }
}

function recordObjectAssignmentWrites(
  properties: readonly ObjectLiteralElementLike[],
  source: ValueSpec,
  frame: ScanFrame,
): void {
  const excluded = new Set<string>();
  for (const property of properties) {
    if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
      const key = property.name.text;
      excluded.add(key);
      appendSpec(
        property.name,
        withOptionalDefault({ key, kind: 'member', source }, property.objectAssignmentInitializer),
        frame,
      );
    } else if (isPropertyAssignment(property)) {
      const key = staticPropertyNameKey(property.name, frame.table);
      if (key !== undefined) {
        excluded.add(key);
      }
      recordAssignmentTarget(property.initializer, { key, kind: 'member', source }, frame);
    } else if (isSpreadAssignment(property)) {
      recordAssignmentTarget(
        property.expression,
        { excluded: new Set(excluded), kind: 'object-rest', source },
        frame,
      );
    }
  }
}

function recordArrayAssignmentWrites(
  elements: readonly Node[],
  source: ValueSpec,
  frame: ScanFrame,
): void {
  for (const [index, element] of elements.entries()) {
    if (isOmittedExpression(element)) {
      continue;
    }
    if (isSpreadElement(element)) {
      recordAssignmentTarget(
        element.expression,
        { kind: 'array-rest', offset: index, source },
        frame,
      );
    } else {
      recordAssignmentTarget(element, { key: String(index), kind: 'member', source }, frame);
    }
  }
}

function appendSpec(identifier: Identifier, spec: ValueSpec, frame: ScanFrame): void {
  const binding = resolveLexicalBinding(identifier, frame.table);
  if (binding === undefined) {
    return;
  }
  binding.specs.push(spec);
  frame.onSpecAdded(binding);
}
