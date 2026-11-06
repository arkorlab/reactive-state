import {
  isExpressionWithTypeArguments,
  isTypeReferenceNode,
  isIdentifier,
  isParenthesizedTypeNode,
  type ExpressionWithTypeArguments,
  type TypeNode,
} from 'typescript/ast';

import { localTypeBinding } from './local-type-aliases.ts';
import { qualifiedBuiltinName } from './local-type-builtins.ts';
import { capturedTypeReading } from './local-type-captured-sequences.ts';
import type { TypeReading } from './local-type-environment.ts';
import { preservedUtilityType } from './local-type-members.ts';

/** A requested generic argument of a resolved native reference, in its original environment. */
export interface NativeArgumentSelection {
  readonly nativeNames: ReadonlySet<string>;
  readonly index: number;
}

/** A class base and a type reference retain their written argument before its bindings are resolved. */
export function selectedNativeArgument(
  at: TypeReading,
  builtin: string | undefined,
  selection: NativeArgumentSelection | undefined,
): TypeReading | undefined {
  if (selection === undefined || builtin === undefined || !selection.nativeNames.has(builtin))
    return undefined;
  const { type } = at;
  if (!isTypeReferenceNode(type) && !isExpressionWithTypeArguments(type)) return undefined;
  const argument = type.typeArguments?.[selection.index];
  return argument === undefined ? undefined : { ...at, type: argument };
}

/** A property-preserving utility's argument, only where its built-in name is unbound. */
export function utilityArgument(
  type: TypeNode | ExpressionWithTypeArguments,
): TypeNode | undefined {
  if (!isTypeReferenceNode(type)) return undefined;
  let name: string | undefined;
  if (isIdentifier(type.typeName)) {
    if (localTypeBinding(type.typeName) === undefined) name = type.typeName.text;
  } else name = qualifiedBuiltinName(type.typeName);
  return name === undefined ? undefined : preservedUtilityType(name, type.typeArguments);
}

/** Captured slots, parentheses and explicitly permitted field-preserving utilities. */
export function transparentOperand(
  reading: TypeReading,
  utilities: boolean,
): TypeReading | undefined {
  const { type } = reading;
  const captured = capturedTypeReading(type);
  if (captured !== undefined) return captured;
  if (isParenthesizedTypeNode(type)) return { ...reading, type: type.type };
  const utility = utilities ? utilityArgument(type) : undefined;
  return utility === undefined ? undefined : { ...reading, type: utility };
}
