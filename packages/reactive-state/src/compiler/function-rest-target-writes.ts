import {
  type BindingElement,
  type CallExpression,
  type Expression,
  type Identifier,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isExpression,
  isExpressionStatement,
  isIdentifier,
  isMethodDeclaration,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isTypeOfExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  isVoidExpression,
  type Node,
  type SourceFile,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf, isTakenApart, useOf } from './code-globals.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { declaredBindingTarget } from './function-assignment-patterns.ts';
import { literalElementKey, LOGICAL_FORWARDING } from './function-candidate-objects.ts';
import {
  isDeclaredIdentifier,
  isSafeLockCall,
  isSkippedSyntax,
  unwrapTarget,
  VALUE_ASSIGNING,
} from './function-this-writes.ts';
import { targetsOf } from './kept.ts';
import { bindingIdentifiers, readsBinding } from './scope.ts';
import { writtenBy } from './written.ts';

/** Per-file escape flags and in-place assigned values/spreads recorded against binding targets. */
export interface RestTargetSafety {
  readonly assignSources: ReadonlyMap<Node, readonly Expression[]>;
  readonly escaped: ReadonlySet<Node>;
  readonly writtenValues: ReadonlyMap<Node, readonly (Expression | Node)[]>;
}

interface MutableSafetyState {
  readonly assignSources: Map<Node, Expression[]>;
  readonly escaped: Set<Node>;
  readonly reverseAliases: Map<Node, Set<Node>>;
  readonly writtenValues: Map<Node, (Expression | Node)[]>;
}

const COMPARING: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
]);

const REST_TARGET_SAFETY = new WeakMap<SourceFile, RestTargetSafety>();

/** Computes and caches escape status and in-place member/`Object.assign` writes for bindings in `file`. */
export function restTargetSafety(file: SourceFile): RestTargetSafety {
  const cached = REST_TARGET_SAFETY.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const state: MutableSafetyState = {
    assignSources: new Map(),
    escaped: new Set(),
    reverseAliases: new Map(),
    writtenValues: new Map(),
  };
  const visit = (node: Node): void => {
    if (isSkippedSyntax(node)) {
      return;
    }
    recordNodeRestSafety(node, state);
    node.forEachChild(visit);
  };
  visit(file);
  propagateReverseSet(state.escaped, state.reverseAliases);
  propagateReverseMap(state.writtenValues, state.reverseAliases);
  propagateReverseMap(state.assignSources, state.reverseAliases);
  const built: RestTargetSafety = {
    assignSources: state.assignSources,
    escaped: state.escaped,
    writtenValues: state.writtenValues,
  };
  REST_TARGET_SAFETY.set(file, built);
  return built;
}

/** Records declaration exports, in-place property/call writes, and identifier escapes at `node`. */
function recordNodeRestSafety(node: Node, state: MutableSafetyState): void {
  if (isVariableDeclaration(node) && isExportedVariableDeclaration(node)) {
    for (const bound of bindingIdentifiers(node.name)) {
      state.escaped.add(declaredBindingTarget(bound, node));
    }
  }
  recordDirectBindingMutation(node, state);
  const written = writtenBy(node);
  if (written !== undefined) {
    recordWrittenEscapes(node, written, state.escaped);
  }
  if (isIdentifier(node) && !isDeclaredIdentifier(node) && readsBinding(node)) {
    recordIdentifierRestUse(node, state);
  }
}

/** Records value expressions written via `obj.k = rhs`, `Object.assign`, or `defineProperty`. */
function recordDirectBindingMutation(node: Node, state: MutableSafetyState): void {
  if (isBinaryExpression(node) && VALUE_ASSIGNING.has(node.operatorToken.kind)) {
    const target = unwrapTarget(node.left);
    if (isPropertyAccessExpression(target) || isElementAccessExpression(target)) {
      const rhs = unwrapped(node.right);
      const targets = forwardedTargetsOf(unwrapped(target.expression));
      for (const binding of targets) {
        appendMapItem(state.writtenValues, binding, rhs);
        state.escaped.add(binding);
      }
    }
    return;
  }
  if (isCallExpression(node)) {
    recordCallBindingMutation(node, state);
  }
}

