import {
  type Expression,
  type Node,
  isArrowFunction,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isClassStaticBlockDeclaration,
  isConstructorDeclaration,
  isElementAccessExpression,
  isIdentifier,
  isNewExpression,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isSetAccessorDeclaration,
  isSourceFile,
  isSpreadAssignment,
  isStringLiteral,
  SyntaxKind,
  type TypeNode,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameMemberName, type FrameTypeSelection } from './framed-bindings.ts';
import { locallyWrittenBoundWords } from './framed-bound-error-words.ts';
import { framedBoundErrorArguments, framedPossibleBoundError } from './framed-bound-errors.ts';
import { framedGetPrototypeValues } from './framed-get-prototypes.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedProxyGetForwards } from './framed-proxy-get-results.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedValueShape } from './framed-values.ts';

/** Native indirect construction, nonintercepting Proxy handlers and explicitly typed this receivers. */

/** Native error calls and constructions retain their target through direct or Reflect syntax. */
export function framedNativeErrorCreation(
  node: Expression,
  names: ReadonlySet<string>,
  made = true,
): boolean {
  if (framedReflectedError(node, names) || framedInvokedError(node, names)) return true;
  if (isCallExpression(node) || isNewExpression(node)) {
    const bound = framedBoundErrorArguments(node, names);
    if (bound !== undefined && (made || locallyWrittenBoundWords(bound.target, bound.args)))
      return true;
    if (bound === undefined && made && framedPossibleBoundError(node, names)) return true;
  }
  return (
    (isNewExpression(node) || isCallExpression(node)) &&
    framedNativeConstructor(framedValueShape(node.expression).value, names)
  );
}

/** Native call and apply invocations retain the constructor whose function is invoked. */
function framedInvokedError(node: Expression, names: ReadonlySet<string>): boolean {
  if (!isCallExpression(node)) return false;
  const callee = unwrapped(node.expression);
  if (globalPathOf(callee)?.join('.') === 'Reflect.apply') {
    const target = node.arguments[0];
    return target !== undefined && framedNativeConstructor(target, names);
  }
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) return false;
  const method = frameMemberName(callee);
  return (
    (method === 'call' || method === 'apply') && framedNativeConstructor(callee.expression, names)
  );
}

/** Reflect constructs its known native target without changing the origin of the error's words. */
function framedReflectedError(node: Expression, names: ReadonlySet<string>): boolean {
  if (
    !isCallExpression(node) ||
    globalPathOf(unwrapped(node.expression))?.join('.') !== 'Reflect.construct'
  )
    return false;
  const target = node.arguments[0];
  return target !== undefined && framedNativeConstructor(target, names);
}

/** Native Object.create retains possible prototypes for inherited error members. */
export function framedPrototypeValues(node: Expression): readonly Expression[] | undefined {
  const selected = framedGetPrototypeValues(node);
  if (selected !== undefined) return selected;
  if (
    !isCallExpression(node) ||
    globalPathOf(unwrapped(node.expression))?.join('.') !== 'Object.create'
  )
    return undefined;
  const prefix = framedArgumentPrefix(node);
  const target = prefix.values[0];
  return target === undefined ? prefix.alternatives : [target, ...(prefix.alternatives ?? [])];
}

/**
 * A directly written native Proxy handler without get or an opaque inherited trap forwards the read,
 * as does one whose `get` trap may forward it (`framedProxyGetForwards`).
 */
export function framedProxyValues(
  node: Expression,
  point?: Node,
): readonly Expression[] | undefined {
  const inputs = proxyInputs(node);
  const target = inputs?.[0];
  const handler = inputs?.[1];
  if (target === undefined || handler === undefined) return undefined;
  const value = unwrapped(handler);
  return isObjectLiteralExpression(value) &&
    value.properties.every((entry) => {
      if (isSpreadAssignment(entry)) return false;
      const name = entry.name;
      if (!isIdentifier(name) && !isStringLiteral(name) && !isNumericLiteral(name)) return false;
      return (
        name.text !== '__proto__' &&
        (name.text !== 'get' ||
          framedProxyGetForwards(value, { proxy: node, target, handler, point }))
      );
    })
    ? [target]
    : undefined;
}

/** An immediate revocable proxy selection occurs before its unexposed pair can be revoked. */
function proxyInputs(node: Expression): readonly Expression[] | undefined {
  if (isNewExpression(node) && globalPathOf(unwrapped(node.expression))?.join('.') === 'Proxy')
    return node.arguments;
  if (
    (!isPropertyAccessExpression(node) && !isElementAccessExpression(node)) ||
    frameMemberName(node) !== 'proxy'
  )
    return undefined;
  const call = unwrapped(node.expression);
  if (!isCallExpression(call)) return undefined;
  const member = unwrapped(call.expression);
  if (
    (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) ||
    frameMemberName(member) !== 'revocable' ||
    !framedNativeConstructor(member.expression, new Set(['Proxy']))
  )
    return undefined;
  const prefix = framedArgumentPrefix(call);
  return prefix.unknown || prefix.alternatives !== undefined ? undefined : prefix.values;
}

/** A written this annotation retains explicit member paths inside its own non-arrow callable. */
export function framedThisType(node: Expression): FrameTypeSelection | undefined {
  let value = unwrapped(node);
  let keys: readonly string[] = [];
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const key = frameMemberName(value);
    if (key === undefined) return undefined;
    keys = [key, ...keys];
    value = unwrapped(value.expression);
  }
  if (value.kind !== SyntaxKind.ThisKeyword) return undefined;
  const type = explicitThisType(value);
  return type === undefined ? undefined : { keys, type };
}

/** Arrows inherit this; another callable or a class initializer owns its separate receiver. */
function explicitThisType(node: Expression): TypeNode | undefined {
  for (let at = node.parent; !isSourceFile(at); at = at.parent) {
    if (isArrowFunction(at)) continue;
    if (isAnswering(at) || isConstructorDeclaration(at) || isSetAccessorDeclaration(at)) {
      return at.parameters.find(
        (parameter) => isIdentifier(parameter.name) && parameter.name.text === 'this',
      )?.type;
    }
    if (
      isClassDeclaration(at) ||
      isClassExpression(at) ||
      isClassStaticBlockDeclaration(at) ||
      isPropertyDeclaration(at)
    )
      return undefined;
  }
  return undefined;
}
