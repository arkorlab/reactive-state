import {
  type Expression,
  isBlock,
  isCallExpression,
  isConstructorDeclaration,
  isObjectLiteralExpression,
  isSourceFile,
  isSpreadAssignment,
  type Node,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { calledMember } from './bounded.ts';
import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { globalPath } from './global-answers.ts';
import type { Resolve } from './numbers.ts';
import { enumerationKey } from './throw-keys.ts';
import { writtenOf } from './throw-shapes.ts';

/** Generic Object methods that unconditionally require a non-nullish receiver. */
const REQUIRING_RECEIVER: ReadonlySet<string> = new Set([
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  'hasOwnProperty',
  'propertyIsEnumerable',
  'toLocaleString',
  'valueOf',
]);

/** Whether the selected native generic method rejects a nullish receiver. */
export function objectNullishReceiver(
  callee: Expression,
  method: string,
  given: readonly Expression[],
): boolean {
  return REQUIRING_RECEIVER.has(method) && quietObjectCall(callee, given);
}

/** A native legacy accessor definer, excluding own overrides and earlier replacement effects. */
export function legacyAccessor(
  callee: Expression,
  given: readonly Expression[],
  resolve: Resolve | undefined,
  borrowed: boolean,
): boolean {
  const member = calledMember(callee);
  if (
    member === undefined ||
    !['__defineGetter__', '__defineSetter__'].includes(member.name) ||
    !quietObjectCall(callee, given)
  ) {
    return false;
  }
  if (borrowed || globalPath(callee)?.join('.') === `Object.prototype.${member.name}`) {
    return true;
  }
  const receiver = writtenOf(member.of, resolve);
  const call = sourceCall(callee);
  return (
    call !== undefined &&
    isObjectLiteralExpression(receiver) &&
    !callbackCreationEffect(receiver) &&
    !calleeUncertain(receiver, call) &&
    receiver.properties.every((property) => {
      if (isSpreadAssignment(property)) {
        return false;
      }
      const key = enumerationKey(property.name, resolve);
      return key !== undefined && key !== '__proto__' && key !== member.name;
    })
  );
}

/** All argument evaluation and earlier application work must preserve the selected native method. */
function quietObjectCall(callee: Expression, given: readonly Expression[]): boolean {
  const call = sourceCall(callee);
  const args = globalPath(callee)?.join('.') === 'Reflect.apply' ? given.slice(1) : given;
  if (
    call === undefined ||
    args.some((argument) => callbackCreationEffect(argument)) ||
    earlierExpressionEffect(call)
  ) {
    return false;
  }
  for (let each: Node = call; !isSourceFile(each); each = each.parent) {
    const { parent } = each;
    if (
      isBlock(parent) &&
      parent.statements.some(
        (statement) => statement.end <= each.pos && callbackCreationEffect(statement),
      )
    ) {
      return false;
    }
    if (isAnswering(parent) || isConstructorDeclaration(parent)) {
      break;
    }
  }
  return true;
}

/** A normalized borrowed callee keeps the original invocation among its source ancestors. */
function sourceCall(node: Node): Expression | undefined {
  for (let each = node; !isSourceFile(each); each = each.parent) {
    if (isCallExpression(each)) {
      return each;
    }
  }
  return undefined;
}
