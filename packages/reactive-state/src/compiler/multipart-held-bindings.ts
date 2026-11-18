import {
  type BinaryExpression,
  type BindingName,
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayBindingPattern,
  isBinaryExpression,
  isBindingElement,
  isBlock,
  isCallExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isExpressionStatement,
  isForOfStatement,
  isIdentifier,
  isNewExpression,
  isObjectBindingPattern,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isSourceFile,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  type NewExpression,
  type Node,
  type ParameterDeclaration,
  SyntaxKind,
  type TypeNode,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf, frameDeclarationOf } from './framed-bindings.ts';
import { framedHeldValues, type Held } from './framed-held-members.ts';
import { framedArgumentPrefix, framedKeyNames, framedMemberNames } from './framed-keys.ts';
import { framedHeldVariable, framedMemberWrites } from './framed-member-writes.ts';
import { framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';

/** Identifier binding expansion, self-write guards, and binding-cut helpers for `Held` paths. */

export type PatternTargetDeclaration = ParameterDeclaration | VariableDeclaration;

export interface PatternReassignmentScan {
  readonly ambiguous: boolean;
  readonly dynamicOpaque: boolean;
  readonly extraSources: readonly Held[];
}

export interface ParameterReadSummary {
  readonly ambiguous?: boolean | undefined;
  readonly dynamicOpaque?: boolean | undefined;
  readonly replaced: boolean;
  readonly sources: readonly Held[];
}

export interface HeldResolution {
  readonly ambiguous: boolean;
  readonly closed: boolean;
  readonly expressions: readonly Expression[];
  readonly typedFormData: boolean;
}

export interface ProjectionCallbacks {
  readonly bindingDefaults: (
    name: Identifier,
    root: ParameterDeclaration['name'],
  ) => readonly Expression[];
  readonly isAssertedFormData: (raw: Expression, keys: readonly string[]) => boolean;
  readonly isBindingTypedFormData: (id: Identifier, keys: readonly string[]) => boolean;
  readonly isOpaqueLeaf: (leaf: Expression, point: Node) => boolean;
  readonly readParameter: (
    name: Identifier,
    parameter: ParameterDeclaration,
  ) => ParameterReadSummary;
  readonly readVariablePattern: (
    name: Identifier,
    declaration: VariableDeclaration,
    point: Node,
  ) => PatternReassignmentScan;
  readonly selectValues: (value: Expression) => readonly Expression[] | undefined;
}

export interface HeldWorkItem {
  readonly activeBindings: ReadonlyMap<Node, ReadonlySet<string>>;
  readonly activeExpressions: ReadonlySet<Expression>;
  readonly enclosingBindingTyped: boolean;
  readonly evalAt: Node | undefined;
  readonly held: Held;
  readonly trailingOuter: number;
}

export interface ChildCandidate {
  readonly enclosingBindingTyped?: boolean | undefined;
  readonly evalAt?: Node | undefined;
  readonly held: Held;
  readonly trailingOuter?: number | undefined;
}

export interface ExpandedStep {
  readonly ambiguous: boolean;
  readonly bindingTypedFormData: boolean;
  readonly children: readonly ChildCandidate[];
  readonly closed: boolean;
  readonly overridesEnclosingType?: boolean | undefined;
}

const BODY_KEY = 'body';
const DELETE_PROPERTY = 'Reflect.deleteProperty';
const SELF_WRITE_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** Whether `type` is an explicit non-`any` / non-`unknown` annotation capable of narrowing enclosing types. */
export function hasNarrowingTypeAnnotation(type: TypeNode | undefined): boolean {
  return (
    type !== undefined &&
    type.kind !== SyntaxKind.AnyKeyword &&
    type.kind !== SyntaxKind.UnknownKeyword
  );
}

/** Whether `entryValue` comes from an enclosing non-loop write whose RHS is still evaluating `readNode`. */
export function isUnrepeatedSelfWrite(
  entryValue: Expression,
  readNode: Node,
  targetDeclaration: Node,
): boolean {
  if (readNode.pos < entryValue.pos || readNode.end > entryValue.end) {
    return false;
  }
  const owner = executionOwner(readNode);
  for (let anc: Node = readNode; anc !== owner && !isSourceFile(anc); anc = anc.parent) {
    if (entryValue.pos < anc.pos || entryValue.end > anc.end) {
      continue;
    }
    if (isEnclosingWriteRhs(anc.parent, anc)) {
      return !repeatedFrameRead(anc.parent, readNode, targetDeclaration, owner);
    }
  }
  return false;
}

/** Whether `parent` writes a target binding while evaluating `anc` as its RHS or `for..of` iterable. */
function isEnclosingWriteRhs(parent: Node, anc: Node): boolean {
  if (isForOfStatement(parent)) {
    return parent.expression === anc;
  }
  return (
    isBinaryExpression(parent) &&
    SELF_WRITE_OPERATORS.has(parent.operatorToken.kind) &&
    parent.right === anc &&
    !isBindingElement(parent.parent)
  );
}

/** Seeds `activeBindings` when an outer holder identifier was already peeled before `inspectHeldPath`. */
export function initialActiveBindings(
  activeSource: Identifier | undefined,
  point: Node,
): ReadonlyMap<Node, ReadonlySet<string>> {
  if (activeSource === undefined) {
    return new Map();
  }
  const selected = frameBindingOf(activeSource);
  if (selected === undefined) {
    return new Map();
  }
  const token = `${activeSource.text}@${String(point.pos)}`;
  return new Map([[selected.binding, new Set([token])]]);
}

/** Expands a variable or parameter identifier along `keys`, guarding replaced binding types. */
export function expandIdentifierStep(
  id: Identifier,
  at: HeldWorkItem,
  outerPoint: Node,
  callbacks: ProjectionCallbacks,
): ExpandedStep {
  const keys = at.held.keys;
  const selected = frameBindingOf(id);
  if (selected === undefined) {
    return { ambiguous: false, bindingTypedFormData: false, children: [], closed: false };
  }
  const defaults =
    selected.keys.length === 0
      ? []
      : callbacks.bindingDefaults(id, selected.binding.name).map((value) => ({ keys, value }));
  if (isVariableDeclaration(selected.binding)) {
    return expandVariableIdentifier(id, selected.binding, { at, callbacks, defaults, outerPoint });
  }
  if (!isParameterDeclaration(selected.binding)) {
    return { ambiguous: false, bindingTypedFormData: false, children: [], closed: false };
  }
  return expandParameterIdentifier(id, selected.binding, {
    at,
    callbacks,
    defaults,
    selectedKeys: selected.keys,
  });
}

/** Expands a `ParameterDeclaration` identifier along `keys`, preserving binding type while unreplaced. */
function expandParameterIdentifier(
  id: Identifier,
  parameter: ParameterDeclaration,
  context: {
    readonly at: HeldWorkItem;
    readonly callbacks: ProjectionCallbacks;
    readonly defaults: readonly Held[];
    readonly selectedKeys: readonly string[];
  },
): ExpandedStep {
  const { at, callbacks, defaults, selectedKeys } = context;
  const keys = at.held.keys;
  const hasOwnType = hasNarrowingTypeAnnotation(parameter.type);
  const effectiveTyped = hasOwnType
    ? callbacks.isBindingTypedFormData(id, keys)
    : at.enclosingBindingTyped;
  const resolved = callbacks.readParameter(id, parameter);
  const fromSources = resolved.sources.map((each) => {
    return {
      enclosingBindingTyped: effectiveTyped,
      held: { keys: [...each.keys, ...keys], value: each.value },
    };
  });
  if (resolved.replaced && resolved.ambiguous !== true) {
    return {
      ambiguous: Boolean(resolved.dynamicOpaque),
      bindingTypedFormData: false,
      children: fromSources,
      closed: resolved.dynamicOpaque !== true,
      overridesEnclosingType: hasOwnType,
    };
  }
  const paramDefault =
    parameter.initializer === undefined
      ? []
      : [
          {
            enclosingBindingTyped: effectiveTyped,
            held: { keys: [...selectedKeys, ...keys], value: parameter.initializer },
          },
        ];
  const defaultChildren = defaults.map((held) => ({ enclosingBindingTyped: false, held }));
  return {
    ambiguous: Boolean(resolved.dynamicOpaque),
    bindingTypedFormData: effectiveTyped,
    children: [...fromSources, ...paramDefault, ...defaultChildren],
    closed: false,
    overridesEnclosingType: hasOwnType,
  };
}

/** Expands a `VariableDeclaration` identifier along `keys`, preserving binding type while live. */
function expandVariableIdentifier(
  id: Identifier,
  declaration: VariableDeclaration,
  context: {
    readonly at: HeldWorkItem;
    readonly callbacks: ProjectionCallbacks;
    readonly defaults: readonly Held[];
    readonly outerPoint: Node;
  },
): ExpandedStep {
  const { at, callbacks, defaults, outerPoint } = context;
  const keys = at.held.keys;
  const evalPoint = at.evalAt ?? outerPoint;
  const held = framedHeldValues(id, keys, evalPoint);
  const patternScan = callbacks.readVariablePattern(id, declaration, evalPoint);
  const hasOwnType = hasNarrowingTypeAnnotation(declaration.type);
  const effectiveTyped = hasOwnType
    ? callbacks.isBindingTypedFormData(id, keys)
    : at.enclosingBindingTyped;
  const patternChildren = patternScan.extraSources.map((each) => {
    return {
      enclosingBindingTyped: effectiveTyped,
      held: { keys: [...each.keys, ...keys], value: each.value },
    };
  });
  const defaultChildren = defaults.map((entry) => ({ enclosingBindingTyped: false, held: entry }));
  if (held === undefined) {
    return {
      ambiguous: patternScan.dynamicOpaque,
      bindingTypedFormData: effectiveTyped,
      children: [...patternChildren, ...defaultChildren],
      closed: false,
      overridesEnclosingType: hasOwnType,
    };
  }
  const initialChildren =
    held.initial === undefined
      ? []
      : [{ enclosingBindingTyped: effectiveTyped, held: held.initial }];
  const liveHeld = held.held.filter(
    (entry) => !isUnrepeatedSelfWrite(entry.value, evalPoint, declaration),
  );
  const postLiteralWrites =
    evalPoint !== outerPoint && at.trailingOuter > 0
      ? trailingMemberWrites(id, declaration, at, outerPoint)
      : [];
  const items = [...liveHeld, ...postLiteralWrites];
  const heldChildren = items.map((it) => ({ enclosingBindingTyped: effectiveTyped, held: it }));
  const hasSources =
    initialChildren.length > 0 || heldChildren.length > 0 || patternChildren.length > 0;
  const closed = !patternScan.ambiguous && hasSources;
  const initialSurvives =
    held.initial !== undefined ||
    (declaration.initializer === undefined && heldChildren.length === 0);
  return {
    ambiguous: patternScan.dynamicOpaque,
    bindingTypedFormData: !closed && initialSurvives && effectiveTyped,
    children: [...initialChildren, ...heldChildren, ...patternChildren, ...defaultChildren],
    closed,
    overridesEnclosingType: hasOwnType,
  };
}

/** Collects nested member writes on `declaration` after an earlier literal capture that reach `outerPoint`. */
function trailingMemberWrites(
  id: Identifier,
  declaration: VariableDeclaration,
  at: HeldWorkItem,
  outerPoint: Node,
): readonly Held[] {
  const keys = at.held.keys;
  const holder = framedHeldVariable(declaration);
  const minDepth = keys.length - at.trailingOuter + 1;
  const found: Held[] = [];
  for (const write of framedMemberWrites(id.getSourceFile())) {
    if (
      write.holder !== holder ||
      write.path.length < minDepth ||
      write.path.length > keys.length ||
      write.path.some((names, idx) => names?.includes(keys[idx] ?? '') === false) ||
      !reachesOuterWrite(write.node, id, declaration, outerPoint)
    ) {
      continue;
    }
    found.push({ keys: keys.slice(write.path.length), value: write.value });
  }
  return found;
}

/** Whether `writeNode` lies on a feasible branch and can execute before `outerPoint`. */
function reachesOuterWrite(
  writeNode: Node,
  id: Identifier,
  declaration: VariableDeclaration,
  outerPoint: Node,
): boolean {
  if (!framedPossibleBranch(writeNode)) {
    return false;
  }
  const owner = executionOwner(outerPoint);
  return (
    executionOwner(writeNode) !== owner ||
    writeNode.pos < outerPoint.end ||
    destructuredFirst(writeNode, outerPoint) ||
    repeatedFrameRead(writeNode, id, declaration, owner)
  );
}

/** Collects `BindingElement` default initializers for `name` within `root`. */
export function bindingDefaultsOf(name: Identifier, root: BindingName): readonly Expression[] {
  const found: Expression[] = [];
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isBindingElement(node) &&
      node.name !== undefined &&
      isIdentifier(node.name) &&
      node.name.text === name.text &&
      node.initializer !== undefined
    ) {
      found.push(node.initializer);
    }
    if (isObjectBindingPattern(node) || isArrayBindingPattern(node) || isBindingElement(node)) {
      node.forEachChild((child) => {
        pending.push(child);
      });
    }
  }
  return found;
}

