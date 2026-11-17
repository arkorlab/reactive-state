import {
  type BinaryExpression,
  type CallExpression,
  type Expression,
  type Identifier,
  isBinaryExpression,
  isCallExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isVariableDeclaration,
  type Node,
  type ParameterDeclaration,
  type SourceFile,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf } from './framed-bindings.ts';
import type { Held, HeldValues } from './framed-held-members.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedLiteralAccessor } from './framed-member-accessors.ts';
import {
  framedHeldVariable,
  framedMemberDeletes,
  framedMemberWrites,
  framedPrototypeWrites,
  framedVariableWrites,
} from './framed-member-writes.ts';
import { framedLiteralPrototypes } from './framed-object-members.ts';
import { repeatedFrameRead } from './framed-writes.ts';
import {
  holderDescriptorBodyWrites,
  literalDefinesOwnBody,
  plainBodyLiteralEntry,
  type RecordedDescriptorBodyWrite,
} from './multipart-descriptors.ts';
import {
  bindingTypedAtMemberPath,
  definitelyBefore,
  opaqueBodyLeaf,
  supersededBefore,
} from './multipart-readings.ts';
import { isTypeOnly } from './scope.ts';

/** Definite variable-rebind and writable/configurable member-cut filtering for `body` descriptors. */

export interface PriorDescriptorCandidate {
  readonly configurableBody?: boolean | undefined;
  readonly descriptorWrite?: boolean | undefined;
  readonly node: Node;
  readonly preservesConfigurable?: boolean | undefined;
  readonly preservesWritable?: boolean | undefined;
  readonly writableBody?: boolean | undefined;
}

export interface DescriptorCutContext {
  readonly establishedBefore: (node: Node) => boolean;
  readonly initialOwnBody: boolean;
  readonly mayDelete: boolean;
  readonly owner: Node;
  readonly target: Node;
}

export interface VariableDescriptorCutInput {
  readonly ambiguousPattern: boolean;
  readonly declaration: VariableDeclaration;
  readonly holder: VariableDeclaration;
  readonly overwritesAssign: (call: CallExpression, sources: readonly Expression[]) => boolean;
  readonly point: Node;
  readonly reaches: (change: Node) => boolean;
  readonly whole: HeldValues;
}

const BODY_KEY = 'body';
const DEFINE_PROPERTY = 'Object.defineProperty';
const OBJECT_ASSIGN = 'Object.assign';
const LOCKING_CALLS: ReadonlySet<string> = new Set([
  'Object.freeze',
  'Object.preventExtensions',
  'Object.seal',
  'Reflect.preventExtensions',
]);

/** Whether `node` is a fresh object literal without an accessor or prototype intercepting `body`. */
export function freshBodyObject(node: Expression): boolean {
  const value = unwrapped(node);
  return (
    isObjectLiteralExpression(value) &&
    !framedLiteralAccessor(value, BODY_KEY) &&
    (framedLiteralPrototypes(value).length === 0 || literalDefinesOwnBody(value))
  );
}

/** Whether `name`'s declared `'body'` type names `FormData` while surviving `bodies` carry an opaque leaf. */
export function opaqueTypedHolderBodies(
  name: Identifier,
  bodies: readonly Expression[],
  point: Node,
): boolean {
  return (
    bindingTypedAtMemberPath(name, [BODY_KEY]) && bodies.some((each) => opaqueBodyLeaf(each, point))
  );
}

/** Builds a `DescriptorCutContext` for a parameter replaced by a sole fresh object literal. */
export function parameterDescriptorCutContext<
  T extends PriorDescriptorCandidate & { readonly capture: Identifier },
>(input: {
  readonly freshCut: BinaryExpression;
  readonly mayDelete: boolean;
  readonly overwrites: (write: T) => boolean;
  readonly owner: Node;
  readonly parameter: ParameterDeclaration;
  readonly sameCut: (capture: Identifier) => boolean;
  readonly writes: readonly T[];
}): DescriptorCutContext {
  const { freshCut, mayDelete, overwrites, owner, parameter, sameCut, writes } = input;
  const freshLiteral = unwrapped(freshCut.right);
  const initialOwnBody =
    isObjectLiteralExpression(freshLiteral) && literalDefinesOwnBody(freshLiteral);
  return {
    establishedBefore: (priorNode) => {
      return writes.some((earlier) => {
        return (
          earlier.descriptorWrite !== true &&
          sameCut(earlier.capture) &&
          overwrites(earlier) &&
          definitelyBefore(earlier.node, priorNode) &&
          writes.every((desc) => {
            return (
              desc.descriptorWrite !== true ||
              !mayPrecedeDescriptorWrite(desc.node, earlier.node, { owner, target: parameter })
            );
          })
        );
      });
    },
    initialOwnBody,
    mayDelete,
    owner,
    target: parameter,
  };
}

