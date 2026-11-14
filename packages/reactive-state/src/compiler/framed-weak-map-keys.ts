import {
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { framedMapKey } from './framed-map-keys.ts';

/** A fresh literal object captured by whole constants keeps one WeakMap key identity. */
export function framedMutationKey(
  value: Expression | undefined,
  weak: boolean,
): string | undefined {
  const primitive = framedMapKey(value);
  if (!weak || primitive !== undefined || value === undefined) return primitive;
  let current = unwrapped(value);
  // A comma key is its last operand; what the others evaluate is the writes' proof to show quiet.
  while (isBinaryExpression(current) && current.operatorToken.kind === SyntaxKind.CommaToken)
    current = unwrapped(current.right);
  let original: FrameBinding | undefined;
  const seen = new Set<FrameBinding>();
  while (isIdentifier(current)) {
    const selected = frameBindingOf(current);
    const binding = selected?.binding;
    if (
      binding === undefined ||
      selected?.keys.length !== 0 ||
      seen.has(binding) ||
      !isVariableDeclaration(binding) ||
      !isIdentifier(binding.name) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return undefined;
    seen.add(binding);
    original = binding;
    current = unwrapped(binding.initializer);
  }
  return original !== undefined &&
    (isObjectLiteralExpression(current) || isArrayLiteralExpression(current))
    ? `identity:${original.pos}`
    : undefined;
}
