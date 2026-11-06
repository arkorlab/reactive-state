import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { borrowedTextCall } from './framed-array-borrowing.ts';
import { frameBindingOf, frameMemberName } from './framed-bindings.ts';
import { framedAppliedArguments } from './framed-keys.ts';

/** Written native borrowed mutators preserve their explicit array receiver and inserted arguments. */

export interface ArrayMutation {
  readonly receiver: Expression;
  readonly method: string;
  readonly given: readonly Expression[];
  readonly unknownList?: Expression | undefined;
}

/** Native call/apply/Reflect.apply and an unchanged whole bound method retain one receiver. */
export function borrowedArrayMutation(call: CallExpression): ArrayMutation | undefined {
  const borrowed = borrowedTextCall(call);
  if (borrowed?.path.slice(0, -1).join('.') === 'Array.prototype') {
    const list = borrowed.applied;
    const given = list === undefined ? borrowed.given : framedAppliedArguments(call, list);
    return {
      receiver: borrowed.receiver,
      method: borrowed.path.at(-1) ?? '',
      given: given ?? [],
      unknownList: given === undefined ? list : undefined,
    };
  }
  const bound = boundCall(call.expression);
  if (bound === undefined) return undefined;
  const target = unwrapped(bound.expression);
  if (!isPropertyAccessExpression(target) && !isElementAccessExpression(target)) return undefined;
  if (frameMemberName(target) !== 'bind') return undefined;
  const path = globalPathOf(unwrapped(target.expression));
  const receiver = bound.arguments[0];
  return receiver !== undefined && path?.slice(0, -1).join('.') === 'Array.prototype'
    ? {
        receiver,
        method: path.at(-1) ?? '',
        given: [...bound.arguments.slice(1), ...call.arguments],
      }
    : undefined;
}

/** Only whole constant callable aliases retain a bound native method, with cycles kept opaque. */
function boundCall(expression: Expression): CallExpression | undefined {
  let value = unwrapped(expression);
  const seen = new Set<Node>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0) return undefined;
    const { binding } = selected;
    if (
      seen.has(binding) ||
      !isVariableDeclaration(binding) ||
      !isIdentifier(binding.name) ||
      !isVariableStatement(binding.parent.parent) ||
      !/^const\s/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return undefined;
    seen.add(binding);
    value = unwrapped(binding.initializer);
  }
  return isCallExpression(value) ? value : undefined;
}
