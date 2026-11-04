import {
  type CallExpression,
  type ClassDeclaration,
  type Expression,
  type FunctionDeclaration,
  type Identifier,
  isArrayLiteralExpression,
  isCallExpression,
  isClassDeclaration,
  isElementAccessExpression,
  isFunctionDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isVariableDeclaration,
  type MethodDeclaration,
  type NewExpression,
  type Node,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { argumentChanges } from './argument-effects.ts';
import { unwrapped } from './bounded.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { globalPathOf } from './code-globals.ts';
import { declarationOf } from './framed.ts';
import { rootOf } from './kept.ts';
import { writtenBy } from './written.ts';

/** Source call targets and their actual arguments, for metadata dependence on input writes. */

/** A constant's initializer, excluding mutable bindings and destructuring projections. */
export function metadataInitializer(name: Identifier): Expression | undefined {
  const declared = declarationOf(name);
  if (declared === undefined || !isVariableDeclaration(declared) || !isIdentifier(declared.name)) {
    return undefined;
  }
  let file: Node = declared;
  while (!isSourceFile(file)) {
    file = file.parent;
  }
  return /^const\s/u.test(declared.parent.getText(file)) ? declared.initializer : undefined;
}

/** A source callee or a global reference, followed through constant aliases. */
export function metadataCallee(node: Expression): Node | undefined {
  return calleeOf(node, new Set());
}

/** A lexical target or literal own member, without executing a getter. */
function calleeOf(node: Expression, seen: ReadonlySet<Expression>): Node | undefined {
  let value = unwrapped(node);
  const trail = new Set(seen);
  while (!trail.has(value)) {
    trail.add(value);
    if (!isIdentifier(value)) {
      return memberValue(value, trail);
    }
    const declared = declarationOf(value);
    if (
      declared !== undefined &&
      (isFunctionDeclaration(declared) || isClassDeclaration(declared))
    ) {
      return declarationWritten(declared) ? undefined : declared;
    }
    const initializer = metadataInitializer(value);
    if (initializer === undefined) {
      return value;
    }
    value = unwrapped(initializer);
  }
  return undefined;
}

/** A static own member of a fresh literal; other references keep their native path. */
function memberValue(value: Expression, seen: ReadonlySet<Expression>): Node | undefined {
  if (!isPropertyAccessExpression(value) && !isElementAccessExpression(value)) {
    return value;
  }
  const holder = calleeOf(value.expression, seen);
  if (holder === undefined) {
    return undefined;
  }
  if (!isObjectLiteralExpression(holder)) {
    return value;
  }
  const key = isPropertyAccessExpression(value)
    ? value.name.text
    : elementName(value.argumentExpression, seen);
  if (key === undefined || calleeUncertain(holder, value)) {
    return undefined;
  }
  const member = ownMember(holder, key);
  if (member === undefined || isMethodDeclaration(member)) {
    return member;
  }
  return calleeOf(member, seen);
}

/** A literal data property's value or a method, with later own properties taking precedence. */
function ownMember(
  holder: ObjectLiteralExpression,
  key: string,
): Expression | MethodDeclaration | undefined {
  let found: Expression | MethodDeclaration | undefined;
  for (const property of holder.properties) {
    if (isSpreadAssignment(property)) {
      return undefined;
    }
    const name = staticName(property.name);
    if (name === undefined || name === '__proto__') {
      return undefined;
    }
    if (name !== key) {
      continue;
    }
    if (isPropertyAssignment(property)) {
      found = property.initializer;
    } else if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
      found = property.name;
    } else {
      found = isMethodDeclaration(property) ? property : undefined;
    }
  }
  return found;
}

/** A key written without executing application code or coercing a value. */
function staticName(node: Node): string | undefined {
  return isIdentifier(node) || isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : undefined;
}

/** An element key whose value is literal text, past constant aliases. */
function elementName(node: Expression, seen: ReadonlySet<Expression>): string | undefined {
  const value = calleeOf(node, seen);
  return value !== undefined && (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value))
    ? value.text
    : undefined;
}

