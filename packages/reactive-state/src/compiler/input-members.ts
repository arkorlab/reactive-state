import {
  type ArrayLiteralExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBindingElement,
  isCallExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isVariableDeclaration,
  type Node,
  type ObjectLiteralExpression,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { parameterSources, type MetadataSource } from './input-bindings.ts';
import { metadataInitializer } from './input-callees.ts';
import {
  type MemberAccess,
  memberAccessKey,
  PROTO_KEY,
  receiverMemberSources,
  receiverSlotReads,
  SAFE_INSPECTORS,
  wrappedExpression,
} from './input-receiver-members.ts';
import { literalPropertyName, selected } from './input-selections.ts';
import { targetsOf } from './kept.ts';
import { isTypeOnly, readsBinding } from './scope.ts';
import { writtenBy } from './written.ts';

/** Member projections on proven fresh local or base-class receiver containers. */

type ContainerLiteral = ArrayLiteralExpression | ObjectLiteralExpression;

interface ContainerIndex {
  readonly bindingReads: ReadonlyMap<Node, readonly Identifier[]>;
  readonly reassignedBindings: ReadonlySet<Node>;
  readonly writtenMembers: ReadonlySet<Node>;
}

const CONTAINER_INDEX = new WeakMap<SourceFile, ContainerIndex>();

/** Candidate member values of a fresh local or receiver container read; undefined when unproven. */
export function memberSources(
  node: MemberAccess,
  source: MetadataSource,
): readonly MetadataSource[] | undefined {
  return memberValues(node, source, new Set(), containerIndexOf(node.getSourceFile()));
}

/** Resolves one member access across all proven fresh container candidates of its receiver. */
function memberValues(
  node: MemberAccess,
  source: MetadataSource,
  seen: ReadonlySet<Expression>,
  index: ContainerIndex,
): readonly MetadataSource[] | undefined {
  const key = memberAccessKey(node);
  if (key === undefined || key === PROTO_KEY) {
    return undefined;
  }
  const receiverExpr = unwrapped(node.expression);
  if (receiverExpr.kind === SyntaxKind.ThisKeyword) {
    return receiverMemberSources(receiverExpr, key, source, index.writtenMembers);
  }
  const receivers = holderValues(receiverExpr, source, seen, index);
  if (receivers === undefined) {
    return undefined;
  }
  const found: MetadataSource[] = [];
  for (const receiver of receivers) {
    const projected = selectContainerSlot(receiver, key, index);
    if (projected === undefined) {
      return undefined;
    }
    found.push(...projected);
  }
  return found;
}

/** Concrete literal containers an expression may evaluate to without retaining an outer input. */
function holderValues(
  value: Expression,
  source: MetadataSource,
  seen: ReadonlySet<Expression>,
  index: ContainerIndex,
): readonly MetadataSource[] | undefined {
  if (seen.has(value)) {
    return undefined;
  }
  const nextSeen = new Set([...seen, value]);
  if (isObjectLiteralExpression(value) || isArrayLiteralExpression(value)) {
    return [{ bindings: source.bindings, value }];
  }
  if (isConditionalExpression(value)) {
    const left = holderValues(unwrapped(value.whenTrue), source, nextSeen, index);
    const right = holderValues(unwrapped(value.whenFalse), source, nextSeen, index);
    return left === undefined || right === undefined ? undefined : [...left, ...right];
  }
  if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const members = memberValues(value, source, nextSeen, index);
    return members === undefined ? undefined : resolveCandidateHolders(members, nextSeen, index);
  }
  return isIdentifier(value) ? identifierHolders(value, source, nextSeen, index) : undefined;
}

/** Resolves a list of candidate expressions into concrete literal containers. */
function resolveCandidateHolders(
  candidates: readonly MetadataSource[],
  seen: ReadonlySet<Expression>,
  index: ContainerIndex,
): readonly MetadataSource[] | undefined {
  const holders: MetadataSource[] = [];
  for (const candidate of candidates) {
    const resolved = holderValues(unwrapped(candidate.value), candidate, seen, index);
    if (resolved === undefined) {
      return undefined;
    }
    holders.push(...resolved);
  }
  return holders;
}

/** Follows an identifier to its bound parameter argument or un-reassigned local initializer. */
function identifierHolders(
  name: Identifier,
  source: MetadataSource,
  seen: ReadonlySet<Expression>,
  index: ContainerIndex,
): readonly MetadataSource[] | undefined {
  const parameter = parameterSources(name, source);
  if (parameter === undefined) {
    const initializer = localInitializer(name, index);
    return initializer === undefined
      ? undefined
      : holderValues(unwrapped(initializer), { ...source, value: initializer }, seen, index);
  }
  if (parameter.present === true || parameter.sources === undefined) {
    return undefined;
  }
  return resolveCandidateHolders(parameter.sources, seen, index);
}

