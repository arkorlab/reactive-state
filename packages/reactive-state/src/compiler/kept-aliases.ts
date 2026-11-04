import {
  type Expression,
  type Identifier,
  isBinaryExpression,
  isIdentifier,
  isVariableDeclaration,
  isVariableDeclarationList,
  SyntaxKind,
} from 'typescript/ast';

import { globalOf, unwrapped } from './bounded.ts';
import { frameBindingOf } from './framed-bindings.ts';

/** Whole local constants retain the identity of an aliased value held between calls. */

const PRIMITIVE_GLOBALS: ReadonlySet<string> = new Set(['Infinity', 'NaN', 'undefined']);

const PRIMITIVE_BINARY_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandToken,
  SyntaxKind.AsteriskAsteriskToken,
  SyntaxKind.AsteriskToken,
  SyntaxKind.BarToken,
  SyntaxKind.CaretToken,
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
  SyntaxKind.GreaterThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  SyntaxKind.GreaterThanGreaterThanToken,
  SyntaxKind.GreaterThanToken,
  SyntaxKind.InKeyword,
  SyntaxKind.InstanceOfKeyword,
  SyntaxKind.LessThanEqualsToken,
  SyntaxKind.LessThanLessThanToken,
  SyntaxKind.LessThanToken,
  SyntaxKind.MinusToken,
  SyntaxKind.PercentToken,
  SyntaxKind.PlusToken,
  SyntaxKind.SlashToken,
]);

const PRIMITIVE_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.BigIntLiteral,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.PostfixUnaryExpression,
  SyntaxKind.PrefixUnaryExpression,
  SyntaxKind.StringLiteral,
  SyntaxKind.TemplateExpression,
  SyntaxKind.TrueKeyword,
  SyntaxKind.TypeOfExpression,
  SyntaxKind.VoidExpression,
]);

/** The whole identifier a constant aliases, where its value is not a proven primitive copy. */
export function keptAliasOf(name: Identifier): Identifier | undefined {
  const initializer = constantInitializer(name);
  const value = initializer === undefined ? undefined : unwrapped(initializer);
  return value !== undefined && isIdentifier(value) && !primitiveValue(value) ? value : undefined;
}

/** A whole constant's initializer in the original lexical scope, never a projected binding. */
function constantInitializer(name: Identifier): Expression | undefined {
  const selected = frameBindingOf(name);
  const binding = selected?.binding;
  return binding !== undefined &&
    selected?.keys.length === 0 &&
    isVariableDeclaration(binding) &&
    isIdentifier(binding.name) &&
    isVariableDeclarationList(binding.parent) &&
    /^const\b/u.test(binding.parent.getText(binding.getSourceFile()))
    ? binding.initializer
    : undefined;
}

/** A primitive copied through constants cannot make the source's storage a mutation receiver. */
function primitiveValue(name: Identifier): boolean {
  const seen = new Set<Identifier>();
  let current = name;
  while (!seen.has(current)) {
    seen.add(current);
    const initializer = constantInitializer(current);
    if (initializer === undefined) return PRIMITIVE_GLOBALS.has(globalOf(current) ?? '');
    const value = unwrapped(initializer);
    if (!isIdentifier(value)) {
      return (
        PRIMITIVE_KINDS.has(value.kind) ||
        (isBinaryExpression(value) && PRIMITIVE_BINARY_OPERATORS.has(value.operatorToken.kind))
      );
    }
    current = value;
  }
  return false;
}
