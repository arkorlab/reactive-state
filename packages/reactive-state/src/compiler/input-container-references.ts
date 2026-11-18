import {
  type ArrayLiteralExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBindingElement,
  isCallExpression,
  isComputedPropertyName,
  isConditionalExpression,
  isElementAccessExpression,
  isExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isVariableDeclaration,
  isVoidExpression,
  type Node,
  type ObjectLiteralExpression,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { type MetadataSource } from './input-bindings.ts';
import {
  type MemberAccess,
  memberAccessKey,
  PROTO_KEY,
  receiverSlotReads,
  SAFE_INSPECTORS,
  wrappedExpression,
} from './input-receiver-members.ts';
import { literalPropertyName } from './input-selections.ts';
import { targetsOf } from './kept.ts';
import { isTypeOnly, readsBinding } from './scope.ts';
import { writtenBy } from './written.ts';

/** Memoized reference expansion and escape/setter validation on fresh literal containers. */

export type ContainerLiteral = ArrayLiteralExpression | ObjectLiteralExpression;

export interface ContainerIndex {
  readonly bindingReads: ReadonlyMap<Node, readonly Identifier[]>;
  readonly holdersCache: WeakMap<
    MetadataSource['bindings'],
    Map<Expression, readonly MetadataSource[] | null>
  >;
  readonly reassignedBindings: ReadonlySet<Node>;
  readonly referencesCache: WeakMap<
    MetadataSource['bindings'],
    Map<ContainerLiteral, readonly Expression[] | null>
  >;
  readonly writtenMembers: ReadonlySet<Node>;
}

export interface ContainerWalkState {
  readonly activeContainers: Set<ContainerLiteral>;
  readonly cuts: { count: number };
  readonly index: ContainerIndex;
}

const CONTAINER_INDEX = new WeakMap<SourceFile, ContainerIndex>();

/** Returns every reference to `container` when `container` stays unescaped and setter-safe. */
export function containedReferencesOf(
  container: ContainerLiteral,
  bindings: MetadataSource['bindings'],
  state: ContainerWalkState,
): readonly Expression[] | undefined {
  const byContainer = cachedReferenceMap(state.index, bindings);
  const cached = byContainer.get(container);
  if (cached !== undefined) {
    return cached ?? undefined;
  }
  if (state.activeContainers.has(container)) {
    state.cuts.count += 1;
    return undefined;
  }
  const cutsBefore = state.cuts.count;
  state.activeContainers.add(container);
  const computed = computeContainedReferences(container, bindings, state);
  state.activeContainers.delete(container);
  if (state.cuts.count === cutsBefore) {
    byContainer.set(container, computed ?? null);
  }
  return computed;
}

/** Whether `ref` is the receiver of a member write that may overwrite `key` on `container`. */
export function writesSelectedSlot(ref: Expression, key: string, index: ContainerIndex): boolean {
  const parent = ref.parent;
  if (
    (!isPropertyAccessExpression(parent) && !isElementAccessExpression(parent)) ||
    wrappedExpression(unwrapped(parent.expression)) !== ref ||
    !index.writtenMembers.has(unwrapped(parent))
  ) {
    return false;
  }
  const writtenKey = memberAccessKey(parent);
  return writtenKey === undefined || writtenKey === key;
}

/** Per-binding memo table for completed container reference expansions. */
function cachedReferenceMap(
  index: ContainerIndex,
  bindings: MetadataSource['bindings'],
): Map<ContainerLiteral, readonly Expression[] | null> {
  let byContainer = index.referencesCache.get(bindings);
  if (byContainer === undefined) {
    byContainer = new Map();
    index.referencesCache.set(bindings, byContainer);
  }
  return byContainer;
}

/** Expands and validates all direct, aliased, and outer-projected references to `container`. */
function computeContainedReferences(
  container: ContainerLiteral,
  bindings: MetadataSource['bindings'],
  state: ContainerWalkState,
): readonly Expression[] | undefined {
  const found: Expression[] = [];
  const pending: Expression[] = [wrappedExpression(container)];
  const visited = new Set<Expression>();
  for (let ref = pending.pop(); ref !== undefined; ref = pending.pop()) {
    if (visited.has(ref)) {
      continue;
    }
    visited.add(ref);
    found.push(ref);
    if (
      !expandReference(ref, bindings, state, pending) ||
      !safeContainedUse(ref, container, bindings, state.index)
    ) {
      return undefined;
    }
  }
  return found;
}

/** Pushes downstream alias, parameter, conditional, receiver-slot, or outer-literal references. */
function expandReference(
  ref: Expression,
  bindings: MetadataSource['bindings'],
  state: ContainerWalkState,
  pending: Expression[],
): boolean {
  if (!expandBoundParameters(ref, bindings, state.index, pending)) {
    return false;
  }
  const slotReads = receiverSlotReads(ref, state.index.writtenMembers);
  if (slotReads !== null) {
    if (slotReads === undefined) {
      return false;
    }
    pending.push(...slotReads);
    return true;
  }
  return expandLocalReference(ref, bindings, state, pending);
}

/** Expands variable/parameter initializers, conditional branches, and enclosing literal entries. */
function expandLocalReference(
  ref: Expression,
  bindings: MetadataSource['bindings'],
  state: ContainerWalkState,
  pending: Expression[],
): boolean {
  const parent = ref.parent;
  if (
    (isVariableDeclaration(parent) || isParameterDeclaration(parent)) &&
    parent.initializer === ref
  ) {
    if (!isIdentifier(parent.name)) {
      return false;
    }
    pushReads(parent, state.index, pending);
    return true;
  }
  if (isConditionalExpression(parent) && (parent.whenTrue === ref || parent.whenFalse === ref)) {
    pending.push(wrappedExpression(parent));
    return true;
  }
  return expandNestedLiteral(ref, bindings, state, pending);
}

/** Queues parameter reads when `ref` is the actual argument bound to a parameter in `bindings`. */
function expandBoundParameters(
  ref: Expression,
  bindings: MetadataSource['bindings'],
  index: ContainerIndex,
  pending: Expression[],
): boolean {
  for (const [parameter, bound] of bindings) {
    if (bound !== undefined && wrappedExpression(unwrapped(bound)) === ref) {
      if (!isIdentifier(parameter.name)) {
        return false;
      }
      pushReads(parameter, index, pending);
    }
  }
  return true;
}

/** Pushes member reads on an outer literal when `ref` is stored in a non-prototype own slot. */
function expandNestedLiteral(
  ref: Expression,
  bindings: MetadataSource['bindings'],
  state: ContainerWalkState,
  pending: Expression[],
): boolean {
  const outer = enclosingLiteralEntry(ref);
  if (outer === undefined) {
    return true;
  }
  if (outer.key === undefined || outer.key === PROTO_KEY) {
    return false;
  }
  const outerRefs = containedReferencesOf(outer.literal, bindings, state);
  if (outerRefs === undefined) {
    return false;
  }
  for (const outerRef of outerRefs) {
    pushOuterMemberRead(outerRef, outer.key, pending);
  }
  return true;
}

/** Queues a member read on `outerRef` when it may select slot `expectedKey`. */
function pushOuterMemberRead(
  outerRef: Expression,
  expectedKey: string,
  pending: Expression[],
): void {
  const access = outerRef.parent;
  if (
    (isPropertyAccessExpression(access) || isElementAccessExpression(access)) &&
    wrappedExpression(unwrapped(access.expression)) === outerRef
  ) {
    const readKey = memberAccessKey(access);
    if (readKey === undefined || readKey === expectedKey) {
      pending.push(wrappedExpression(access));
    }
  }
}

/** Outer literal and static slot key when `ref` is an object property value or array element. */
function enclosingLiteralEntry(
  ref: Expression,
): { readonly key: string | undefined; readonly literal: ContainerLiteral } | undefined {
  const parent = ref.parent;
  if (
    isPropertyAssignment(parent) &&
    parent.initializer === ref &&
    isObjectLiteralExpression(parent.parent)
  ) {
    return { key: literalPropertyName(parent.name), literal: parent.parent };
  }
  const inner = unwrapped(ref);
  if (
    isShorthandPropertyAssignment(parent) &&
    parent.name === inner &&
    isObjectLiteralExpression(parent.parent)
  ) {
    return { key: parent.name.text, literal: parent.parent };
  }
  if (isArrayLiteralExpression(parent)) {
    const slot = parent.elements.indexOf(ref);
    return slot === -1 ? undefined : { key: String(slot), literal: parent };
  }
  return undefined;
}

/** Verifies `ref` does not escape `container` or trigger a method, prototype, or setter write. */
function safeContainedUse(
  ref: Expression,
  container: ContainerLiteral,
  bindings: MetadataSource['bindings'],
  index: ContainerIndex,
): boolean {
  const parent = ref.parent;
  if (
    ((isVariableDeclaration(parent) || isParameterDeclaration(parent)) &&
      parent.initializer === ref) ||
    (isVoidExpression(parent) && parent.expression === ref) ||
    (isConditionalExpression(parent) && (parent.whenTrue === ref || parent.whenFalse === ref)) ||
    enclosingLiteralEntry(ref) !== undefined ||
    receiverSlotReads(ref, index.writtenMembers) !== null
  ) {
    return true;
  }
  if (
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    wrappedExpression(unwrapped(parent.expression)) === ref
  ) {
    return safeMemberOnContainer(parent, container, index);
  }
  return safeCallArgumentUse(ref, parent, bindings);
}

/** Rejects method calls and dynamic, `__proto__`, or accessor/prototype-backed member writes. */
function safeMemberOnContainer(
  access: MemberAccess,
  container: ContainerLiteral,
  index: ContainerIndex,
): boolean {
  const outer = wrappedExpression(access);
  if (
    isCallExpression(outer.parent) &&
    wrappedExpression(unwrapped(outer.parent.expression)) === outer
  ) {
    return false;
  }
  if (!index.writtenMembers.has(unwrapped(access))) {
    return true;
  }
  const writtenKey = memberAccessKey(access);
  return (
    writtenKey !== undefined &&
    writtenKey !== PROTO_KEY &&
    !containerMayInvokeAccessor(container, writtenKey)
  );
}

/** Whether writing `writtenKey` on `container` can invoke an own or literal-installed accessor. */
function containerMayInvokeAccessor(container: ContainerLiteral, writtenKey: string): boolean {
  if (isArrayLiteralExpression(container)) {
    return false;
  }
  return container.properties.some((property) => {
    if (isSpreadAssignment(property)) {
      return true;
    }
    if (isGetAccessorDeclaration(property) || isSetAccessorDeclaration(property)) {
      const name = literalPropertyName(property.name);
      return name === undefined || name === writtenKey;
    }
    return (
      isPropertyAssignment(property) &&
      !isComputedPropertyName(property.name) &&
      literalPropertyName(property.name) === PROTO_KEY &&
      unwrapped(property.initializer).kind !== SyntaxKind.NullKeyword
    );
  });
}

/** Allows safe native lock/metadata calls and call sites already bound in `bindings`. */
function safeCallArgumentUse(
  ref: Expression,
  parent: Node,
  bindings: MetadataSource['bindings'],
): boolean {
  if (!isCallExpression(parent) && !isNewExpression(parent)) {
    return false;
  }
  if (isCallExpression(parent) && parent.arguments[0] === ref) {
    const path = globalPathOf(unwrapped(parent.expression))?.join('.');
    if (path !== undefined && SAFE_INSPECTORS.has(path)) {
      return true;
    }
  }
  for (const bound of bindings.values()) {
    if (bound !== undefined && wrappedExpression(unwrapped(bound)) === ref) {
      return true;
    }
  }
  return false;
}

/** Queues all identifier reads of `declaration` wrapped past parentheses and type assertions. */
function pushReads(declaration: Node, index: ContainerIndex, pending: Expression[]): void {
  for (const read of index.bindingReads.get(declaration) ?? []) {
    pending.push(wrappedExpression(read));
  }
}

/** Indexes identifier binding reads, reassigned bindings, and written member expressions per file. */
export function containerIndexOf(file: SourceFile): ContainerIndex {
  const cached = CONTAINER_INDEX.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const bindingReads = new Map<Node, Identifier[]>();
  const reassignedBindings = new Set<Node>();
  const writtenMembers = new Set<Node>();
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) {
      continue;
    }
    recordBindingRead(node, bindingReads);
    recordWriteTargets(node, reassignedBindings, writtenMembers);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  const built: ContainerIndex = {
    bindingReads,
    holdersCache: new WeakMap(),
    reassignedBindings,
    referencesCache: new WeakMap(),
    writtenMembers,
  };
  CONTAINER_INDEX.set(file, built);
  return built;
}