/** Collects active descriptor metadata, surviving descriptor values, and uncut prior `body` entries. */
export function resolveVariableDescriptorWrites(input: VariableDescriptorCutInput): {
  readonly activeMetadata: readonly RecordedDescriptorBodyWrite[];
  readonly activeValues: readonly RecordedDescriptorBodyWrite[];
  readonly extraHeld: readonly Held[];
} {
  const { declaration, holder, point, reaches } = input;
  const descriptorWrites = holderDescriptorBodyWrites(holder, reaches);
  if (descriptorWrites.length === 0) {
    return { activeMetadata: [], activeValues: [], extraHeld: [] };
  }
  const file = holder.getSourceFile();
  const rebindCuts =
    declaration === holder && isIdentifier(declaration.name)
      ? framedVariableWrites(file)
          .filter((write) => write.binding === declaration && definitelyBefore(write.node, point))
          .map((write) => write.node)
      : [];
  const activeMetadata = descriptorWrites.filter((desc) =>
    rebindCuts.every((cut) => !supersededBefore(desc.node, cut, point)),
  );
  const canCutValues = canCutHolderBodyValues(input, activeMetadata, file);
  const valueCuts = canCutValues ? definiteHolderBodyValueCuts(activeMetadata, input, file) : [];
  const activeValues = activeMetadata.filter((desc) =>
    valueCuts.every((cut) => cut === desc.node || !supersededBefore(desc.node, cut, point)),
  );
  const extraHeld = uncutVariableBodyHeld({
    allCuts: [...rebindCuts, ...valueCuts],
    declaration,
    file,
    holder,
    point,
    reaches,
  });
  return { activeMetadata, activeValues, extraHeld };
}

/** Whether `holder` is a single un-locked plain object literal whose `body` cuts can be proven. */
function canCutHolderBodyValues(
  input: VariableDescriptorCutInput,
  activeMetadata: readonly RecordedDescriptorBodyWrite[],
  file: SourceFile,
): boolean {
  const { declaration, holder, reaches, whole } = input;
  if (
    declaration !== holder ||
    whole.initial === undefined ||
    whole.held.length > 0 ||
    input.ambiguousPattern ||
    !plainBodyLiteralEntry(whole.initial) ||
    activeMetadata.length === 0 ||
    !freshBodyObject(whole.initial.value)
  ) {
    return false;
  }
  const noProtoWrite = framedPrototypeWrites(file).every(
    (proto) => proto.holder !== holder || proto.path.length > 0 || !reaches(proto.node),
  );
  return noProtoWrite && !holderMayBeLocked(file, holder, reaches);
}

/** Retains initializer and non-descriptor `body` writes not genuinely cut by `allCuts`. */
function uncutVariableBodyHeld(context: {
  readonly allCuts: readonly Node[];
  readonly declaration: VariableDeclaration;
  readonly file: SourceFile;
  readonly holder: VariableDeclaration;
  readonly point: Node;
  readonly reaches: (change: Node) => boolean;
}): readonly Held[] {
  const { allCuts, declaration, file, holder, point, reaches } = context;
  if (!isIdentifier(declaration.name)) {
    return [];
  }
  const kept: Held[] = [];
  const initializerCut = allCuts.some(
    (cut) =>
      supersededBefore(holder, cut, point) || executionOwner(holder) !== executionOwner(point),
  );
  if (!initializerCut && holder.initializer !== undefined) {
    kept.push({ keys: [BODY_KEY], value: holder.initializer });
  }
  for (const write of framedMemberWrites(file)) {
    if (!eligibleNonDescriptorBodyWrite(write, holder, reaches)) {
      continue;
    }
    if (allCuts.every((cut) => cut === write.node || !supersededBefore(write.node, cut, point))) {
      kept.push({ keys: [], value: write.value });
    }
  }
  return kept;
}

/** Whether `write` is a reachable non-`Object.defineProperty` member write that may write `body` on `holder`. */
function eligibleNonDescriptorBodyWrite(
  write: ReturnType<typeof framedMemberWrites>[number],
  holder: VariableDeclaration,
  reaches: (change: Node) => boolean,
): boolean {
  if (
    write.holder !== holder ||
    write.path.length !== 1 ||
    write.path[0]?.includes(BODY_KEY) === false
  ) {
    return false;
  }
  if (
    isCallExpression(write.node) &&
    globalPathOf(unwrapped(write.node.expression))?.join('.') === DEFINE_PROPERTY
  ) {
    return false;
  }
  return reaches(write.node);
}