/** Records `Object.assign` sources and `defineProperty` descriptor values against target bindings. */
function recordCallBindingMutation(call: CallExpression, state: MutableSafetyState): void {
  const path = globalPathOf(unwrapped(call.expression))?.join('.');
  const [first, , descArg] = call.arguments;
  if (first === undefined || isSpreadElement(first)) {
    return;
  }
  if (path === 'Object.assign' && call.arguments.length > 1) {
    const sources = call.arguments
      .slice(1)
      .flatMap((arg) => (isSpreadElement(arg) ? [] : [unwrapped(arg)]));
    const targets = forwardedTargetsOf(unwrapped(first));
    for (const binding of targets) {
      state.escaped.add(binding);
      for (const src of sources) {
        appendMapItem(state.assignSources, binding, src);
      }
    }
    return;
  }
  if (
    descArg !== undefined &&
    !isSpreadElement(descArg) &&
    (path === 'Object.defineProperty' || path === 'Reflect.defineProperty')
  ) {
    const val = descriptorValue(unwrapped(descArg));
    if (val !== undefined) {
      const targets = forwardedTargetsOf(unwrapped(first));
      for (const binding of targets) {
        state.escaped.add(binding);
        appendMapItem(state.writtenValues, binding, val);
      }
    }
  }
}

function descriptorValue(descriptor: Expression): Expression | Node | undefined {
  if (!isObjectLiteralExpression(descriptor)) {
    return undefined;
  }
  for (let index = descriptor.properties.length - 1; index >= 0; index -= 1) {
    const prop = descriptor.properties[index];
    if (prop !== undefined && literalElementKey(prop) === 'value') {
      if (isMethodDeclaration(prop)) {
        return prop;
      }
      if (isPropertyAssignment(prop)) {
        return unwrapped(prop.initializer);
      }
      if (isShorthandPropertyAssignment(prop) && isIdentifier(prop.name)) {
        return prop.name;
      }
    }
  }
  return undefined;
}

/** Marks receiver bindings escaped by `delete obj.k`, `obj.k++`, or mutating built-in calls. */
function recordWrittenEscapes(writer: Node, written: Node, escaped: Set<Node>): void {
  if (isCallExpression(writer)) {
    if (isExpression(written)) {
      const targets = forwardedTargetsOf(unwrapped(written));
      for (const binding of targets) {
        escaped.add(binding);
      }
    }
    return;
  }
  for (const rawTarget of targetsOf(written)) {
    const target = unwrapTarget(rawTarget);
    if (isPropertyAccessExpression(target) || isElementAccessExpression(target)) {
      const targets = forwardedTargetsOf(unwrapped(target.expression));
      for (const binding of targets) {
        escaped.add(binding);
      }
    }
  }
}

/** Collects binding targets reachable through transparent value-forwarding expressions in `expr`. */
function forwardedTargetsOf(expr: Expression): readonly Node[] {
  const bucket = new Set<Node>();
  const walk = (current: Expression): void => {
    if (isIdentifier(current)) {
      const declared = frameDeclarationOf(current);
      if (declared !== undefined && isVariableDeclaration(declared)) {
        bucket.add(declaredBindingTarget(current, declared));
      }
      return;
    }
    if (isConditionalExpression(current)) {
      walk(unwrapped(current.whenTrue));
      walk(unwrapped(current.whenFalse));
      return;
    }
    if (isBinaryExpression(current) && LOGICAL_FORWARDING.has(current.operatorToken.kind)) {
      walk(unwrapped(current.left));
      walk(unwrapped(current.right));
    }
  };
  walk(expr);
  return [...bucket];
}

/** Classifies a single identifier read `node` as clean, alias-forwarded, or escaped. */
function recordIdentifierRestUse(node: Identifier, state: MutableSafetyState): void {
  const declared = frameDeclarationOf(node);
  if (declared === undefined || !isVariableDeclaration(declared)) {
    return;
  }
  const binding = declaredBindingTarget(node, declared);
  const { at, parent } = climbForwardedValue(node);
  if (isReadOnlyValueConsumer(at, parent)) {
    return;
  }
  if (
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === at
  ) {
    const memberUse = useOf(parent);
    if (isCallExpression(memberUse.parent) && memberUse.parent.expression === memberUse.at) {
      state.escaped.add(binding);
    }
    return;
  }
  if (recordsAliasOrDestructureConsumer(at, parent, binding, state.reverseAliases)) {
    return;
  }
  state.escaped.add(binding);
}

/** Climbs parens, assertions, and value-forwarding conditional/logical arms above `start`. */
function climbForwardedValue(start: Node): { readonly at: Node; readonly parent: Node } {
  let step = useOf(start);
  while (
    (isConditionalExpression(step.parent) &&
      (step.parent.whenTrue === step.at || step.parent.whenFalse === step.at)) ||
    (isBinaryExpression(step.parent) &&
      LOGICAL_FORWARDING.has(step.parent.operatorToken.kind) &&
      (step.parent.left === step.at || step.parent.right === step.at))
  ) {
    step = useOf(step.parent);
  }
  return step;
}

