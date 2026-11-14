import {
  type Expression,
  type TypeReferenceNode,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isBigIntLiteral,
  isBinaryExpression,
  isCallExpression,
  isClassExpression,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isParenthesizedTypeNode,
  isTypeReferenceNode,
  isTypeLiteralNode,
  isTypeOperatorNode,
  isVariableDeclaration,
  isVariableStatement,
  isVoidExpression,
  type Node,
  SyntaxKind,
  type TypeNode,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameBindingOf, frameDeclarationOf } from './framed-bindings.ts';
import { framedPatternDefaults } from './framed-pattern-defaults.ts';
import { framedAssignedValues } from './framed-writes.ts';
import { localTypeBinding } from './local-type-aliases.ts';
import { qualifiedBuiltinName } from './local-type-builtins.ts';
import { selectedMemberTypes } from './local-type-members.ts';
import { constantValue } from './numbers.ts';
import { membersKind } from './object-kinds.ts';

/** Comparisons that can convert a supplied error to its engine-chosen primitive words. */

const RELATIONAL: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.GreaterThanEqualsToken,
  SyntaxKind.GreaterThanToken,
  SyntaxKind.LessThanEqualsToken,
  SyntaxKind.LessThanToken,
]);
const LOOSE: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
]);

/** Relational operands convert objects; loose equality converts only against a possible primitive. */
export function framedErrorComparison(
  node: Node,
  names: ReadonlySet<string>,
  error: (value: Expression) => boolean,
): boolean {
  if (!isBinaryExpression(node)) return false;
  const kind = node.operatorToken.kind;
  if (!RELATIONAL.has(kind) && !LOOSE.has(kind)) return false;
  const left = sourceValue(node.left);
  const right = sourceValue(node.right);
  const leftError = primitiveValue(left) === undefined && error(node.left);
  const rightError = primitiveValue(right) === undefined && error(node.right);
  if (RELATIONAL.has(kind)) return leftError || rightError;
  if (sameBinding(node.left, node.right)) return false;
  return (
    (leftError && !withoutConversion(right, names)) ||
    (rightError && !withoutConversion(left, names))
  );
}

/** The existing constant primitive syntax, without executing a conversion or examining object fields. */
function primitiveValue(value: Expression): 'nothing' | 'other' | undefined {
  if (
    value.kind === SyntaxKind.NullKeyword ||
    isVoidExpression(value) ||
    globalPathOf(value)?.join('.') === 'undefined'
  )
    return 'nothing';
  return value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    isBigIntLiteral(value) ||
    constantValue(value) !== undefined
    ? 'other'
    : undefined;
}

/** Whole const aliases retain their source values; cycles remain unresolved. */
function sourceValue(node: Expression): Expression {
  let value = unwrapped(node);
  const seen = new Set<Node>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const initializer = constantInitializer(value);
    if (initializer === undefined) break;
    value = unwrapped(initializer);
  }
  return value;
}

/** Nullish values and written object identities avoid the loose equality ToPrimitive step. */
function withoutConversion(value: Expression, names: ReadonlySet<string>): boolean {
  if (primitiveValue(value) === 'nothing') return true;
  if (
    isArrayLiteralExpression(value) ||
    isObjectLiteralExpression(value) ||
    isNewExpression(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    isClassExpression(value) ||
    value.kind === SyntaxKind.RegularExpressionLiteral
  )
    return true;
  if (isCallExpression(value) && globalPathOf(unwrapped(value.expression))?.join('.') === 'Object')
    return true;
  return isIdentifier(value) && objectParameter(value, names);
}

/** An unchanged parameter keeps its direct or single selected written object bound. */
function objectParameter(name: Identifier, names: ReadonlySet<string>): boolean {
  const selected = frameBindingOf(name);
  if (selected === undefined) return false;
  const { binding } = selected;
  if (
    !isParameterDeclaration(binding) ||
    binding.initializer !== undefined ||
    framedAssignedValues(name).length > 0
  )
    return false;
  if (selected.keys.length === 0) return nativeObjectBound(binding.type, names);
  if (
    selected.keys.length !== 1 ||
    binding.type === undefined ||
    framedPatternDefaults(name, binding)?.length !== 0
  )
    return false;
  const types = selectedMemberTypes(binding.type, selected.keys);
  return (
    types !== undefined && types.length > 0 && types.every((type) => nativeObjectBound(type, names))
  );
}

const OBJECT_TYPES = new Set([
  SyntaxKind.ArrayType,
  SyntaxKind.ConstructorType,
  SyntaxKind.FunctionType,
  SyntaxKind.TupleType,
]);
const ARRAY_TYPES = new Set(['Array', 'ReadonlyArray']);

/** A direct written object-only bound, excluding unions, aliases and shadowed native names. */
function nativeObjectBound(type: TypeNode | undefined, names: ReadonlySet<string>): boolean {
  let value = type;
  while (
    value !== undefined &&
    (isParenthesizedTypeNode(value) ||
      (isTypeOperatorNode(value) && value.operator === SyntaxKind.ReadonlyKeyword))
  )
    value = value.type;
  if (value === undefined) return false;
  if (value.kind === SyntaxKind.ObjectKeyword || OBJECT_TYPES.has(value.kind)) return true;
  if (isTypeLiteralNode(value)) return membersKind(value.members) !== 'shared';
  if (!isTypeReferenceNode(value)) return false;
  const name = objectTypeName(value.typeName);
  return name !== undefined && (names.has(name) || ARRAY_TYPES.has(name));
}

/** Only unbound native type names establish a known object-only reference here. */
function objectTypeName(name: TypeReferenceNode['typeName']): string | undefined {
  if (isIdentifier(name)) return localTypeBinding(name) === undefined ? name.text : undefined;
  return qualifiedBuiltinName(name);
}

/** Two reads of the same lexical name have no intervening conversion or application work. */
function sameBinding(left: Expression, right: Expression): boolean {
  const first = unwrapped(left);
  const second = unwrapped(right);
  if (!isIdentifier(first) || !isIdentifier(second) || first.text !== second.text) return false;
  const declared = frameDeclarationOf(first);
  return declared !== undefined && frameDeclarationOf(second) === declared;
}

/** Only whole const aliases preserve a source-written primitive or object identity. */
function constantInitializer(name: Identifier): Expression | undefined {
  const selected = frameBindingOf(name);
  if (selected === undefined || selected.keys.length > 0) return undefined;
  const { binding } = selected;
  if (!isVariableDeclaration(binding)) return undefined;
  const statement = binding.parent.parent;
  return isVariableStatement(statement) &&
    /^const\s/u.test(statement.declarationList.getText(statement.getSourceFile()))
    ? binding.initializer
    : undefined;
}