/** Latest plain statement assignment to `name` in an enclosing block before `anchor`. */
export function lastDefiniteBindingWrite(
  anchor: Node,
  name: Identifier,
  binding: PatternTargetDeclaration,
  owner: Node,
): BinaryExpression | undefined {
  let latest: BinaryExpression | undefined;
  for (let at: Node = anchor; at !== owner && !isSourceFile(at); at = at.parent) {
    const parent = at.parent;
    if (!isBlock(parent) && !isSourceFile(parent)) {
      continue;
    }
    for (const statement of parent.statements) {
      if (statement === at) {
        break;
      }
      const write = directBindingWrite(statement, name, binding, owner);
      if (write !== undefined && (latest === undefined || write.pos > latest.pos)) {
        latest = write;
      }
    }
  }
  return latest;
}

/** Plain `target = rhs` expression statement rebinding `name` in the same execution owner. */
function directBindingWrite(
  statement: Node,
  name: Identifier,
  binding: PatternTargetDeclaration,
  owner: Node,
): BinaryExpression | undefined {
  if (!isExpressionStatement(statement)) {
    return undefined;
  }
  const expression = unwrapped(statement.expression);
  if (
    isBinaryExpression(expression) &&
    expression.operatorToken.kind === SyntaxKind.EqualsToken &&
    isIdentifier(expression.left) &&
    expression.left.text === name.text &&
    frameDeclarationOf(expression.left) === binding &&
    executionOwner(expression) === owner
  ) {
    return expression;
  }
  return undefined;
}

