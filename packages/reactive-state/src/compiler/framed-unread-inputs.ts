/**
 * Whether a native collection's reader cannot read the input it is given, as `framedErrorAdmitted`
 * then reads the declared element type for whether an Error may be among what it holds.
 */

import {
  type Expression,
  isArrayLiteralExpression,
  isIdentifier,
  isOmittedExpression,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { argumentArrayExposed } from './framed-array-selections.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { framedQuietOperand } from './framed-quiet-operands.ts';

/**
 * Whether an input is one the compile cannot read: it holds no written array past quiet commas
 * (`framedQuietOperand`) and whole `const` aliases, the code may change that array first
 * (`argumentArrayExposed`), or the array spreads another in. A Map's `entries` must each be a
 * written pair, spreading nothing in. `null` and `undefined`, which give an empty collection, are
 * read.
 */
export function framedUnreadInput(input: Expression, entries = false): boolean {
  const key = framedMapKey(input);
  if (key === 'null' || key === 'undefined') return false;
  let value = framedQuietOperand(input);
  const aliases = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    const binding = selected?.binding;
    if (
      binding === undefined ||
      selected?.keys.length !== 0 ||
      aliases.has(binding) ||
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return true;
    aliases.add(binding);
    value = framedQuietOperand(binding.initializer);
  }
  if (!isArrayLiteralExpression(value) || argumentArrayExposed(input, aliases)) return true;
  return value.elements.some((element) => {
    if (isSpreadElement(element)) return true;
    if (!entries || isOmittedExpression(element)) return false;
    const pair = unwrapped(element);
    return !isArrayLiteralExpression(pair) || pair.elements.some((each) => isSpreadElement(each));
  });
}
