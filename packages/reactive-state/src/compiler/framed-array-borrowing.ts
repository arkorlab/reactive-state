import {
  type CallExpression,
  type Expression,
  isElementAccessExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isSpreadElement,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameBindingOf, frameMemberName } from './framed-bindings.ts';

/** Borrowed native text methods retain a receiver even when their apply argument list is opaque. */

interface BorrowedText {
  readonly receiver: Expression;
  readonly path: readonly string[];
  readonly given: readonly Expression[];
  readonly applied: Expression | undefined;
}

/** A native method selected by call, apply or Reflect.apply, including whole constant aliases. */
export function borrowedTextCall(call: CallExpression): BorrowedText | undefined {
  const callee = unwrapped(call.expression);
  let target: Expression | undefined;
  let receiver: Expression | undefined;
  let given: readonly Expression[] = [];
  let applied: Expression | undefined;
  if (globalPathOf(callee)?.join('.') === 'Reflect.apply') {
    [target, receiver, applied] = call.arguments;
  } else if (isPropertyAccessExpression(callee) || isElementAccessExpression(callee)) {
    const method = frameMemberName(callee);
    if (method !== 'call' && method !== 'apply') return undefined;
    target = callee.expression;
    [receiver] = call.arguments;
    if (method === 'call') given = call.arguments.slice(1);
    else applied = call.arguments[1];
  }
  if (target === undefined || receiver === undefined || isSpreadElement(receiver)) return undefined;
  const path = nativePath(target);
  return path === undefined ? undefined : { applied, given, path, receiver };
}

/** Only a whole immutable lexical alias retains the selected native callable. */
function nativePath(expression: Expression): readonly string[] | undefined {
  const seen = new Set<Node>();
  let value = unwrapped(expression);
  while (isIdentifier(value)) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0) break;
    const { binding } = selected;
    if (!isVariableDeclaration(binding)) return undefined;
    const statement = binding.parent.parent;
    if (
      !isVariableStatement(statement) ||
      !/^const\s/u.test(statement.declarationList.getText(statement.getSourceFile())) ||
      binding.initializer === undefined
    )
      return undefined;
    value = unwrapped(binding.initializer);
  }
  return globalPathOf(value);
}