/** Ensures earlier descriptor writes allow `write` to overwrite or reconfigure `body`. */
export function canCutPriorDescriptors(
  write: PriorDescriptorCandidate,
  writes: readonly PriorDescriptorCandidate[],
  context: DescriptorCutContext,
): boolean {
  const relevant = writes.filter((prior) => {
    return (
      prior !== write &&
      prior.descriptorWrite === true &&
      mayPrecedeDescriptorWrite(prior.node, write.node, context)
    );
  });
  if (relevant.length === 0) {
    return true;
  }
  if (write.descriptorWrite === true) {
    return (
      attributeProvenTrue(relevant, write.node, context, 'configurable') ||
      attributeProvenTrue(relevant, write.node, context, 'writable')
    );
  }
  return attributeProvenTrue(relevant, write.node, context, 'writable');
}

/** Whether `priorNode` may run before `writeNode` in another owner, earlier, or around a loop. */
function mayPrecedeDescriptorWrite(
  priorNode: Node,
  writeNode: Node,
  context: Pick<DescriptorCutContext, 'owner' | 'target'>,
): boolean {
  return (
    executionOwner(priorNode) !== context.owner ||
    priorNode.pos < writeNode.pos ||
    repeatedFrameRead(priorNode, writeNode, context.target, context.owner)
  );
}

/** Proves `configurable` or `writable` holds at `writeNode` across all `relevant` descriptors. */
function attributeProvenTrue(
  relevant: readonly PriorDescriptorCandidate[],
  writeNode: Node,
  context: DescriptorCutContext,
  kind: 'configurable' | 'writable',
): boolean {
  const setsTrue = (item: PriorDescriptorCandidate): boolean =>
    (kind === 'configurable' ? item.configurableBody : item.writableBody) === true;
  const preserves = (item: PriorDescriptorCandidate): boolean =>
    (kind === 'configurable' ? item.preservesConfigurable : item.preservesWritable) === true;

  const latestReset = latestDefiniteAttributeReset(relevant, writeNode, setsTrue);
  if (
    latestReset !== undefined &&
    preservedAfterReset(relevant, latestReset, writeNode, { context, preserves, setsTrue })
  ) {
    return true;
  }
  return relevant.every((prior) => {
    if (!preserves(prior)) {
      return false;
    }
    return (
      setsTrue(prior) ||
      (!context.mayDelete && (context.initialOwnBody || context.establishedBefore(prior.node)))
    );
  });
}

/** Latest `definitelyBefore` descriptor in `relevant` that explicitly sets the attribute to `true`. */
function latestDefiniteAttributeReset(
  relevant: readonly PriorDescriptorCandidate[],
  writeNode: Node,
  setsTrue: (item: PriorDescriptorCandidate) => boolean,
): PriorDescriptorCandidate | undefined {
  let latest: PriorDescriptorCandidate | undefined;
  for (const item of relevant) {
    if (
      setsTrue(item) &&
      definitelyBefore(item.node, writeNode) &&
      (latest === undefined || item.node.pos > latest.node.pos)
    ) {
      latest = item;
    }
  }
  return latest;
}

/** Checks that every descriptor potentially running between `reset` and `writeNode` preserves the attribute. */
function preservedAfterReset(
  relevant: readonly PriorDescriptorCandidate[],
  reset: PriorDescriptorCandidate,
  writeNode: Node,
  checks: {
    readonly context: DescriptorCutContext;
    readonly preserves: (item: PriorDescriptorCandidate) => boolean;
    readonly setsTrue: (item: PriorDescriptorCandidate) => boolean;
  },
): boolean {
  const { context, preserves, setsTrue } = checks;
  return relevant.every((other) => {
    if (other === reset) {
      return true;
    }
    const mayFollowReset =
      executionOwner(other.node) !== context.owner ||
      other.node.pos > reset.node.pos ||
      repeatedFrameRead(other.node, writeNode, context.target, context.owner);
    if (!mayFollowReset) {
      return true;
    }
    return preserves(other) && (setsTrue(other) || !context.mayDelete);
  });
}