/** A source invocation's target and positional arguments. */
export function metadataInvocation(
  call: CallExpression | NewExpression,
): { readonly callee: Node; readonly given: readonly Expression[] } | undefined {
  const callee = metadataCallee(call.expression);
  const given = call.arguments ?? [];
  if (
    callee === undefined ||
    given.some((argument) => isSpreadElement(argument) || argumentChanges(argument, metadataCallee))
  ) {
    return undefined;
  }
  if (!isCallExpression(call)) {
    return { callee, given };
  }
  if (isAnswering(callee)) {
    return usesReceiver(callee) ? undefined : { callee, given };
  }
  if (globalPathOf(callee)?.join('.') === 'Reflect.apply') {
    const target = given[0] === undefined ? undefined : metadataCallee(given[0]);
    const args = given[2] === undefined ? undefined : applyArguments(given[2], call);
    return target === undefined || args === undefined || usesReceiver(target)
      ? undefined
      : { callee: target, given: args };
  }
  return functionInvocation(call, callee);
}

/** A mutable function or class declaration is no proof of the callable eventually invoked. */
function declarationWritten(target: FunctionDeclaration | ClassDeclaration): boolean {
  let found = false;
  const visit = (node: Node): void => {
    if (found) {
      return;
    }
    const written = writtenBy(node);
    found = written !== undefined && isIdentifier(written) && declarationOf(written) === target;
    if (!found) {
      node.forEachChild(visit);
    }
  };
  visit(target.getSourceFile());
  return found;
}

/** Function call/apply methods receive the receiver separately from the source parameters. */
function functionInvocation(
  call: CallExpression,
  callee: Node,
): { readonly callee: Node; readonly given: readonly Expression[] } | undefined {
  const expression = unwrapped(call.expression);
  if (!isPropertyAccessExpression(expression) && !isElementAccessExpression(expression)) {
    return { callee, given: call.arguments };
  }
  const key = isPropertyAccessExpression(expression)
    ? expression.name.text
    : elementName(expression.argumentExpression, new Set());
  if (key !== 'call' && key !== 'apply') {
    return { callee, given: call.arguments };
  }
  const target = metadataCallee(expression.expression);
  if (
    target === undefined ||
    !isAnswering(target) ||
    usesReceiver(target) ||
    callableWritten(target)
  ) {
    return undefined;
  }
  const given = key === 'call' ? call.arguments.slice(1) : applyArguments(call.arguments[1], call);
  return given === undefined ? undefined : { callee: target, given };
}

/** Receiver-dependent calls stay unknown until their invocation's this binding can be followed. */
function usesReceiver(node: Node): boolean {
  let found = false;
  const visit = (each: Node): void => {
    found ||= each.kind === SyntaxKind.ThisKeyword;
    if (!found) {
      each.forEachChild(visit);
    }
  };
  visit(node);
  return found;
}

/** An assigned callable or own call/apply property can replace the native invocation method. */
function callableWritten(target: Node): boolean {
  let found = false;
  const visit = (node: Node): void => {
    if (found) {
      return;
    }
    const written = writtenBy(node);
    const root = written === undefined ? undefined : rootOf(written);
    found = root !== undefined && metadataCallee(root) === target;
    if (!found) {
      node.forEachChild(visit);
    }
  };
  visit(target.getSourceFile());
  return found;
}

/** A statically written apply argument list, including stable aliases and nested tuple spreads. */
function applyArguments(
  value: Expression | undefined,
  call: CallExpression,
): Expression[] | undefined {
  if (value === undefined || unwrapped(value).kind === SyntaxKind.NullKeyword) {
    return [];
  }
  const resolved = metadataCallee(value);
  if (resolved !== undefined && globalPathOf(resolved)?.join('.') === 'undefined') {
    return [];
  }
  return arrayArguments(value, call, new Set());
}

/** Known array entries, deferred if evaluating intervening application code may change them. */
function arrayArguments(
  value: Expression,
  call: CallExpression,
  seen: ReadonlySet<Node>,
): Expression[] | undefined {
  const resolved = metadataCallee(value);
  if (
    resolved === undefined ||
    !isArrayLiteralExpression(resolved) ||
    seen.has(resolved) ||
    calleeUncertain(resolved, call)
  ) {
    return undefined;
  }
  const trail = new Set([...seen, resolved]);
  const found: Expression[] = [];
  for (const element of resolved.elements) {
    if (isSpreadElement(element)) {
      const entries = arrayArguments(element.expression, call, trail);
      if (entries === undefined) {
        return undefined;
      }
      found.push(...entries);
    } else if (element.kind === SyntaxKind.OmittedExpression) {
      return undefined;
    } else {
      found.push(element);
    }
  }
  return found;
}
