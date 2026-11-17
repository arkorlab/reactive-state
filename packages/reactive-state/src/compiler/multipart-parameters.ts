import {
  type BinaryExpression,
  type CallExpression,
  type Expression,
  type Identifier,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  type Node,
  type ParameterDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { framedArgumentPrefix, framedMemberNames } from './framed-keys.ts';
import { repeatedFrameRead } from './framed-writes.ts';
import {
  canCutPriorDescriptors,
  freshBodyObject,
  opaqueTypedHolderBodies,
  parameterDescriptorCutContext,
} from './multipart-descriptor-cuts.ts';
import { mapDescriptorBodyWrite, singleDescriptorBodyWrite } from './multipart-descriptors.ts';
import {
  bindingDefaultsOf,
  nodeRemovesParameterBody,
  parameterCaptureOf,
} from './multipart-held-bindings.ts';
import {
  type BodyReading,
  definitelyBefore,
  type ParameterResolution,
  parameterValues,
  reachesPoint,
  resolveHeldReading,
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
  readonly assignCall?: CallExpression | undefined;
  readonly assignSources?: readonly Expression[] | undefined;
  readonly capture: Identifier;
  readonly configurableBody?: boolean | undefined;
  readonly descriptorWrite?: boolean | undefined;
  readonly enumerableBody: boolean;
  readonly exactBody: boolean;
  readonly mayHideBody: boolean;
  readonly node: Node;
  readonly preservesConfigurable?: boolean | undefined;
  readonly preservesWritable?: boolean | undefined;
  readonly values: readonly Expression[];
  readonly writableBody?: boolean | undefined;
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
  const sourceResolutions = resolved.sources.map((each) => resolveHeldReading(each, point, name));
  const initial =
    resolved.replaced && resolved.ambiguous !== true
      ? { ambiguous: false, expressions: [] as readonly Expression[] }
      : initialParameterValues(name, parameter, point);
  const wholeReadings = [
    ...initial.expressions,
    ...sourceResolutions.flatMap((each) => each.expressions),
  ].map((each) => reader.readOptions(each, each));
  const memberReadings = writes.map((each) => writeReading(each, reader));
  const deleted = resolved.replaced && hasReachableBodyDelete(baseContext);
  const hidden = writes.some((each) => each.mayHideBody);
  const bodies = uniqueExpressions([
    ...wholeReadings.flatMap((each) => each.bodies),
    ...memberReadings.flatMap((each) => each.bodies),
  ]);
  const ambiguous =
    initial.ambiguous ||
    sourceResolutions.some((each) => each.ambiguous || each.typedFormData) ||
    wholeReadings.some((each) => each.ambiguous === true) ||
    memberReadings.some((each) => each.ambiguous === true) ||
    opaqueTypedHolderBodies(name, bodies, point);
  return {
    ambiguous,
    bodies,
    overwrites:
      !ambiguous &&
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
  const afterReadings = afterCut.map((each) => writeReading(each, reader));
  const ambiguous = afterReadings.some((each) => each.ambiguous === true);
  return {
    ambiguous,
    bodies: uniqueExpressions(afterReadings.flatMap((each) => each.bodies)),
    overwrites: !ambiguous && !deleted && !hidden && definitelyEnumerableBody(memberCut, reader),
  };
}

/** Body reading contributed by one parameter member write or `Object.assign` call. */
function writeReading(write: ParameterBodyWrite, reader: OptionsReader): BodyReading {
  if (write.assignCall !== undefined) {
    return reader.readAssign(write.assignCall, write.assignSources ?? [], write.node);
  }
  return { bodies: write.values, overwrites: false };
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
  const cutContext = parameterDescriptorCutContext({
    freshCut,
    mayDelete: hasReachableBodyDelete(context),
    overwrites: (write) => definitelyOverwritesBody(write, reader),
    owner: executionOwner(context.point),
    parameter: context.parameter,
    sameCut: (capture) => capturesSameFreshCut(capture, freshCut, context.parameter),
    writes,
  });
  let latest: ParameterBodyWrite | undefined;
  for (const write of writes) {
    if (
      capturesSameFreshCut(write.capture, freshCut, context.parameter) &&
      definitelyOverwritesBody(write, reader) &&
      definitelyBefore(write.node, context.point) &&
      canCutPriorDescriptors(write, writes, cutContext) &&
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

/** Collects reachable member writes to `body` on `parameter` (or whole `const` aliases) after `cut`. */
/** Initial options expressions from a parameter's outer initializer and binding-pattern defaults. */
function initialParameterValues(
  name: Identifier,
  parameter: ParameterDeclaration,
  point: Node,
): { readonly ambiguous: boolean; readonly expressions: readonly Expression[] } {
  const keys = frameBindingOf(name)?.keys ?? [];
  const outer =
    parameter.initializer === undefined
      ? { ambiguous: false, expressions: [] as readonly Expression[], typedFormData: false }
      : resolveHeldReading({ keys, value: parameter.initializer }, point);
  const patternDefaults = keys.length === 0 ? [] : bindingDefaultsOf(name, parameter.name);
  return {
    ambiguous: outer.ambiguous || outer.typedFormData,
    expressions: [...outer.expressions, ...patternDefaults],
  };
}

function collectParameterBodyWrites(context: CutContext): readonly ParameterBodyWrite[] {
  const found: ParameterBodyWrite[] = [];
  const pending: Node[] = [context.parameter.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) {
      continue;
    }
    const write = parameterBodyWriteAt(node, context.parameter, context.name.text);
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
  bindingName: string,
): ParameterBodyWrite | undefined {
  if (isBinaryExpression(node) && MEMBER_WRITE_OPERATORS.has(node.operatorToken.kind)) {
    return binaryParameterBodyWrite(node, parameter, bindingName);
  }
  return isCallExpression(node) ? callParameterBodyWrite(node, parameter, bindingName) : undefined;
}

/** Extracts `options.body = rhs`, `options[key] = rhs`, or logical member assignments on `parameter`. */
function binaryParameterBodyWrite(
  node: BinaryExpression,
  parameter: ParameterDeclaration,
  bindingName: string,
): ParameterBodyWrite | undefined {
  const target = unwrapped(node.left);
  if (!isPropertyAccessExpression(target) && !isElementAccessExpression(target)) {
    return undefined;
  }
  const capture = parameterCaptureOf(target.expression, parameter, bindingName);
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
  bindingName: string,
): ParameterBodyWrite | undefined {
  const path = globalPathOf(unwrapped(node.expression))?.join('.');
  if (path === OBJECT_ASSIGN) {
    return objectAssignParameterWrite(node, parameter, bindingName);
  }
  if (path === DEFINE_PROPERTY || path === REFLECT_DEFINE_PROPERTY) {
    return definePropertyBodyWrite(node, parameter, path === REFLECT_DEFINE_PROPERTY, bindingName);
  }
  return path === DEFINE_PROPERTIES
    ? definePropertiesBodyWrite(node, parameter, bindingName)
    : undefined;
}

/** Extracts `Object.assign(options, ...sources)` while keeping remaining spread sources intact. */
function objectAssignParameterWrite(
  node: CallExpression,
  parameter: ParameterDeclaration,
  bindingName: string,
): ParameterBodyWrite | undefined {
  const [first, ...rest] = node.arguments;
  if (first === undefined) {
    return undefined;
  }
  if (isSpreadElement(first)) {
    const expanded = framedArgumentPrefix(node, [first], Infinity);
    const [target, ...leadingSources] = expanded.values;
    const capture =
      target === undefined || expanded.unknown
        ? undefined
        : parameterCaptureOf(target, parameter, bindingName);
    const sources = [...leadingSources, ...rest];
    return capture !== undefined && sources.length > 0
      ? buildAssignParameterWrite(node, capture, sources)
      : undefined;
  }
  const capture = parameterCaptureOf(first, parameter, bindingName);
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
  bindingName: string,
): ParameterBodyWrite | undefined {
  const [target, key, descriptor] = framedArgumentPrefix(
    node,
    node.arguments,
    DEFINED.slots,
  ).values;
  const capture =
    target === undefined ? undefined : parameterCaptureOf(target, parameter, bindingName);
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
  bindingName: string,
): ParameterBodyWrite | undefined {
  const [target, descriptors] = framedArgumentPrefix(node, node.arguments).values;
  const capture =
    target === undefined ? undefined : parameterCaptureOf(target, parameter, bindingName);
  if (capture === undefined) {
    return undefined;
  }
  const write = mapDescriptorBodyWrite(descriptors);
  return write === undefined ? undefined : { ...write, capture, descriptorWrite: true, node };
}

/** Checks whether any reachable deletion or non-global hand-off can remove `body` on `parameter`. */
function hasReachableBodyDelete(context: CutContext): boolean {
  const isTarget = (expr: Expression): boolean => activeParameterTarget(expr, context);
  const pending: Node[] = [context.parameter.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) {
      continue;
    }
    if (nodeRemovesParameterBody(node, isTarget) && activeAtRead(node, context)) {
      return true;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Whether `node` captures `parameter` and is not a pre-replacement alias of an old parameter value. */
function activeParameterTarget(node: Expression, context: CutContext): boolean {
  const capture = parameterCaptureOf(node, context.parameter, context.name.text);
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
