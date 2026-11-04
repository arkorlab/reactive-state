import {
  type Expression,
  type ArrowFunction,
  type FunctionExpression,
  type CallExpression,
  isIdentifier,
  isVariableDeclaration,
  isVariableDeclarationList,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { quietMapperFunction } from './framed-mapper-quiet.ts';
import { framedPrefixSameOwner } from './framed-native-prefix.ts';

/** A quiet native reducer keeps whole const identifier aliases in their original callback scope. */
export function framedReductionAlias(value: Expression): Expression | undefined {
  const actual = unwrapped(value);
  if (!isIdentifier(actual)) return undefined;
  const selected = frameBindingOf(actual);
  if (selected === undefined || selected.keys.length > 0) return undefined;
  const { binding } = selected;
  if (
    !isVariableDeclaration(binding) ||
    !isIdentifier(binding.name) ||
    !isVariableDeclarationList(binding.parent) ||
    !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
    binding.initializer === undefined ||
    !framedPrefixSameOwner(binding, actual) ||
    binding.initializer.end > actual.pos
  )
    return undefined;
  return isIdentifier(unwrapped(binding.initializer)) ? binding.initializer : undefined;
}

/** Original callback, receiver and arguments must be quiet before a returned alias gains an origin. */
export function framedReductionAliasesQuiet(
  fn: ArrowFunction | FunctionExpression,
  call: CallExpression,
  receiver: Expression,
): boolean {
  const evaluated = framedArgumentPrefix(call, call.arguments, Infinity);
  return (
    !evaluated.unknown &&
    quietMapperFunction(fn, call, receiver, { direct: true, evaluated: evaluated.values })
  );
}
