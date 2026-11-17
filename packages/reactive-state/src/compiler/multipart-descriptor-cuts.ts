import {
  type CallExpression,
  type Expression,
  isBinaryExpression,
  isCallExpression,
  isIdentifier,
  SyntaxKind,
  type Node,
  type SourceFile,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { executionOwner } from './framed-array-mutations.ts';
import type { Held, HeldValues } from './framed-held-members.ts';
import {
  framedMemberWrites,
  framedPrototypeWrites,
  framedVariableWrites,
} from './framed-member-writes.ts';
import {
  holderDescriptorBodyWrites,
  plainBodyLiteralEntry,
  type RecordedDescriptorBodyWrite,
} from './multipart-descriptors.ts';
import { definitelyBefore, supersededBefore } from './multipart-readings.ts';

/** Definite variable-rebind and writable/configurable member-cut filtering for `body` descriptors. */

export interface PriorDescriptorCandidate {
  readonly configurableBody?: boolean | undefined;
  readonly descriptorWrite?: boolean | undefined;
  readonly node: Node;
  readonly writableBody?: boolean | undefined;
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

/** Collects active descriptor metadata, surviving descriptor values, and uncut prior `body` entries. */
export function resolveVariableDescriptorWrites(input: VariableDescriptorCutInput): {
  readonly activeMetadata: readonly RecordedDescriptorBodyWrite[];
  readonly activeValues: readonly RecordedDescriptorBodyWrite[];
  readonly extraHeld: readonly Held[];
} {
  const { declaration, holder, point, reaches, whole } = input;
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
  const canCutValues =
    declaration === holder &&
    whole.initial !== undefined &&
    whole.held.length === 0 &&
    !input.ambiguousPattern &&
    plainBodyLiteralEntry(whole.initial) &&
    activeMetadata.length > 0 &&
    framedPrototypeWrites(file).every(
      (proto) => proto.holder !== holder || proto.path.length > 0 || !reaches(proto.node),
    );
  const valueCuts = canCutValues ? definiteHolderBodyValueCuts(activeMetadata, input) : [];
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
  if (holder.initializer !== undefined && allCuts.length === 0) {
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
  owner: Node,
): boolean {
  return writes.every((prior) => {
    if (prior === write || prior.descriptorWrite !== true) {
      return true;
    }
    if (prior.node.pos > write.node.pos && executionOwner(prior.node) === owner) {
      return true;
    }
    return (write.descriptorWrite === true ? prior.configurableBody : prior.writableBody) === true;
  });
}

/** Collects definite `defineProperty`, `body = ...`, and `Object.assign` nodes able to overwrite prior descriptors. */
function definiteHolderBodyValueCuts(
  activeMetadata: readonly RecordedDescriptorBodyWrite[],
  input: VariableDescriptorCutInput,
): readonly Node[] {
  const { holder, point } = input;
  const owner = executionOwner(point);
  const cuts: Node[] = [];
  for (const desc of activeMetadata) {
    if (
      desc.exactBody &&
      definitelyBefore(desc.node, point) &&
      activeMetadata.every((prior) => {
        return (
          prior === desc ||
          (prior.node.pos > desc.node.pos && executionOwner(prior.node) === owner) ||
          prior.configurableBody
        );
      })
    ) {
      cuts.push(desc.node);
    }
  }
  for (const candidate of definiteMemberOrAssignBodyWrites(holder, point, input.overwritesAssign)) {
    const canOverwrite = activeMetadata.every((prior) => {
      return (
        (prior.node.pos > candidate.pos && executionOwner(prior.node) === owner) ||
        prior.writableBody
      );
    });
    if (canOverwrite) {
      cuts.push(candidate);
    }
  }
  return cuts;
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
