import {
  type ClassDeclaration,
  type ClassExpression,
  isArrayLiteralExpression,
  isClassDeclaration,
  isClassExpression,
  isGetAccessorDeclaration,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import {
  EMPTY_NODE_SET,
  type ResolvedValue,
  returnedTargetsOf,
  type TargetContext,
  valueIdentityKey,
} from './statement-call-classes.ts';
import {
  ARRAY_SLICE_KIND,
  type Binding,
  type CallableNode,
  extendsExpressionOf,
  formatExcludedKeys,
  hasModifier,
  isCallableNode,
  isDeferredMember,
  isErasedOrAmbient,
  isProtoSetterProperty,
  nodeIdOf,
  OBJECT_REST_KIND,
  type ScopeTable,
} from './statement-call-scopes.ts';
import { resolveTargets } from './statement-call-targets.ts';
import { staticPropertyNameKey } from './statement-call-writes.ts';

export interface EscapeDriver {
  readonly activateCallable: (callable: CallableNode, receiver?: ResolvedValue) => void;
  readonly constructClass: (
    cls: ClassDeclaration | ClassExpression,
    instanceReceiver?: ResolvedValue,
  ) => void;
  readonly ctx: TargetContext;
  readonly isStopped: () => boolean;
  readonly scopes: ScopeTable;
  readonly watch: (watcherKey: string, run: (seenBindings: Set<Binding>) => void) => void;
  readonly wholeEscaped: Set<string>;
}

export function activateEscapedExpression(expr: Node, driver: EscapeDriver): void {
  driver.watch(`escape:${nodeIdOf(expr, driver.scopes)}`, (seenBindings) => {
    const targets = resolveTargets(expr, driver.ctx, EMPTY_NODE_SET, seenBindings);
    for (const target of targets) {
      activateWholeValue(target, driver);
    }
  });
}

export function activateWholeValue(value: ResolvedValue, driver: EscapeDriver): void {
  if (driver.isStopped()) {
    return;
  }
  if (value.kind === 'node' && isCallableNode(value.node)) {
    driver.activateCallable(value.node, value.receiver);
    return;
  }
  const visitKey = valueIdentityKey(value, driver.scopes);
  if (driver.wholeEscaped.has(visitKey)) {
    return;
  }
  driver.wholeEscaped.add(visitKey);
  switch (value.kind) {
    case 'instance': {
      activateWholeClass(value.cls, value.isPrototype === true, value, driver);
      return;
    }
    case 'super': {
      activateWholeValue(value.base, driver);
      return;
    }
    case ARRAY_SLICE_KIND: {
      activateWholeArraySlice(value.source, value.offset, driver);
      return;
    }
    case OBJECT_REST_KIND: {
      activateWholeObjectRest(value.source, value.excluded, driver);
      return;
    }
    case 'node': {
      activateWholeNode(value.node, driver);
    }
  }
}

function activateWholeNode(node: Node, driver: EscapeDriver): void {
  if (isClassDeclaration(node) || isClassExpression(node)) {
    activateWholeClass(node, false, { cls: node, kind: 'instance' }, driver);
  } else if (isObjectLiteralExpression(node)) {
    activateWholeObject(node, new Set(), true, driver);
  } else if (isArrayLiteralExpression(node)) {
    activateWholeArrayElements(node.elements, 0, driver);
  }
}

function activateWholeArraySlice(
  source: ResolvedValue,
  offset: number,
  driver: EscapeDriver,
): void {
  if (source.kind === 'node' && isArrayLiteralExpression(source.node)) {
    activateWholeArrayElements(source.node.elements, offset, driver);
  } else {
    activateWholeValue(source, driver);
  }
}

function activateWholeArrayElements(
  elements: readonly Node[],
  minOffset: number,
  driver: EscapeDriver,
): void {
  let fixedIndex = 0;
  let spreadSeen = false;
  for (const element of elements) {
    if (isSpreadElement(element)) {
      spreadSeen = true;
      activateEscapedExpression(element.expression, driver);
      continue;
    }
    if ((spreadSeen || fixedIndex >= minOffset) && !isOmittedExpression(element)) {
      activateEscapedExpression(element, driver);
    }
    fixedIndex += 1;
  }
}

function activateWholeObjectRest(
  source: ResolvedValue,
  excluded: ReadonlySet<string>,
  driver: EscapeDriver,
): void {
  if (source.kind === 'node' && isObjectLiteralExpression(source.node)) {
    activateWholeObject(source.node, new Set(excluded), false, driver);
  } else {
    activateWholeValue(source, driver);
  }
}

function isDataPropertyElement(property: ObjectLiteralElementLike): boolean {
  return (
    isMethodDeclaration(property) ||
    isPropertyAssignment(property) ||
    isShorthandPropertyAssignment(property)
  );
}

function activateWholeObject(
  object: ObjectLiteralExpression,
  shadowedKeys: Set<string>,
  includeProto: boolean,
  driver: EscapeDriver,
): void {
  const selfReceiver: ResolvedValue = { kind: 'node', node: object };
  for (let index = object.properties.length - 1; index >= 0; index -= 1) {
    const property = object.properties[index];
    if (property !== undefined) {
      stepWholeObjectProperty(property, { includeProto, selfReceiver, shadowedKeys }, driver);
    }
  }
}

function stepWholeObjectProperty(
  property: ObjectLiteralElementLike,
  frame: {
    readonly includeProto: boolean;
    readonly selfReceiver: ResolvedValue;
    readonly shadowedKeys: Set<string>;
  },
  driver: EscapeDriver,
): void {
  if (isProtoSetterProperty(property)) {
    if (frame.includeProto) {
      activateEscapedExpression(property.initializer, driver);
    }
    return;
  }
  if (isSpreadAssignment(property)) {
    activateObjectSpreadEscape(property.expression, new Set(frame.shadowedKeys), driver);
    return;
  }
  const key = staticPropertyNameKey(property.name, driver.scopes);
  if (key !== undefined && frame.shadowedKeys.has(key)) {
    return;
  }
  if (key !== undefined && isDataPropertyElement(property)) {
    frame.shadowedKeys.add(key);
  }
  activateWholeObjectProperty(property, frame.selfReceiver, frame.includeProto, driver);
}

function activateWholeObjectProperty(
  property: ObjectLiteralElementLike,
  selfReceiver: ResolvedValue,
  includeSetters: boolean,
  driver: EscapeDriver,
): void {
  if (isGetAccessorDeclaration(property)) {
    driver.activateCallable(property, selfReceiver);
    const returnedValues = returnedTargetsOf(property, driver.ctx, {
      receiver: selfReceiver,
      seenNodes: EMPTY_NODE_SET,
    });
    for (const returned of returnedValues) {
      activateWholeValue(returned, driver);
    }
  } else if (
    isMethodDeclaration(property) ||
    (includeSetters && isSetAccessorDeclaration(property))
  ) {
    driver.activateCallable(property, selfReceiver);
  } else if (isPropertyAssignment(property)) {
    activateEscapedExpression(property.initializer, driver);
  } else if (isShorthandPropertyAssignment(property)) {
    activateEscapedExpression(property.name, driver);
  }
}

function activateObjectSpreadEscape(
  spreadExpr: Node,
  excluded: ReadonlySet<string>,
  driver: EscapeDriver,
): void {
  const suffix = formatExcludedKeys(excluded);
  driver.watch(`spreadesc:${nodeIdOf(spreadExpr, driver.scopes)}:${suffix}`, (seenBindings) => {
    const targets = resolveTargets(spreadExpr, driver.ctx, EMPTY_NODE_SET, seenBindings);
    for (const target of targets) {
      activateWholeValue({ excluded, kind: OBJECT_REST_KIND, source: target }, driver);
    }
  });
}

function activateWholeClass(
  cls: ClassDeclaration | ClassExpression,
  isPrototype: boolean,
  instanceReceiver: ResolvedValue,
  driver: EscapeDriver,
): void {
  if (!isPrototype) {
    driver.constructClass(cls, instanceReceiver);
  }
  activateWholeClassBase(cls, isPrototype, instanceReceiver, driver);
  const staticReceiver: ResolvedValue = { kind: 'node', node: cls };
  for (const member of cls.members) {
    if (!isErasedOrAmbient(member)) {
      activateWholeClassMember(member, { instanceReceiver, isPrototype, staticReceiver }, driver);
    }
  }
}

function activateWholeClassBase(
  cls: ClassDeclaration | ClassExpression,
  isPrototype: boolean,
  instanceReceiver: ResolvedValue,
  driver: EscapeDriver,
): void {
  const baseExpr = extendsExpressionOf(cls);
  if (baseExpr === undefined) {
    return;
  }
  driver.watch(
    `clsesc:${nodeIdOf(baseExpr, driver.scopes)}:${isPrototype ? '1' : '0'}`,
    (seenBindings) => {
      for (const base of resolveTargets(baseExpr, driver.ctx, EMPTY_NODE_SET, seenBindings)) {
        if (
          base.kind === 'node' &&
          (isClassDeclaration(base.node) || isClassExpression(base.node))
        ) {
          activateWholeClass(base.node, isPrototype, instanceReceiver, driver);
        }
      }
    },
  );
}

function activateWholeClassMember(
  member: Node,
  receivers: {
    readonly instanceReceiver: ResolvedValue;
    readonly isPrototype: boolean;
    readonly staticReceiver: ResolvedValue;
  },
  driver: EscapeDriver,
): void {
  const memberReceiver = hasModifier(member, SyntaxKind.StaticKeyword)
    ? receivers.staticReceiver
    : receivers.instanceReceiver;
  if (isDeferredMember(member)) {
    driver.activateCallable(member, memberReceiver);
    if (isGetAccessorDeclaration(member)) {
      const returnedValues = returnedTargetsOf(member, driver.ctx, {
        receiver: memberReceiver,
        seenNodes: EMPTY_NODE_SET,
      });
      for (const returned of returnedValues) {
        activateWholeValue(returned, driver);
      }
    }
  } else if (
    !receivers.isPrototype &&
    isPropertyDeclaration(member) &&
    member.initializer !== undefined
  ) {
    activateEscapedExpression(member.initializer, driver);
  }
}