/** Records `node` into `bindingReads` when it is a value-level identifier read. */
function recordBindingRead(node: Node, bindingReads: Map<Node, Identifier[]>): void {
  if (!isIdentifier(node) || !readsBinding(node) || declaresOwnBinding(node)) {
    return;
  }
  const declaration = frameDeclarationOf(node);
  if (declaration !== undefined) {
    const list = bindingReads.get(declaration) ?? [];
    list.push(node);
    bindingReads.set(declaration, list);
  }
}

/** Records non-call assignment, unary, delete, and iteration write targets into the file index. */
function recordWriteTargets(
  node: Node,
  reassignedBindings: Set<Node>,
  writtenMembers: Set<Node>,
): void {
  const written = isCallExpression(node) ? undefined : writtenBy(node);
  for (const target of written === undefined ? [] : targetsOf(written)) {
    const each = isExpression(target) ? unwrapped(target) : target;
    if (isPropertyAccessExpression(each) || isElementAccessExpression(each)) {
      writtenMembers.add(each);
    } else if (isIdentifier(each)) {
      const declared = frameDeclarationOf(each);
      if (declared !== undefined) {
        reassignedBindings.add(declared);
      }
    }
  }
}

/** Excludes declaration name identifiers so only true references enter `bindingReads`. */
function declaresOwnBinding(node: Identifier): boolean {
  const parent = node.parent;
  return (
    ((isVariableDeclaration(parent) ||
      isParameterDeclaration(parent) ||
      isBindingElement(parent)) &&
      parent.name === node) ||
    (isBindingElement(parent) && parent.propertyName === node)
  );
}
