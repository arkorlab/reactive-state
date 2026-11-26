/**
 * What a native copies from an input no array reader reads may be an Error where its declared
 * element type admits one, as `framedMemberAdmitted` reads it at the read keys.
 */

import {
  type CallExpression,
  type Expression,
  isArrayTypeNode,
  isAsExpression,
  isIdentifier,
  isNonNullExpression,
  isParameterDeclaration,
  isParenthesizedExpression,
  isParenthesizedTypeNode,
  isSatisfiesExpression,
  isSpreadElement,
  isTupleTypeNode,
  isTypeAssertion,
  isTypeOperatorNode,
  isTypeReferenceNode,
  isVariableDeclaration,
  isVariableDeclarationList,
  SyntaxKind,
  type TypeNode,
} from 'typescript/ast';

import type { ArrayElementView } from './framed-array-rest.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { framedElementAdmitted, framedMemberAdmitted } from './framed-error-admission.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { localTypeBinding } from './local-type-aliases.ts';

/** Sources an array reader reads where no copy reader expands them: names, member reads, text. */
const READ: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ArrayLiteralExpression,
  SyntaxKind.ElementAccessExpression,
  SyntaxKind.Identifier,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.PropertyAccessExpression,
  SyntaxKind.StringLiteral,
  SyntaxKind.TemplateExpression,
]);
/** The built-in array types whose argument is their element type. */
const ARRAYS = new Set(['Array', 'ReadonlyArray']);

/**
 * Whether a reading of what a native copies (`copied`) may be an Error: where it follows the
 * input, once it reaches one no array reader reads — a parameter, which holds what a caller gives;
 * a call or a construction no copy reader expands; or anything but a written array, a name, a
 * member read or text, a comma that may run code first among them — and otherwise at once; in
 * either case only where the declared element type admits an Error at the keys read past the
 * copied element.
 */
export function framedCopiedUnread(reading: ArrayElementView): boolean {
  const { copied, value } = reading;
  if (copied === undefined) return false;
  const selected = isIdentifier(value) ? frameBindingOf(value) : undefined;
  const binding = selected?.binding;
  const unread =
    !copied.follow ||
    (binding === undefined ? !READ.has(value.kind) : isParameterDeclaration(binding));
  if (!unread) return false;
  // A parameter whose elements are the copied ones declares them itself, more nearly, where the
  // reader can read its annotation as an array's or a tuple's; else the factory's type decides. A
  // name a pattern takes out of the parameter (`[first]: Error[][]`) has no annotation of its own.
  const whole = selected?.keys.length === 0;
  const own =
    whole && copied.follow && copied.own ? ownElementsAdmitted(binding?.type, reading) : undefined;
  return own ?? framedMemberAdmitted(copied.declared, (reading.keys ?? []).slice(copied.depth));
}

/**
 * Whether the elements a parameter's annotation declares admit an Error at the read position and
 * keys: a tuple's or an array's, `T[]` or `readonly T[]`, read at the position
 * (`framedElementAdmitted`), or the element of the global `Array<T>` or `ReadonlyArray<T>`. None
 * for an annotation the reader cannot read so.
 */
function ownElementsAdmitted(
  type: TypeNode | undefined,
  reading: ArrayElementView,
): boolean | undefined {
  if (type === undefined) return undefined;
  const keys = reading.keys ?? [];
  const bare = bareType(type);
  if (isTupleTypeNode(bare) || isArrayTypeNode(bare))
    return framedElementAdmitted(type, reading.index, keys);
  const element = elementType(type);
  return element === undefined ? undefined : framedMemberAdmitted(element, keys);
}

/**
 * What a native maps through a callback an unresolved spread supplies, `[0].map(...mappers())`:
 * the result of one the compile cannot read, which may be an Error where the call's declared
 * result type, its type argument, admits one at the read keys (`copied`, not followed). None where
 * the mapping reads its callback, or no spread supplies it.
 */
export function framedUnreadCallback(
  call: CallExpression,
  mapping: { readonly callback: Expression | undefined; readonly expanded: boolean },
): readonly ArrayElementView[] | undefined {
  const spread = call.arguments.find((each) => isSpreadElement(each));
  if (spread === undefined || !isSpreadElement(spread)) return undefined;
  if (!mapping.expanded || mapping.callback !== undefined) return undefined;
  if (framedArgumentPrefix(call, call.arguments, Infinity, false).alternatives !== undefined)
    return undefined;
  const copied = { declared: call.typeArguments?.[0], follow: false, depth: 0, own: false };
  return [{ value: spread.expression, index: undefined, capture: call, copied }];
}

/**
 * The declared element type of an array a native copies from or appends to: a type assertion on
 * it, else the annotation of the name it reads, through whole `const` aliases, as an array's or a
 * built-in `Array`'s or `ReadonlyArray`'s element. None where the compile cannot read one.
 */
export function framedDeclaredElements(array: Expression): TypeNode | undefined {
  let value = array;
  const seen = new Set<FrameBinding>();
  for (;;) {
    if (
      isParenthesizedExpression(value) ||
      isNonNullExpression(value) ||
      isSatisfiesExpression(value)
    )
      value = value.expression;
    else if (isAsExpression(value) || isTypeAssertion(value)) return elementType(value.type);
    else if (isIdentifier(value)) {
      const selected = frameBindingOf(value);
      const binding = selected?.binding;
      if (binding === undefined || selected?.keys.length !== 0 || seen.has(binding))
        return undefined;
      if (binding.type !== undefined) return elementType(binding.type);
      if (
        !isVariableDeclaration(binding) ||
        !isVariableDeclarationList(binding.parent) ||
        !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
        binding.initializer === undefined
      )
        return undefined;
      seen.add(binding);
      value = binding.initializer;
    } else return undefined;
  }
}

/**
 * An array type's element type, past parentheses and `readonly`: `T[]`'s, or that of the global
 * `Array<T>` or `ReadonlyArray<T>`, which no local type of the name shadows.
 */
function elementType(declared: TypeNode): TypeNode | undefined {
  const type = bareType(declared);
  if (isArrayTypeNode(type)) return type.elementType;
  return isTypeReferenceNode(type) &&
    isIdentifier(type.typeName) &&
    ARRAYS.has(type.typeName.text) &&
    localTypeBinding(type.typeName) === undefined
    ? type.typeArguments?.[0]
    : undefined;
}

/** A type past its parentheses and `readonly` operators. */
function bareType(declared: TypeNode): TypeNode {
  let type = declared;
  while (
    isParenthesizedTypeNode(type) ||
    (isTypeOperatorNode(type) && type.operator === SyntaxKind.ReadonlyKeyword)
  )
    type = type.type;
  return type;
}