/** Initializer of a whole variable declaration that is never reassigned in the module. */
function localInitializer(name: Identifier, index: ContainerIndex): Expression | undefined {
  const constant = metadataInitializer(name);
  if (constant !== undefined) {
    return constant;
  }
  const declared = frameDeclarationOf(name);
  if (
    declared === undefined ||
    !isVariableDeclaration(declared) ||
    !isIdentifier(declared.name) ||
    index.reassignedBindings.has(declared)
  ) {
    return undefined;
  }
  return declared.initializer;
}

/** Selects `key` from a concrete literal container when no write or escape can have replaced it. */
function selectContainerSlot(
  receiver: MetadataSource,
  key: string,
  index: ContainerIndex,
): readonly MetadataSource[] | undefined {
  const container = unwrapped(receiver.value);
  if (!isObjectLiteralExpression(container) && !isArrayLiteralExpression(container)) {
    return undefined;
  }
  const entry = selected(container, key);
  const references = entry.unknown
    ? undefined
    : collectReferences(container, receiver.bindings, index);
  if (
    references === undefined ||
    !references.every((ref) => safeReferenceUse(ref, key, receiver.bindings, index))
  ) {
    return undefined;
  }
  return entry.value === undefined ? [] : [{ bindings: receiver.bindings, value: entry.value }];
}

/** Gathers every expression evaluating to `container`; returns undefined if `container` escapes. */
function collectReferences(
  container: ContainerLiteral,
  bindings: MetadataSource['bindings'],
  index: ContainerIndex,
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
    if (!expandReference(ref, bindings, index, pending)) {
      return undefined;
    }
  }
  return found;
}

/** Pushes downstream alias, parameter, conditional, receiver-slot, or outer-literal references. */
function expandReference(
  ref: Expression,
  bindings: MetadataSource['bindings'],
  index: ContainerIndex,
  pending: Expression[],
): boolean {
  if (!expandBoundParameters(ref, bindings, index, pending)) {
    return false;
  }
  const slotReads = receiverSlotReads(ref, index.writtenMembers);
  if (slotReads !== null) {
    if (slotReads === undefined) {
      return false;
    }
    pending.push(...slotReads);
    return true;
  }
  return expandLocalReference(ref, bindings, index, pending);
}

/** Expands variable/parameter initializers, conditional branches, and enclosing literal entries. */
function expandLocalReference(
  ref: Expression,
  bindings: MetadataSource['bindings'],
  index: ContainerIndex,
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
    pushReads(parent, index, pending);
    return true;
  }
  if (isConditionalExpression(parent) && (parent.whenTrue === ref || parent.whenFalse === ref)) {
    pending.push(wrappedExpression(parent));
    return true;
  }
  return expandNestedLiteral(ref, bindings, index, pending);
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

/** Pushes member reads on an outer literal when `ref` is stored inside that outer literal. */
function expandNestedLiteral(
  ref: Expression,
  bindings: MetadataSource['bindings'],
  index: ContainerIndex,
  pending: Expression[],
): boolean {
  const outer = enclosingLiteralEntry(ref);
  if (outer === undefined) {
    return true;
  }
  if (outer.key === undefined) {
    return false;
  }
  const outerRefs = collectReferences(outer.literal, bindings, index);
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

/** Verifies that `ref` is not escaped to unknown code and does not write `key` on `container`. */
function safeReferenceUse(
  ref: Expression,
  key: string,
  bindings: MetadataSource['bindings'],
  index: ContainerIndex,
): boolean {
  const parent = ref.parent;
  if (
    ((isVariableDeclaration(parent) || isParameterDeclaration(parent)) &&
      parent.initializer === ref) ||
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
    return safeMemberOnReference(parent, key, index);
  }
  return safeCallArgumentUse(ref, parent, bindings);
}

/** Rejects method calls on `ref` and member writes that may overwrite `key` or `__proto__`. */
function safeMemberOnReference(access: MemberAccess, key: string, index: ContainerIndex): boolean {
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
  return writtenKey !== undefined && writtenKey !== PROTO_KEY && writtenKey !== key;
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
function containerIndexOf(file: SourceFile): ContainerIndex {
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
  const built: ContainerIndex = { bindingReads, reassignedBindings, writtenMembers };
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
