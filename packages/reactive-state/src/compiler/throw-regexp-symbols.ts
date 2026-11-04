import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isBlock,
  isCallExpression,
  isNewExpression,
  isOmittedExpression,
  isSourceFile,
  isSpreadElement,
  isVariableStatement,
  type NewExpression,
  type Node,
} from 'typescript/ast';

import { calledMember } from './bounded.ts';
import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { expandedInvocation } from './throw-arguments.ts';
import { globalCalleePath } from './throw-callees.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';
import { isSymbolWritten } from './throw-symbols.ts';

/** RegExp converts only its pattern and flags; source evaluation must retain native Symbol values. */
export function regexpSymbolThrows(node: Node, outer: Resolve | undefined): boolean {
  if (!isCallExpression(node) && !isNewExpression(node)) {
    return false;
  }
  const resolve: Resolve = (name) => {
    const held = outer?.(name) ?? metadataInitializer(name);
    return held === undefined || calleeUncertain(held, node) ? undefined : held;
  };
  const given = regexpArguments(node, resolve);
  return (
    given !== undefined &&
    given.slice(0, 2).some((each) => regexpSymbol(each, resolve)) &&
    !earlierExpressionEffect(node) &&
    (node.arguments ?? []).every((each) => quietRegExpValue(each, resolve)) &&
    !regexpPriorEffect(node, resolve)
  );
}

/** Direct calls, constructions and explicit Function forwarding keep their original evaluation node. */
function regexpArguments(
  node: CallExpression | NewExpression,
  resolve: Resolve,
): readonly Expression[] | undefined {
  const made = expandedInvocation(node, resolve);
  const args = made.arguments ?? [];
  if (args.some((each) => isSpreadElement(each))) {
    return undefined;
  }
  const path = globalCalleePath(made.expression, resolve)?.join('.');
  if (path === 'RegExp') {
    return args;
  }
  if (isNewExpression(made)) {
    return undefined;
  }
  const reflected = path === 'Reflect.apply';
  const member = calledMember(writtenOf(made.expression, resolve));
  const method = member?.name;
  const target = reflected ? args[0] : member?.of;
  if (
    target === undefined ||
    (!reflected && method !== 'call' && method !== 'apply') ||
    globalCalleePath(target, resolve)?.join('.') !== 'RegExp' ||
    calleeUncertain(target, node)
  ) {
    return undefined;
  }
  if (!reflected && method === 'call') {
    return args.slice(1);
  }
  return regexpApplied(args[reflected ? 2 : 1], node, resolve);
}

/** A native apply reads only an unchanged literal argument list. */
function regexpApplied(
  list: Expression | undefined,
  node: Expression,
  resolve: Resolve,
): readonly Expression[] | undefined {
  if (list === undefined || primitiveOf(list, resolve) === 'nothing') {
    return [];
  }
  const value = writtenOf(list, resolve);
  return isArrayLiteralExpression(value) &&
    !value.elements.some((each) => isOmittedExpression(each) || isSpreadElement(each)) &&
    !calleeUncertain(value, node)
    ? value.elements
    : undefined;
}

/** Unchanged Symbol maker aliases and well-known symbols establish primitive Symbol identities. */
function regexpSymbol(node: Expression, resolve: Resolve): boolean {
  const value = writtenOf(node, resolve);
  if (isSymbolWritten(value, resolve)) {
    return true;
  }
  if (!isCallExpression(value)) {
    return false;
  }
  const path = globalCalleePath(value.expression, resolve)?.join('.');
  return path === 'Symbol' || path === 'Symbol.for';
}

/** Scalar Symbol descriptions are quiet; coercion callbacks and other application work stay opaque. */
function quietRegExpValue(node: Expression, resolve: Resolve): boolean {
  const pending = [node];
  const seen = new Set<Expression>();
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    const value = writtenOf(each, resolve);
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    if (isArrayLiteralExpression(value)) {
      if (value.elements.some((part) => isOmittedExpression(part) || isSpreadElement(part))) {
        return false;
      }
      pending.push(...value.elements);
    } else if (regexpSymbol(value, resolve)) {
      if (
        isCallExpression(value) &&
        !value.arguments.every((part) => {
          const description = writtenOf(part, resolve);
          return (
            primitiveOf(description, resolve) !== undefined && !callbackCreationEffect(description)
          );
        })
      ) {
        return false;
      }
    } else if (callbackCreationEffect(value)) {
      return false;
    }
  }
  return true;
}

/** Enclosing prior work can replace either RegExp or a Symbol maker before the selected invocation. */
function regexpPriorEffect(node: Expression, resolve: Resolve): boolean {
  for (let each: Node = node; !isSourceFile(each); each = each.parent) {
    if (
      isBlock(each.parent) &&
      each.parent.statements.some((statement) => {
        if (statement.end > each.pos) {
          return false;
        }
        return isVariableStatement(statement)
          ? statement.declarationList.declarations.some((declaration) => {
              return (
                declaration.initializer !== undefined &&
                !quietRegExpValue(declaration.initializer, resolve)
              );
            })
          : callbackCreationEffect(statement);
      })
    ) {
      return true;
    }
  }
  return false;
}
