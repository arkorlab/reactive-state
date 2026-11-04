import {
  type CallExpression,
  type ClassDeclaration,
  type ClassExpression,
  type Expression,
  isArrayLiteralExpression,
  isBlock,
  isClassDeclaration,
  isClassExpression,
  isConstructorDeclaration,
  isPropertyDeclaration,
  isSourceFile,
  isVariableStatement,
  isArrowFunction,
  isFunctionExpression,
  isRegularExpressionLiteral,
  type Node,
  type Statement,
  SyntaxKind,
  isOmittedExpression,
  isObjectLiteralExpression,
  isSpreadElement,
} from 'typescript/ast';

import { calledMember, unwrapped } from './bounded.ts';
import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { metadataCallee, metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { expandedInvocation } from './throw-arguments.ts';
import { callbackKindsThrow } from './throw-brands.ts';
import { constructorTargetThrows } from './throw-callability.ts';
import { globalCalleePath } from './throw-callees.ts';
import { eagerClassOf } from './throw-classes.ts';
import { nativeCapabilitylessConstructor, quietNativeCall } from './throw-construct-only.ts';
import { isTypedKind, primitiveOf, writtenOf } from './throw-shapes.ts';

const PROMISE_FACTORIES: ReadonlySet<string> = new Set([
  'all',
  'allSettled',
  'any',
  'race',
  'reject',
  'resolve',
]);
const ORDINARY_CONSTRUCTORS: ReadonlySet<string> = new Set([
  'Array',
  'ArrayBuffer',
  'Boolean',
  'Date',
  'Error',
  'Function',
  'Map',
  'Number',
  'Object',
  'RegExp',
  'Set',
  'SharedArrayBuffer',
  'String',
]);

type OrdinaryClass = ClassDeclaration | ClassExpression;

interface Factory {
  readonly target: Expression;
  readonly path: string;
  readonly receiver: Expression | undefined;
  readonly given: readonly Expression[] | undefined;
  readonly reflected: boolean;
  readonly typed: boolean;
}

/** A forwarded native static factory's receiver; unknown constructor results remain unproven. */
export function staticFactoryThrows(
  node: CallExpression,
  outer: Resolve | undefined,
): boolean | undefined {
  const resolve: Resolve = (name) => outer?.(name) ?? metadataInitializer(name);
  const factory = factoryOf(node, resolve);
  if (factory === undefined) {
    return undefined;
  }
  if (!quietFactoryCall(node, factory, resolve) || factory.given === undefined) {
    return false;
  }
  const receiver = factory.receiver;
  if (receiver === undefined || constructorTargetThrows(receiver, resolve)) {
    return true;
  }
  const receiverPath = globalCalleePath(receiver, resolve)?.join('.') ?? '';
  if (
    (ORDINARY_CONSTRUCTORS.has(receiverPath) ||
      ordinaryClass(receiver, resolve) !== undefined ||
      (!factory.typed &&
        (isTypedKind(receiverPath) || nativeCapabilitylessConstructor(receiverPath)))) &&
    (factory.typed || needsCapability(factory, resolve))
  ) {
    return true;
  }
  return (
    factory.typed && callbackKindsThrow(factory.target, factory.path, factory.given, { resolve })
  );
}

/** Promise.resolve may return an existing promise before creating any capability. */
function needsCapability(factory: Factory, resolve: Resolve): boolean {
  if (factory.path !== 'Promise.resolve') {
    return true;
  }
  const input = factory.given?.[0];
  if (input === undefined) {
    return true;
  }
  const value = writtenOf(input, resolve);
  return (
    primitiveOf(value, resolve) !== undefined ||
    isArrayLiteralExpression(value) ||
    isObjectLiteralExpression(value) ||
    isRegularExpressionLiteral(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    isClassExpression(value)
  );
}

/** Only call/apply/Reflect.apply of an unchanged known native factory selects this rule. */
function factoryOf(node: CallExpression, resolve: Resolve): Factory | undefined {
  const call = expandedInvocation(node, resolve);
  if (call.arguments.some((each) => isSpreadElement(each))) {
    return undefined;
  }
  const callee = writtenOf(call.expression, resolve);
  const reflected = globalCalleePath(callee, resolve)?.join('.') === 'Reflect.apply';
  const member = calledMember(callee);
  if (!reflected && member?.name !== 'call' && member?.name !== 'apply') {
    return undefined;
  }
  const target = reflected ? call.arguments[0] : member?.of;
  const factory = target === undefined ? undefined : factoryTarget(target, resolve);
  if (target === undefined || factory === undefined || calleeUncertain(target, node)) {
    return undefined;
  }
  const receiverIndex = reflected ? 1 : 0;
  const listIndex = reflected ? 2 : 1;
  const given =
    !reflected && member?.name === 'call'
      ? call.arguments.slice(1)
      : appliedValues(call.arguments[listIndex], node, resolve);
  return { target, ...factory, receiver: call.arguments[receiverIndex], given, reflected };
}

/** The native factory target, before validating its receiver construction result. */
function factoryTarget(
  target: Expression,
  resolve: Resolve,
): { readonly path: string; readonly typed: boolean } | undefined {
  const path = globalCalleePath(target, resolve);
  if (path?.length !== 2) {
    return undefined;
  }
  const [brand = '', method = ''] = path;
  const typed = isTypedKind(brand) && (method === 'of' || method === 'from');
  return typed || (brand === 'Promise' && PROMISE_FACTORIES.has(method))
    ? { path: path.join('.'), typed }
    : undefined;
}

/** Apply-list getters, iterators and mutations may change the invocation before the native runs. */
function appliedValues(
  node: Expression | undefined,
  at: CallExpression,
  resolve: Resolve,
): readonly Expression[] | undefined {
  if (node === undefined || primitiveOf(node, resolve) === 'nothing') {
    return [];
  }
  const value = writtenOf(node, resolve);
  return isArrayLiteralExpression(value) &&
    !value.elements.some((each) => isSpreadElement(each) || isOmittedExpression(each)) &&
    !calleeUncertain(value, at)
    ? value.elements
    : undefined;
}

/** Known ordinary class definitions are quiet arguments; all other original evaluation guards remain. */
function quietFactoryCall(node: CallExpression, factory: Factory, resolve: Resolve): boolean {
  if (quietNativeCall(node, factory.path, resolve, factory.reflected)) {
    return true;
  }
  const source =
    factory.receiver === undefined ? undefined : ordinaryClass(factory.receiver, resolve);
  if (source === undefined || earlierExpressionEffect(node)) {
    return false;
  }
  const receiverIndex = factory.reflected ? 1 : 0;
  return (
    node.arguments.every((each, index) => {
      return (
        index === receiverIndex ||
        (factory.reflected && index === 0) ||
        !callbackCreationEffect(writtenOf(each, resolve))
      );
    }) && !priorClassEffect(node, source)
  );
}

/** A base class with no constructor work cannot provide a typed result or call a capability executor. */
function ordinaryClass(receiver: Expression, resolve: Resolve): OrdinaryClass | undefined {
  const source = metadataCallee(writtenOf(receiver, resolve));
  if (
    source === undefined ||
    (!isClassDeclaration(source) && !isClassExpression(source)) ||
    source.heritageClauses !== undefined ||
    decorated(source)
  ) {
    return undefined;
  }
  return emptyConstructor(source) && quietClassDefinition(source) ? source : undefined;
}

/** Only an absent constructor or a parameterless empty implementation proves no capability calls. */
function emptyConstructor(source: OrdinaryClass): boolean {
  const constructors = source.members.filter((member) => isConstructorDeclaration(member));
  const implementation = constructors.find((member) => member.body !== undefined);
  return (
    constructors.length === 0 ||
    (implementation?.parameters.length === 0 && implementation.body?.statements.length === 0)
  );
}

/** Computed keys, static blocks and effectful initialization remain application work. */
function quietClassDefinition(source: OrdinaryClass): boolean {
  const eager = eagerClassOf(source);
  return (
    eager?.keys.length === 0 &&
    eager.blocks.length === 0 &&
    eager.expressions.every((each) => !callbackCreationEffect(each)) &&
    source.members.every((member) => {
      return (
        !isPropertyDeclaration(member) ||
        member.initializer === undefined ||
        !callbackCreationEffect(member.initializer)
      );
    })
  );
}

/** Decorators and ambient class declarations do not establish the constructor eventually invoked. */
function decorated(source: OrdinaryClass): boolean {
  const pending: Node[] = [source];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    if (each.kind === SyntaxKind.Decorator || each.kind === SyntaxKind.DeclareKeyword) {
      return true;
    }
    each.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** The selected pure class definition is not a prior native replacement; other work stays opaque. */
function priorClassEffect(node: CallExpression, source: OrdinaryClass): boolean {
  for (let each: Node = node; !isSourceFile(each); each = each.parent) {
    if (
      isBlock(each.parent) &&
      each.parent.statements.some(
        (statement) => statement.end <= each.pos && priorStatementEffect(statement, source),
      )
    ) {
      return true;
    }
  }
  return false;
}

/** Other declarations in the same statement still execute beside the known selected class. */
function priorStatementEffect(statement: Statement, source: OrdinaryClass): boolean {
  if (isClassDeclaration(source)) {
    return statement !== source && callbackCreationEffect(statement);
  }
  if (!isVariableStatement(statement)) {
    return callbackCreationEffect(statement);
  }
  return statement.declarationList.declarations.some((declaration) => {
    const value = declaration.initializer;
    if (value !== undefined && isClassExpression(source) && unwrapped(value) === source) {
      return false;
    }
    return callbackCreationEffect(declaration);
  });
}