/** Whether `parent` only tests, spreads, inspects, or locks `at` without mutating or retaining it. */
function isReadOnlyValueConsumer(at: Node, parent: Node): boolean {
  if (isConditionalExpression(parent) && parent.condition === at) {
    return true;
  }
  if (isSpreadAssignment(parent) && !isTakenApart(parent.parent)) {
    return true;
  }
  if (isExpressionStatement(parent) || isVoidExpression(parent) || isTypeOfExpression(parent)) {
    return true;
  }
  if (isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind;
    if (
      COMPARING.has(operator) ||
      (operator === SyntaxKind.InKeyword && isExpression(at) && parent.right === at)
    ) {
      return true;
    }
  }
  return (
    isCallExpression(parent) &&
    isExpression(at) &&
    parent.arguments.length === 1 &&
    parent.arguments[0] === at &&
    isSafeLockCall(parent)
  );
}

/** Records object-destructuring reads or local variable alias edges; answers `false` when escaping. */
function recordsAliasOrDestructureConsumer(
  at: Node,
  parent: Node,
  binding: Node,
  reverseAliases: Map<Node, Set<Node>>,
): boolean {
  if (!isExpression(at)) {
    return false;
  }
  if ((isVariableDeclaration(parent) || isBindingElement(parent)) && parent.initializer === at) {
    return recordsInitializerConsumer(parent, binding, reverseAliases);
  }
  if (
    isBinaryExpression(parent) &&
    VALUE_ASSIGNING.has(parent.operatorToken.kind) &&
    parent.right === at
  ) {
    return recordsAssignmentConsumer(parent.left, binding, reverseAliases);
  }
  return false;
}

function recordsInitializerConsumer(
  parent: VariableDeclaration | BindingElement,
  binding: Node,
  reverseAliases: Map<Node, Set<Node>>,
): boolean {
  if (parent.name !== undefined && isObjectBindingPattern(parent.name)) {
    return true;
  }
  if (
    isVariableDeclaration(parent) &&
    isIdentifier(parent.name) &&
    !isExportedVariableDeclaration(parent)
  ) {
    addReverseEdge(reverseAliases, parent, binding);
    return true;
  }
  return false;
}

function recordsAssignmentConsumer(
  rawLhs: Expression,
  binding: Node,
  reverseAliases: Map<Node, Set<Node>>,
): boolean {
  const lhs = unwrapTarget(rawLhs);
  if (isObjectLiteralExpression(lhs) && isTakenApart(lhs)) {
    return true;
  }
  if (!isIdentifier(lhs)) {
    return false;
  }
  const lhsDecl = frameDeclarationOf(lhs);
  if (
    lhsDecl === undefined ||
    !isVariableDeclaration(lhsDecl) ||
    isExportedVariableDeclaration(lhsDecl)
  ) {
    return false;
  }
  addReverseEdge(reverseAliases, declaredBindingTarget(lhs, lhsDecl), binding);
  return true;
}

function appendMapItem<T>(map: Map<Node, T[]>, key: Node, value: T): void {
  let list = map.get(key);
  if (list === undefined) {
    list = [];
    map.set(key, list);
  }
  if (!list.includes(value)) {
    list.push(value);
  }
}

function addReverseEdge(map: Map<Node, Set<Node>>, fromAlias: Node, toSource: Node): void {
  let set = map.get(fromAlias);
  if (set === undefined) {
    set = new Set();
    map.set(fromAlias, set);
  }
  set.add(toSource);
}

function propagateReverseSet(
  tainted: Set<Node>,
  reverseAliases: ReadonlyMap<Node, ReadonlySet<Node>>,
): void {
  const queue = [...tainted];
  for (let item = queue.pop(); item !== undefined; item = queue.pop()) {
    const sources = reverseAliases.get(item);
    if (sources !== undefined) {
      for (const source of sources) {
        if (!tainted.has(source)) {
          tainted.add(source);
          queue.push(source);
        }
      }
    }
  }
}

function propagateReverseMap<T>(
  valuesByTarget: Map<Node, T[]>,
  reverseAliases: ReadonlyMap<Node, ReadonlySet<Node>>,
): void {
  const queue = [...valuesByTarget.keys()];
  for (let item = queue.pop(); item !== undefined; item = queue.pop()) {
    const current = valuesByTarget.get(item);
    const sources = reverseAliases.get(item);
    if (current !== undefined && sources !== undefined) {
      for (const source of sources) {
        const before = valuesByTarget.get(source)?.length ?? 0;
        for (const each of current) {
          appendMapItem(valuesByTarget, source, each);
        }
        if ((valuesByTarget.get(source)?.length ?? 0) > before) {
          queue.push(source);
        }
      }
    }
  }
}

function isExportedVariableDeclaration(declared: VariableDeclaration): boolean {
  if (!isVariableDeclarationList(declared.parent) || !isVariableStatement(declared.parent.parent)) {
    return false;
  }
  return (
    declared.parent.parent.modifiers?.some(
      (modifier) => modifier.kind === SyntaxKind.ExportKeyword,
    ) === true
  );
}
