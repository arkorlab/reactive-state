import {
  type ArrayLiteralExpression,
  type Expression,
  isArrayLiteralExpression,
  isIdentifier,
  isVariableDeclaration,
  isVariableDeclarationList,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';

/** Blob iterates its root parts array rather than calling that array's own text method. */

/**
 * The written root sequence, through whole constant aliases. Other uses of the array before the
 * construction — an own toString decoration, a read, a mutation — do not drop it: one the compile
 * cannot follow leaves every part the array was written with possible, beside the writes it follows.
 */
export function framedBlobSequence(
  expression: Expression,
  original: (value: Expression) => Expression | undefined,
): ArrayLiteralExpression | undefined {
  const value = unwrapped(original(expression) ?? expression);
  if (isArrayLiteralExpression(value)) return value;
  return sequenceAlias(expression);
}

/** Only whole constant aliases of a finite written array establish its original sequence. */
function sequenceAlias(expression: Expression): ArrayLiteralExpression | undefined {
  let value = unwrapped(expression);
  const bindings = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0 || bindings.has(selected.binding))
      return undefined;
    const { binding } = selected;
    if (
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return undefined;
    bindings.add(binding);
    value = unwrapped(binding.initializer);
  }
  return isArrayLiteralExpression(value) ? value : undefined;
}
