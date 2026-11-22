import {
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isVariableDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { type MetadataSource, parameterSources } from './input-bindings.ts';
import { metadataInitializer } from './input-callees.ts';
import {
  containedReferencesOf,
  type ContainerIndex,
  containerIndexOf,
  type ContainerWalkState,
  writesSelectedSlot,
} from './input-container-references.ts';
import {
  type MemberAccess,
  memberAccessKey,
  PROTO_KEY,
  receiverMemberSources,
} from './input-receiver-members.ts';
import { selected } from './input-selections.ts';

/** Member projections on proven fresh local or base-class receiver containers. */

interface MemberLookupState extends ContainerWalkState {
  readonly seen: ReadonlySet<Expression>;
}

/** Candidate member values of a fresh local or receiver container read; undefined when unproven. */
export function memberSources(
  node: MemberAccess,
  source: MetadataSource,
): readonly MetadataSource[] | undefined {
  const state: MemberLookupState = {
    activeContainers: new Set(),
    cuts: { count: 0 },
    index: containerIndexOf(node.getSourceFile()),
    seen: new Set(),
  };
  return memberValues(node, source, state);
}

/** Resolves one member access across all proven fresh container candidates of its receiver. */
function memberValues(
  node: MemberAccess,
  source: MetadataSource,
  state: MemberLookupState,
): readonly MetadataSource[] | undefined {
  const key = memberAccessKey(node);
  if (key === undefined || key === PROTO_KEY) {
    return undefined;
  }
  const receiverExpr = unwrapped(node.expression);
  if (receiverExpr.kind === SyntaxKind.ThisKeyword) {
    return receiverMemberSources(receiverExpr, key, source, state.index.writtenMembers);
  }
  const receivers = holderValues(receiverExpr, source, state);
  if (receivers === undefined) {
    return undefined;
  }
  const found: MetadataSource[] = [];
  for (const receiver of receivers) {
    const projected = selectContainerSlot(receiver, key, state);
    if (projected === undefined) {
      return undefined;
    }
    found.push(...projected);
  }
  return uniqueMetadataSources(found);
}

/** Concrete literal containers an expression may evaluate to, memoized across cycle-free DAGs. */
function holderValues(
  value: Expression,
  source: MetadataSource,
  state: MemberLookupState,
): readonly MetadataSource[] | undefined {
  const byValue = cachedHolderMap(state.index, source.bindings);
  const cached = byValue.get(value);
  if (cached !== undefined) {
    return cached ?? undefined;
  }
  if (state.seen.has(value)) {
    state.cuts.count += 1;
    return undefined;
  }
  const cutsBefore = state.cuts.count;
  const nextState: MemberLookupState = { ...state, seen: new Set([...state.seen, value]) };
  const computed = computeHolderValues(value, source, nextState);
  if (state.cuts.count === cutsBefore) {
    byValue.set(value, computed ?? null);
  }
  return computed;
}

/** Per-binding memo table for resolved literal container holders. */
function cachedHolderMap(
  index: ContainerIndex,
  bindings: MetadataSource['bindings'],
): Map<Expression, readonly MetadataSource[] | null> {
  let byValue = index.holdersCache.get(bindings);
  if (byValue === undefined) {
    byValue = new Map();
    index.holdersCache.set(bindings, byValue);
  }
  return byValue;
}

/** Evaluates concrete container holders for `value` without consulting the memo table. */
function computeHolderValues(
  value: Expression,
  source: MetadataSource,
  state: MemberLookupState,
): readonly MetadataSource[] | undefined {
  if (isObjectLiteralExpression(value) || isArrayLiteralExpression(value)) {
    return [{ bindings: source.bindings, value }];
  }
  if (isConditionalExpression(value)) {
    const left = holderValues(unwrapped(value.whenTrue), source, state);
    const right = holderValues(unwrapped(value.whenFalse), source, state);
    return left === undefined || right === undefined
      ? undefined
      : uniqueMetadataSources([...left, ...right]);
  }
  if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const members = memberValues(value, source, state);
    return members === undefined ? undefined : resolveCandidateHolders(members, state);
  }
  return isIdentifier(value) ? identifierHolders(value, source, state) : undefined;
}

/** Resolves each candidate `MetadataSource` to its concrete literal container expressions. */
function resolveCandidateHolders(
  candidates: readonly MetadataSource[],
  state: MemberLookupState,
): readonly MetadataSource[] | undefined {
  const holders: MetadataSource[] = [];
  for (const candidate of candidates) {
    const resolved = holderValues(unwrapped(candidate.value), candidate, state);
    if (resolved === undefined) {
      return undefined;
    }
    holders.push(...resolved);
  }
  return uniqueMetadataSources(holders);
}

/** Deduplicates `MetadataSource` entries sharing identical `(bindings, value)` pairs. */
function uniqueMetadataSources(sources: readonly MetadataSource[]): readonly MetadataSource[] {
  if (sources.length <= 1) {
    return sources;
  }
  const seen = new Map<MetadataSource['bindings'], Set<Expression>>();
  const unique: MetadataSource[] = [];
  for (const each of sources) {
    let values = seen.get(each.bindings);
    if (values === undefined) {
      values = new Set();
      seen.set(each.bindings, values);
    }
    if (!values.has(each.value)) {
      values.add(each.value);
      unique.push(each);
    }
  }
  return unique;
}

/** Follows an identifier to its bound parameter argument or un-reassigned local initializer. */
function identifierHolders(
  name: Identifier,
  source: MetadataSource,
  state: MemberLookupState,
): readonly MetadataSource[] | undefined {
  const parameter = parameterSources(name, source);
  if (parameter === undefined) {
    const initializer = localInitializer(name, state.index);
    return initializer === undefined
      ? undefined
      : holderValues(unwrapped(initializer), { ...source, value: initializer }, state);
  }
  if (parameter.present === true || parameter.sources === undefined) {
    return undefined;
  }
  return resolveCandidateHolders(parameter.sources, state);
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

/** Selects `key` from a concrete literal container when no write, setter, or escape replaces it. */
function selectContainerSlot(
  receiver: MetadataSource,
  key: string,
  state: MemberLookupState,
): readonly MetadataSource[] | undefined {
  const container = unwrapped(receiver.value);
  if (!isObjectLiteralExpression(container) && !isArrayLiteralExpression(container)) {
    return undefined;
  }
  const entry = selected(container, key);
  const references = entry.unknown
    ? undefined
    : containedReferencesOf(container, receiver.bindings, state);
  if (
    references === undefined ||
    references.some((ref) => writesSelectedSlot(ref, key, state.index))
  ) {
    return undefined;
  }
  return entry.value === undefined ? [] : [{ bindings: receiver.bindings, value: entry.value }];
}