/** Identifier site where `node` directly reads `parameter`, following whole `const` aliases. */
export function parameterCaptureOf(
  node: Expression,
  parameter: ParameterDeclaration,
  bindingName?: string,
): Identifier | undefined {
  let current: Expression | undefined = unwrapped(node);
  const seen = new Set<Node>();
  while (current !== undefined && isIdentifier(current) && !seen.has(current)) {
    seen.add(current);
    const declared = frameDeclarationOf(current);
    if (declared === parameter) {
      const matchesBinding =
        bindingName === undefined ? isIdentifier(parameter.name) : current.text === bindingName;
      return matchesBinding ? current : undefined;
    }
    current = constantAliasValue(declared);
  }
  return undefined;
}

/** Initializer unwrapped from a whole `const` variable declaration; undefined otherwise. */
function constantAliasValue(declared: Node | undefined): Expression | undefined {
  if (
    declared === undefined ||
    !isVariableDeclaration(declared) ||
    !isIdentifier(declared.name) ||
    !isVariableDeclarationList(declared.parent) ||
    !/^const\s/u.test(declared.parent.getText(declared.getSourceFile())) ||
    declared.initializer === undefined
  ) {
    return undefined;
  }
  return unwrapped(declared.initializer);
}

/** Whether `node` deletes `body` (or an unknown key) on a target or hands it to non-global code. */
export function nodeRemovesParameterBody(
  node: Node,
  isTarget: (expr: Expression) => boolean,
): boolean {
  if (isCallExpression(node) || isNewExpression(node)) {
    return callRemovesParameterBody(node, isTarget);
  }
  if (!isDeleteExpression(node)) {
    return false;
  }
  const target = unwrapped(node.expression);
  if (!isPropertyAccessExpression(target) && !isElementAccessExpression(target)) {
    return false;
  }
  const names = framedMemberNames(target);
  return isTarget(target.expression) && names?.includes(BODY_KEY) !== false;
}

/** Checks `Reflect.deleteProperty(options, key)` and non-global calls receiving `options`. */
function callRemovesParameterBody(
  node: CallExpression | NewExpression,
  isTarget: (expr: Expression) => boolean,
): boolean {
  const callee = unwrapped(node.expression);
  const native = globalPathOf(callee)?.join('.');
  if (native === DELETE_PROPERTY && isCallExpression(node)) {
    const [target, key] = framedArgumentPrefix(node, node.arguments).values;
    const names = key === undefined ? undefined : framedKeyNames(key);
    return target !== undefined && isTarget(target) && names?.includes(BODY_KEY) !== false;
  }
  if (native !== undefined) {
    return false;
  }
  const handed = [...(node.arguments ?? [])].map((arg) =>
    isSpreadElement(arg) ? arg.expression : arg,
  );
  if (isPropertyAccessExpression(callee) || isElementAccessExpression(callee)) {
    handed.push(callee.expression);
  }
  return handed.some((each) => isTarget(each));
}
