import {
  type BinaryExpression,
  type CallExpression,
  type Expression,
  type Identifier,
  isBinaryExpression,
  isCallExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  type NewExpression,
  type Node,
  type ParameterDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { framedArgumentPrefix, framedKeyNames, framedMemberNames } from './framed-keys.ts';
import { framedLiteralAccessor } from './framed-member-accessors.ts';
import { repeatedFrameRead } from './framed-writes.ts';
import { mapDescriptorBodyWrite, singleDescriptorBodyWrite } from './multipart-descriptors.ts';
import {
  type BodyReading,
  definitelyBefore,
  parameterCaptureOf,
  type ParameterResolution,
  parameterValues,
  reachesPoint,
  resolveHeldExpressions,
  supersededBefore,
  uniqueExpressions,
} from './multipart-readings.ts';
import { isTypeOnly } from './scope.ts';

/** Request options and body tracking across reassigned and mutated parameters. */

export interface OptionsReader {
  readonly readAssign: (
    call: CallExpression,
    sources: readonly Expression[],
    at: Node,
  ) => BodyReading;
  readonly readOptions: (value: Expression, at: Node) => BodyReading;
}

interface ParameterBodyWrite {
  readonly assignCall?: CallExpression;
  readonly assignSources?: readonly Expression[];
  readonly capture: Identifier;
  readonly descriptorWrite?: boolean;
  readonly enumerableBody: boolean;
  readonly exactBody: boolean;
  readonly mayHideBody: boolean;
  readonly node: Node;
  readonly values: readonly Expression[];
}

interface CutContext {
  readonly cut: Node | undefined;
  readonly name: Identifier;
  readonly parameter: ParameterDeclaration;
  readonly point: Node;
  readonly soleFreshCut: BinaryExpression | undefined;
}

const BODY_KEY = 'body';
const DEFINE_PROPERTIES = 'Object.defineProperties';
const DEFINE_PROPERTY = 'Object.defineProperty';
const DELETE_PROPERTY = 'Reflect.deleteProperty';
const OBJECT_ASSIGN = 'Object.assign';
const REFLECT_DEFINE_PROPERTY = 'Reflect.defineProperty';
const DEFINED = { slots: 3 } as const;

const MEMBER_WRITE_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** Possible request bodies carried by a reassigned, defaulted, or member-mutated options parameter. */
export function parameterBodies(
  name: Identifier,
  parameter: ParameterDeclaration,
  point: Node,
  reader: OptionsReader,
): BodyReading {
  const resolved = parameterValues(name, parameter);
  const baseContext = buildCutContext(name, parameter, point, resolved);
  const writes = collectParameterBodyWrites(baseContext);
  const memberCut = definiteBodyMemberCut(baseContext, writes, reader);
  if (memberCut !== undefined) {
    return cutMemberReading(baseContext, memberCut, writes, reader);
  }
  const sourceValues = resolved.sources.flatMap((each) => resolveHeldExpressions(each, point));
  const wholeValues =
    resolved.replaced || parameter.initializer === undefined
      ? sourceValues
      : [parameter.initializer, ...sourceValues];
  const wholeReadings = wholeValues.map((each) => reader.readOptions(each, each));
  const memberBodies = writes.flatMap((each) => writeBodies(each, reader));
  const deleted = resolved.replaced && hasReachableBodyDelete(baseContext);
  const hidden = writes.some((each) => each.mayHideBody);
  return {
    bodies: uniqueExpressions([...wholeReadings.flatMap((each) => each.bodies), ...memberBodies]),
    overwrites:
      resolved.replaced &&
      resolved.ambiguous !== true &&
      !deleted &&
      !hidden &&
      wholeReadings.length > 0 &&
      wholeReadings.every((each) => each.overwrites),
  };
}

/** Whether a parameter target of `Object.assign` may already hold a non-enumerable `body`. */
export function parameterMayHideBody(
  name: Identifier,
  parameter: ParameterDeclaration,
  point: Node,
): boolean {
  const resolved = parameterValues(name, parameter);
  if (!resolved.replaced || resolved.ambiguous === true) {
    return true;
  }
  if (resolved.values.some((each) => !freshBodyObject(each))) {
    return true;
  }
  const context = buildCutContext(name, parameter, point, resolved);
  return collectParameterBodyWrites(context).some((each) => each.mayHideBody);
}

/** Builds the cut-tracking context for one parameter read site. */
function buildCutContext(
  name: Identifier,
  parameter: ParameterDeclaration,
  point: Node,
  resolved: ParameterResolution,
): CutContext {
  return {
    cut: resolved.cut,
    name,
    parameter,
    point,
    soleFreshCut: soleFreshReplacement(resolved),
  };
}

/** Surviving bodies and spread-overwrite proof after a definite `body` member cut. */
function cutMemberReading(
  baseContext: CutContext,
  memberCut: ParameterBodyWrite,
  writes: readonly ParameterBodyWrite[],
  reader: OptionsReader,
): BodyReading {
  const afterCut = writes.filter(
    (each) => each === memberCut || !supersededBefore(each.node, memberCut.node, baseContext.point),
  );
  const deleted = hasReachableBodyDelete({ ...baseContext, cut: memberCut.node });
  const hidden =
    memberCut.descriptorWrite === true
      ? afterCut.some((each) => each.mayHideBody)
      : writes.some((each) => each.mayHideBody);
  return {
    bodies: uniqueExpressions(afterCut.flatMap((each) => writeBodies(each, reader))),
    overwrites: !deleted && !hidden && definitelyEnumerableBody(memberCut, reader),
  };
}

/** Body expressions contributed by one parameter member write or `Object.assign` call. */
function writeBodies(write: ParameterBodyWrite, reader: OptionsReader): readonly Expression[] {
  if (write.assignCall !== undefined) {
    return reader.readAssign(write.assignCall, write.assignSources ?? [], write.node).bodies;
  }
  return write.values;
}

/** Single fresh replacement assignment when no later write can rebind `parameter`. */
function soleFreshReplacement(resolved: ParameterResolution): BinaryExpression | undefined {
  return resolved.cut !== undefined &&
    resolved.ambiguous !== true &&
    resolved.values.length === 1 &&
    freshBodyObject(resolved.cut.right)
    ? resolved.cut
    : undefined;
}

/** Finds the latest definite exact-`body` member write on the same fresh parameter replacement. */
function definiteBodyMemberCut(
  context: CutContext,
  writes: readonly ParameterBodyWrite[],
  reader: OptionsReader,
): ParameterBodyWrite | undefined {
  const freshCut = context.soleFreshCut;
  if (freshCut === undefined) {
    return undefined;
  }
  let latest: ParameterBodyWrite | undefined;
  for (const write of writes) {
    if (
      capturesSameFreshCut(write.capture, freshCut, context.parameter) &&
      definitelyOverwritesBody(write, reader) &&
      definitelyBefore(write.node, context.point) &&
      (latest === undefined || write.node.pos > latest.node.pos)
    ) {
      latest = write;
    }
  }
  return latest;
}

/** Whether `capture` definitely reads the exact replacement `cut` with no intervening rebinding. */
function capturesSameFreshCut(
  capture: Identifier,
  cut: BinaryExpression,
  parameter: ParameterDeclaration,
): boolean {
  const atCapture = parameterValues(capture, parameter);
  return atCapture.cut === cut && atCapture.ambiguous !== true && atCapture.values.length === 1;
}

/** Whether a member write unconditionally replaces the `body` property when read directly. */
function definitelyOverwritesBody(write: ParameterBodyWrite, reader: OptionsReader): boolean {
  if (write.assignCall !== undefined) {
    return reader.readAssign(write.assignCall, write.assignSources ?? [], write.node).overwrites;
  }
  return write.exactBody;
}

/** Whether a member write establishes an enumerable `body` when no prior descriptor hid it. */
function definitelyEnumerableBody(write: ParameterBodyWrite, reader: OptionsReader): boolean {
  if (write.assignCall !== undefined) {
    return reader.readAssign(write.assignCall, write.assignSources ?? [], write.node).overwrites;
  }
  return write.enumerableBody;
}

/** Whether `node` is a fresh object literal without an accessor intercepting `body`. */
function freshBodyObject(node: Expression): boolean {
  const value = unwrapped(node);
  return isObjectLiteralExpression(value) && !framedLiteralAccessor(value, BODY_KEY);
}

/** Collects reachable member writes to `body` on `parameter` (or whole `const` aliases) after `cut`. */
function collectParameterBodyWrites(context: CutContext): readonly ParameterBodyWrite[] {
  const found: ParameterBodyWrite[] = [];
  const pending: Node[] = [context.parameter.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) {
      continue;
    }
    const write = parameterBodyWriteAt(node, context.parameter);
    if (
      write !== undefined &&
      activeCapture(write.capture, context) &&
      activeAtRead(write.node, context)
    ) {
      found.push(write);
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return found;
}

/** Extracts a `body`-affecting write on `parameter` from an assignment or `Object` mutator call. */
function parameterBodyWriteAt(
  node: Node,
  parameter: ParameterDeclaration,
): ParameterBodyWrite | undefined {
  if (isBinaryExpression(node) && MEMBER_WRITE_OPERATORS.has(node.operatorToken.kind)) {
    return binaryParameterBodyWrite(node, parameter);
  }
  return isCallExpression(node) ? callParameterBodyWrite(node, parameter) : undefined;
}

/** Extracts `options.body = rhs`, `options[key] = rhs`, or logical member assignments on `parameter`. */
function binaryParameterBodyWrite(
  node: BinaryExpression,
  parameter: ParameterDeclaration,
): ParameterBodyWrite | undefined {
  const target = unwrapped(node.left);
  if (!isPropertyAccessExpression(target) && !isElementAccessExpression(target)) {
    return undefined;
  }
  const capture = parameterCaptureOf(target.expression, parameter);
  if (capture === undefined) {
    return undefined;
  }
  const names = framedMemberNames(target);
  if (names !== undefined && !names.includes(BODY_KEY)) {
    return undefined;
  }
  const exactBody =
    node.operatorToken.kind === SyntaxKind.EqualsToken &&
    names?.length === 1 &&
    names[0] === BODY_KEY;
  return {
    capture,
    enumerableBody: exactBody,
    exactBody,
    mayHideBody: false,
    node,
    values: [node.right],
  };
}

/** Extracts `Object.assign`, `Object.defineProperty`, `Reflect.defineProperty`, and `Object.defineProperties` writes. */
function callParameterBodyWrite(
  node: CallExpression,
  parameter: ParameterDeclaration,
): ParameterBodyWrite | undefined {
  const path = globalPathOf(unwrapped(node.expression))?.join('.');
  if (path === OBJECT_ASSIGN) {
    return objectAssignParameterWrite(node, parameter);
  }
  if (path === DEFINE_PROPERTY || path === REFLECT_DEFINE_PROPERTY) {
    return definePropertyBodyWrite(node, parameter, path === REFLECT_DEFINE_PROPERTY);
  }
  return path === DEFINE_PROPERTIES ? definePropertiesBodyWrite(node, parameter) : undefined;
}

/** Extracts `Object.assign(options, ...sources)` while keeping remaining spread sources intact. */
function objectAssignParameterWrite(
  node: CallExpression,
  parameter: ParameterDeclaration,
): ParameterBodyWrite | undefined {
  const [first, ...rest] = node.arguments;
  if (first === undefined) {
    return undefined;
  }
  if (isSpreadElement(first)) {
    const expanded = framedArgumentPrefix(node, [first], Infinity);
    const [target, ...leadingSources] = expanded.values;
    const capture =
      target === undefined || expanded.unknown ? undefined : parameterCaptureOf(target, parameter);
    const sources = [...leadingSources, ...rest];
    return capture !== undefined && sources.length > 0
      ? buildAssignParameterWrite(node, capture, sources)
      : undefined;
  }
  const capture = parameterCaptureOf(first, parameter);
  return capture !== undefined && rest.length > 0
    ? buildAssignParameterWrite(node, capture, rest)
    : undefined;
}

/** Constructs a `ParameterBodyWrite` record for `Object.assign` sources. */
function buildAssignParameterWrite(
  node: CallExpression,
  capture: Identifier,
  sources: readonly Expression[],
): ParameterBodyWrite {
  return {
    assignCall: node,
    assignSources: sources,
    capture,
    enumerableBody: false,
    exactBody: false,
    mayHideBody: false,
    node,
    values: [],
  };
}

/** Extracts `Object.defineProperty` / `Reflect.defineProperty` writes when `key` may name `body`. */
function definePropertyBodyWrite(
  node: CallExpression,
  parameter: ParameterDeclaration,
  reflective: boolean,
): ParameterBodyWrite | undefined {
  const [target, key, descriptor] = framedArgumentPrefix(
    node,
    node.arguments,
    DEFINED.slots,
  ).values;
  const capture = target === undefined ? undefined : parameterCaptureOf(target, parameter);
  if (capture === undefined) {
    return undefined;
  }
  const write = singleDescriptorBodyWrite(key, descriptor, reflective);
  return write === undefined ? undefined : { ...write, capture, descriptorWrite: true, node };
}

/** Extracts `Object.defineProperties(options, descriptors)` writes when `descriptors` may touch `body`. */
function definePropertiesBodyWrite(
  node: CallExpression,
  parameter: ParameterDeclaration,
): ParameterBodyWrite | undefined {
  const [target, descriptors] = framedArgumentPrefix(node, node.arguments).values;
  const capture = target === undefined ? undefined : parameterCaptureOf(target, parameter);
  if (capture === undefined) {
    return undefined;
  }
  const write = mapDescriptorBodyWrite(descriptors);
  return write === undefined ? undefined : { ...write, capture, descriptorWrite: true, node };
}

/** Checks whether any reachable deletion or non-global hand-off can remove `body` on `parameter`. */
function hasReachableBodyDelete(context: CutContext): boolean {
  const pending: Node[] = [context.parameter.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) {
      continue;
    }
    if (removesParameterBody(node, context) && activeAtRead(node, context)) {
      return true;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Whether `node` deletes `body` (or an unknown key) on `parameter` or hands `parameter` to unknown code. */
function removesParameterBody(node: Node, context: CutContext): boolean {
  if (isCallExpression(node) || isNewExpression(node)) {
    return callRemovesParameterBody(node, context);
  }
  if (!isDeleteExpression(node)) {
    return false;
  }
  const target = unwrapped(node.expression);
  if (!isPropertyAccessExpression(target) && !isElementAccessExpression(target)) {
    return false;
  }
  const names = framedMemberNames(target);
  return activeParameterTarget(target.expression, context) && names?.includes(BODY_KEY) !== false;
}

/** Checks `Reflect.deleteProperty(options, key)` and non-global calls receiving `options`. */
function callRemovesParameterBody(
  node: CallExpression | NewExpression,
  context: CutContext,
): boolean {
  const callee = unwrapped(node.expression);
  const native = globalPathOf(callee)?.join('.');
  if (native === DELETE_PROPERTY && isCallExpression(node)) {
    const [target, key] = framedArgumentPrefix(node, node.arguments).values;
    const names = key === undefined ? undefined : framedKeyNames(key);
    return (
      target !== undefined &&
      activeParameterTarget(target, context) &&
      names?.includes(BODY_KEY) !== false
    );
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
  return handed.some((each) => activeParameterTarget(each, context));
}

/** Whether `node` captures `parameter` and is not a pre-replacement alias of an old parameter value. */
function activeParameterTarget(node: Expression, context: CutContext): boolean {
  const capture = parameterCaptureOf(node, context.parameter);
  return capture !== undefined && activeCapture(capture, context);
}

/** Rejects aliases captured strictly before `soleFreshCut` when no loop repeats `soleFreshCut`. */
function activeCapture(capture: Identifier, context: CutContext): boolean {
  if (context.soleFreshCut === undefined) {
    return true;
  }
  if (!supersededBefore(capture, context.soleFreshCut, context.name)) {
    return true;
  }
  return repeatedFrameRead(
    context.soleFreshCut,
    capture,
    context.parameter,
    executionOwner(context.name),
  );
}

/** Whether `change` reaches `point` and was not superseded before `cut` in the same owner. */
function activeAtRead(change: Node, context: CutContext): boolean {
  if (!reachesPoint(change, context.name, context.parameter, context.point)) {
    return false;
  }
  return context.cut === undefined || !supersededBefore(change, context.cut, context.name);
}
