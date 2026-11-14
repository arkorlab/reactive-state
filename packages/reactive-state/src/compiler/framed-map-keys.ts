import {
  type Expression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isPrefixUnaryExpression,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';

/** Literal primitive keys and their whole constant aliases preserve SameValueZero equality. */
export function framedMapKey(expression: Expression | undefined): string | undefined {
  if (expression === undefined) return undefined;
  let value = unwrapped(expression);
  const seen = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    if (globalPathOf(value)?.join('.') === 'undefined') return 'undefined';
    const binding = keyBinding(value, seen);
    if (binding?.initializer === undefined) return undefined;
    seen.add(binding);
    value = unwrapped(binding.initializer);
  }
  return literalKey(value);
}

/** Only an immutable whole lexical key binding retains its primitive initializer. */
function keyBinding(value: Expression, seen: ReadonlySet<FrameBinding>): FrameBinding | undefined {
  if (!isIdentifier(value)) return undefined;
  const selected = frameBindingOf(value);
  if (selected === undefined || selected.keys.length > 0) return undefined;
  const { binding } = selected;
  return !seen.has(binding) &&
    isVariableDeclaration(binding) &&
    isIdentifier(binding.name) &&
    isVariableDeclarationList(binding.parent) &&
    /^const\b/u.test(binding.parent.getText(binding.getSourceFile()))
    ? binding
    : undefined;
}

/** Literal spellings alone establish primitive keys without native method-name assumptions. */
function literalKey(value: Expression): string | undefined {
  if (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value)) return `text:${value.text}`;
  if (isNumericLiteral(value)) return `number:${Number(value.text.replaceAll('_', ''))}`;
  if (
    isPrefixUnaryExpression(value) &&
    (value.operator === SyntaxKind.PlusToken || value.operator === SyntaxKind.MinusToken) &&
    isNumericLiteral(value.operand)
  ) {
    const number = Number(value.operand.text.replaceAll('_', ''));
    return `number:${value.operator === SyntaxKind.MinusToken ? -number : number}`;
  }
  if (value.kind === SyntaxKind.TrueKeyword) return 'true';
  if (value.kind === SyntaxKind.FalseKeyword) return 'false';
  return value.kind === SyntaxKind.NullKeyword ? 'null' : undefined;
}
