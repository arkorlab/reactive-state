import {
  type Expression,
  type Identifier,
  isCallExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isVariableDeclaration,
  type Node,
  type ObjectLiteralExpression,
  type PropertyName,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { framedHeldValues, type Held } from './framed-held-members.ts';
import {
  framedHeldVariable,
  framedMemberDeletes,
  framedMemberWrites,
  framedPrototypeWrites,
} from './framed-member-writes.ts';
import { framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';
import {
  inspectHeldPath,
  peeledMemberHolder,
  type ProjectionCallbacks,
} from './multipart-held-paths.ts';
import { constantValue } from './numbers.ts';

/** Dynamic computed-key destructuring container unfolding across aliases, spreads, and writes. */

interface DynamicScanContext {
  readonly callbacks: ProjectionCallbacks;
  readonly pending: Expression[];
  readonly values: Held[];
  readonly writeNode: Node;
}

const OBJECT_ASSIGN = 'Object.assign';

/** Collects candidate property values across dynamic-key object sources, noting any opaque container. */
export function resolveDynamicObjectSources(
  sources: readonly Held[],
  writeNode: Node,
  callbacks: ProjectionCallbacks,
): { readonly opaque: boolean; readonly values: readonly Held[] } {
  const context: DynamicScanContext = {
    callbacks,
    pending: [],
    values: [],
    writeNode,
  };
  let opaque = pushHeldContainers(sources, context);
  const visited = new Set<Expression>();
  for (let raw = context.pending.pop(); raw !== undefined; raw = context.pending.pop()) {
    const container = unwrapped(raw);
    if (visited.has(container)) {
      continue;
    }
    visited.add(container);
    if (inspectDynamicContainer(container, context)) {
      opaque = true;
    }
  }
  return { opaque, values: context.values };
}

/** Resolves a static property key name on an object literal or assignment pattern property. */
export function staticPropertyName(name: PropertyName): string | undefined {
  if (isIdentifier(name) || isStringLiteral(name) || isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  if (isNumericLiteral(name)) {
    return String(Number(name.text));
  }
  if (isComputedPropertyName(name)) {
    const constant = constantValue(name.expression);
    return typeof constant === 'string' || typeof constant === 'number'
      ? String(constant)
      : undefined;
  }
  return undefined;
}

/** Unfolds `Held` entries into container expressions, returning `true` if any path was unclosed. */
function pushHeldContainers(entries: readonly Held[], context: DynamicScanContext): boolean {
  let opaque = false;
  for (const entry of entries) {
    if (entry.keys.length === 0) {
      context.pending.push(entry.value);
      continue;
    }
    const resolved = inspectHeldPath(entry, context.writeNode, context.callbacks);
    if (!resolved.closed || resolved.ambiguous || resolved.typedFormData) {
      opaque = true;
    }
    context.pending.push(...resolved.expressions);
  }
  return opaque;
}

/** Inspects one unwrapped container expression for dynamic property reads, returning `true` if opaque. */
function inspectDynamicContainer(container: Expression, context: DynamicScanContext): boolean {
  const alternatives = context.callbacks.selectValues(container);
  if (alternatives !== undefined) {
    context.pending.push(...alternatives);
    return false;
  }
  if (isPropertyAccessExpression(container) || isElementAccessExpression(container)) {
    const peeled = peeledMemberHolder(container);
    return peeled === undefined || pushHeldContainers([peeled], context);
  }
  if (isObjectLiteralExpression(container)) {
    return inspectObjectLiteralContainer(container, context);
  }
  if (
    isCallExpression(container) &&
    globalPathOf(unwrapped(container.expression))?.join('.') === OBJECT_ASSIGN
  ) {
    return inspectObjectAssignContainer(container.arguments, context.pending);
  }
  if (isIdentifier(container)) {
    return inspectIdentifierContainer(container, context);
  }
  return true;
}

/** Collects property values, spreads, prototypes, and getter flags on an `ObjectLiteralExpression`. */
function inspectObjectLiteralContainer(
  object: ObjectLiteralExpression,
  context: DynamicScanContext,
): boolean {
  let opaque = false;
  for (const property of object.properties) {
    if (isPropertyAssignment(property)) {
      if (staticPropertyName(property.name) === '__proto__') {
        context.pending.push(property.initializer);
      } else {
        context.values.push({ keys: [], value: property.initializer });
      }
    } else if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
      context.values.push({ keys: [], value: property.name });
    } else if (isSpreadAssignment(property)) {
      context.pending.push(property.expression);
    } else if (isGetAccessorDeclaration(property)) {
      opaque = true;
    }
  }
  return opaque;
}

/** Pushes `Object.assign(...)` arguments onto `pending`, flagging spread argument lists as opaque. */
function inspectObjectAssignContainer(args: readonly Expression[], pending: Expression[]): boolean {
  if (args.length === 0) {
    return true;
  }
  let opaque = false;
  for (const arg of args) {
    if (isSpreadElement(arg)) {
      opaque = true;
    } else {
      pending.push(arg);
    }
  }
  return opaque;
}

/** Resolves a variable or parameter identifier acting as a dynamic-key destructuring container. */
function inspectIdentifierContainer(id: Identifier, context: DynamicScanContext): boolean {
  const selected = frameBindingOf(id);
  if (selected === undefined) {
    return true;
  }
  if (selected.keys.length > 0) {
    context.pending.push(...context.callbacks.bindingDefaults(id, selected.binding.name));
  }
  if (isVariableDeclaration(selected.binding)) {
    return inspectVariableContainer(id, selected.binding, selected.keys.length === 0, context);
  }
  if (!isParameterDeclaration(selected.binding)) {
    return true;
  }
  const resolved = context.callbacks.readParameter(id, selected.binding);
  const sourcesOpaque = pushHeldContainers(resolved.sources, context);
  return (
    !resolved.replaced ||
    resolved.ambiguous === true ||
    resolved.dynamicOpaque === true ||
    sourcesOpaque
  );
}

/** Collects held values, pattern reassignments, and member writes on a `VariableDeclaration` container. */
function inspectVariableContainer(
  id: Identifier,
  declaration: VariableDeclaration,
  directBinding: boolean,
  context: DynamicScanContext,
): boolean {
  const held = framedHeldValues(id, [], context.writeNode);
  if (held === undefined) {
    return true;
  }
  const patternScan = context.callbacks.readVariablePattern(id, declaration, context.writeNode);
  const entries = [
    ...(held.initial === undefined ? [] : [held.initial]),
    ...held.held,
    ...patternScan.extraSources,
  ];
  let opaque =
    patternScan.dynamicOpaque || entries.length === 0 || pushHeldContainers(entries, context);
  if (!directBinding) {
    return opaque;
  }
  const holder = framedHeldVariable(declaration);
  const file = id.getSourceFile();
  for (const write of framedMemberWrites(file)) {
    if (
      write.holder === holder &&
      write.path.length === 1 &&
      reachesContainerPoint(write.node, id, declaration, context.writeNode)
    ) {
      context.values.push({ keys: [], value: write.value });
    }
  }
  for (const proto of framedPrototypeWrites(file)) {
    if (
      proto.holder === holder &&
      proto.path.length === 0 &&
      reachesContainerPoint(proto.node, id, declaration, context.writeNode)
    ) {
      context.pending.push(proto.value);
    }
  }
  const handedOff = framedMemberDeletes(file).some((each) => {
    return (
      each.holder === holder &&
      each.handed &&
      each.path.length === 0 &&
      reachesContainerPoint(each.node, id, declaration, context.writeNode)
    );
  });
  if (handedOff) {
    opaque = true;
  }
  return opaque;
}

/** Whether a mutation on `declaration` may execute before `point`. */
function reachesContainerPoint(
  change: Node,
  id: Identifier,
  declaration: VariableDeclaration,
  point: Node,
): boolean {
  if (!framedPossibleBranch(change)) {
    return false;
  }
  const owner = executionOwner(point);
  if (
    executionOwner(change) !== owner ||
    change.pos < point.pos ||
    destructuredFirst(change, point)
  ) {
    return true;
  }
  return repeatedFrameRead(change, id, declaration, owner);
}