/** Collects definite `defineProperty`, `body = ...`, and `Object.assign` nodes able to overwrite prior descriptors. */
function definiteHolderBodyValueCuts(
  activeMetadata: readonly RecordedDescriptorBodyWrite[],
  input: VariableDescriptorCutInput,
  file: SourceFile,
): readonly Node[] {
  const { holder, point, reaches, whole } = input;
  const owner = executionOwner(point);
  const initValue = whole.initial === undefined ? undefined : unwrapped(whole.initial.value);
  const initialOwnBody =
    initValue !== undefined &&
    isObjectLiteralExpression(initValue) &&
    literalDefinesOwnBody(initValue);
  const mayDelete = holderMayDeleteBody(file, holder, reaches);
  const memberOrAssignWrites = definiteMemberOrAssignBodyWrites(
    holder,
    point,
    input.overwritesAssign,
  );
  const candidates = activeMetadata.map((desc) => ({ ...desc, descriptorWrite: true }));
  const cutContext: DescriptorCutContext = {
    establishedBefore: (priorNode) => {
      return memberOrAssignWrites.some((earlier) => {
        return (
          definitelyBefore(earlier, priorNode) &&
          candidates.every(
            (desc) => !mayPrecedeDescriptorWrite(desc.node, earlier, { owner, target: holder }),
          )
        );
      });
    },
    initialOwnBody,
    mayDelete,
    owner,
    target: holder,
  };
  const cuts: Node[] = [];
  for (const candidate of candidates) {
    const matchingDesc = activeMetadata.find((desc) => desc.node === candidate.node);
    if (
      matchingDesc?.exactBody === true &&
      definitelyBefore(candidate.node, point) &&
      canCutPriorDescriptors(candidate, candidates, cutContext)
    ) {
      cuts.push(candidate.node);
    }
  }
  for (const writeNode of memberOrAssignWrites) {
    if (canCutPriorDescriptors({ node: writeNode }, candidates, cutContext)) {
      cuts.push(writeNode);
    }
  }
  return cuts;
}

/** Whether any reachable deletion or whole-object hand-off on `holder` may remove `'body'`. */
export function holderMayDeleteBody(
  file: SourceFile,
  holder: VariableDeclaration,
  reaches: (change: Node) => boolean,
): boolean {
  return framedMemberDeletes(file).some((each) => {
    if (each.holder !== holder || !reaches(each.node)) {
      return false;
    }
    return each.handed
      ? each.path.length === 0
      : each.path.length === 1 && each.path[0]?.includes(BODY_KEY) !== false;
  });
}

/** Whether any reachable `Object.freeze`, `Object.seal`, or `preventExtensions` call targets `holder`. */
function holderMayBeLocked(
  file: SourceFile,
  holder: VariableDeclaration,
  reaches: (change: Node) => boolean,
): boolean {
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) {
      continue;
    }
    if (isCallExpression(node) && locksVariableHolder(node, holder) && reaches(node)) {
      return true;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Checks whether `call` is an object-locking builtin applied to `holder` (or a `const` alias). */
function locksVariableHolder(call: CallExpression, holder: VariableDeclaration): boolean {
  const path = globalPathOf(unwrapped(call.expression))?.join('.');
  if (path === undefined || !LOCKING_CALLS.has(path)) {
    return false;
  }
  const [target] = framedArgumentPrefix(call, call.arguments, 1).values;
  if (target === undefined) {
    return true;
  }
  const value = unwrapped(target);
  if (!isIdentifier(value)) {
    return false;
  }
  const selected = frameBindingOf(value);
  return (
    selected?.keys.length === 0 &&
    isVariableDeclaration(selected.binding) &&
    framedHeldVariable(selected.binding) === holder
  );
}

/** Definite `holder.body = ...` and overwriting `Object.assign(holder, ...)` sites before `point`. */
function definiteMemberOrAssignBodyWrites(
  holder: VariableDeclaration,
  point: Node,
  overwritesAssign: (call: CallExpression, sources: readonly Expression[]) => boolean,
): readonly Node[] {
  const found: Node[] = [];
  for (const write of framedMemberWrites(holder.getSourceFile())) {
    if (
      write.holder !== holder ||
      write.path.length !== 1 ||
      write.path[0]?.length !== 1 ||
      write.path[0][0] !== BODY_KEY ||
      !definitelyBefore(write.node, point)
    ) {
      continue;
    }
    if (isOverwritingBodyWriteNode(write.node, overwritesAssign)) {
      found.push(write.node);
    }
  }
  return found;
}

/** Whether `node` is `target.body = rhs` or an overwriting `Object.assign(target, ...)`. */
function isOverwritingBodyWriteNode(
  node: Node,
  overwritesAssign: (call: CallExpression, sources: readonly Expression[]) => boolean,
): boolean {
  if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken) {
    return true;
  }
  return (
    isCallExpression(node) &&
    globalPathOf(unwrapped(node.expression))?.join('.') === OBJECT_ASSIGN &&
    overwritesAssign(node, node.arguments.slice(1))
  );
}
