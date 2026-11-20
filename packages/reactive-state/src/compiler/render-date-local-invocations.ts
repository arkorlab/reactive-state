import {
  type CallExpression,
  type Expression,
  isArrowFunction,
  isBlock,
  isCallExpression,
  isFunctionExpression,
  isIdentifier,
  isReturnStatement,
  isVariableDeclaration,
  isVariableDeclarationList,
} from 'typescript/ast';

import { answersLater } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { framedQuietSource } from './framed-native-evaluation.ts';
import { framedPrefixSameOwner } from './framed-native-prefix.ts';

/** An immediate local constant callable retains one written native array text expression. */

/** Zero-argument synchronous calls retain their original body and outer invocation read point. */
export function localDateInvocation(call: CallExpression): CallExpression | undefined {
  const source = localConstant(call);
  if (
    source === undefined ||
    (!isArrowFunction(source) && !isFunctionExpression(source)) ||
    answersLater(source) ||
    source.parameters.length > 0
  )
    return undefined;
  const body = source.body;
  if (!isBlock(body)) return nativeCall(body);
  const first = body.statements[0];
  return first !== undefined && body.statements.length === 1 && isReturnStatement(first)
    ? nativeCall(first.expression)
    : undefined;
}

/** Only a completed whole local constant supplies the callable at this original invocation. */
function localConstant(call: CallExpression): Expression | undefined {
  if (call.arguments.length > 0) return undefined;
  const target = unwrapped(call.expression);
  if (!isIdentifier(target)) return undefined;
  const selected = frameBindingOf(target);
  const binding = selected?.binding;
  if (
    binding === undefined ||
    selected === undefined ||
    selected.keys.length > 0 ||
    !isVariableDeclaration(binding) ||
    !isIdentifier(binding.name) ||
    !isVariableDeclarationList(binding.parent) ||
    binding.initializer === undefined ||
    binding.end >= call.pos ||
    !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
    !framedPrefixSameOwner(binding, call)
  )
    return undefined;
  return framedQuietSource(target);
}

/** The callback consumes the original expression without copying or synthesizing its syntax. */
function nativeCall(expression: Expression | undefined): CallExpression | undefined {
  const value = expression === undefined ? undefined : unwrapped(expression);
  return value !== undefined && isCallExpression(value) ? value : undefined;
}
