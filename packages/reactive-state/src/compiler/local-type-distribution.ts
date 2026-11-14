import {
  factory,
  isClassDeclaration,
  isClassExpression,
  isIdentifier,
  isInterfaceDeclaration,
  isQualifiedName,
  isTypeParameterDeclaration,
  isTypeReferenceNode,
  isUnionTypeNode,
  SyntaxKind,
  type TypeNode,
  type TypeParameterDeclaration,
} from 'typescript/ast';

import { localTypeBinding } from './local-type-aliases.ts';
import { qualifiedBuiltinName } from './local-type-builtins.ts';
import { typeReadingKey, type TypeReading } from './local-type-environment.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';

/** The separate argument environments in which a naked generic conditional is evaluated. */

type Resolve = (reading: TypeReading) => TypeReading | undefined;

/** `boolean` is the union `true | false`, over whose literals a naked parameter distributes. */
const BOOLEANS: readonly TypeNode[] = [
  factory.createLiteralTypeNode(factory.createToken(SyntaxKind.TrueKeyword)),
  factory.createLiteralTypeNode(factory.createToken(SyntaxKind.FalseKeyword)),
];

/** A whole boolean retains its two literal alternatives in the original argument environment. */
export function booleanReadings(at: TypeReading): readonly TypeReading[] | undefined {
  return at.type.kind === SyntaxKind.BooleanKeyword
    ? BOOLEANS.map((type) => ({ ...at, type }))
    : undefined;
}

/** Written non-any domains cannot prevent a whole unknown from absorbing their union. */
const NON_ANY = new Set([
  SyntaxKind.ArrayType,
  SyntaxKind.BigIntKeyword,
  SyntaxKind.BooleanKeyword,
  SyntaxKind.ConstructorType,
  SyntaxKind.FunctionType,
  SyntaxKind.LiteralType,
  SyntaxKind.NeverKeyword,
  SyntaxKind.NumberKeyword,
  SyntaxKind.ObjectKeyword,
  SyntaxKind.StringKeyword,
  SyntaxKind.SymbolKeyword,
  SyntaxKind.TupleType,
  SyntaxKind.TypeLiteral,
  SyntaxKind.TypeOperator,
  SyntaxKind.UndefinedKeyword,
  SyntaxKind.VoidKeyword,
]);
const ARRAY_TYPES = new Set(['Array', 'ReadonlyArray']);

export interface ConditionalCheck {
  readonly context: TypeReading;
  readonly checked: TypeReading | undefined;
  readonly distributes: boolean;
}

/**
 * A conditional's checked operands, distributing only its naked parameter over written unions and
 * over `boolean`'s two literals, each bound to the parameter for the branches that read it again.
 */
export function conditionalChecks(
  at: TypeReading,
  checkType: TypeNode,
  resolve: Resolve,
  resolveParameter: Resolve = resolve,
): readonly ConditionalCheck[] {
  const parameter = nakedParameter(checkType, resolveParameter);
  const checked = resolve({ ...at, type: checkType });
  if (parameter === undefined) return [{ checked, context: at, distributes: false }];
  if (checked?.type.kind === SyntaxKind.NeverKeyword) return [];
  const unknown = checked === undefined ? undefined : wholeUnknown(checked, resolve);
  if (unknown !== undefined) {
    const bindings = new Map([...at.bindings, [parameter, unknown]]);
    return [{ checked: unknown, context: { ...at, bindings }, distributes: true }];
  }
  if (checked === undefined || !distributed(checked.type)) {
    return [{ checked, context: at, distributes: true }];
  }
  const result: ConditionalCheck[] = [];
  const pending = [checked];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    const member = resolve(each);
    if (member !== undefined && distributed(member.type)) {
      const types = isUnionTypeNode(member.type) ? member.type.types : BOOLEANS;
      pending.push(...types.map((type) => ({ ...member, type })));
      continue;
    }
    if (member?.type.kind === SyntaxKind.NeverKeyword) continue;
    const bindings = new Map([...at.bindings, [parameter, member ?? each]]);
    result.push({ checked: member, context: { ...at, bindings }, distributes: true });
  }
  return result;
}

/** Whether a checked operand is a union a naked parameter distributes over: written, or `boolean`. */
function distributed(type: TypeReading['type']): boolean {
  return isUnionTypeNode(type) || type.kind === SyntaxKind.BooleanKeyword;
}

/** The parameter a checked alias ultimately names, without substituting any actual argument. */
function nakedParameter(type: TypeNode, resolve: Resolve): TypeParameterDeclaration | undefined {
  const reading = resolve({ aliases: new Set(), bindings: new Map(), type });
  const each = reading?.type;
  if (each === undefined || !isTypeReferenceNode(each) || !isIdentifier(each.typeName)) {
    return undefined;
  }
  const binding = localTypeBinding(each.typeName);
  return binding !== undefined && binding !== null && isTypeParameterDeclaration(binding)
    ? binding
    : undefined;
}

/** Closed written unions retain their original whole unknown before any member is distributed. */
export function wholeUnknown(at: TypeReading, resolve: Resolve): TypeReading | undefined {
  if (!isUnionTypeNode(at.type)) return undefined;
  const pending = [at];
  const seen = new Set<string>();
  let unknown: TypeReading | undefined;
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    const reading = resolve(each);
    if (reading === undefined) return undefined;
    const { type } = reading;
    if (isUnionTypeNode(type)) {
      const key = typeReadingKey(reading);
      if (seen.has(key)) return undefined;
      seen.add(key);
      pending.push(...type.types.map((member) => ({ ...reading, type: member })));
    } else if (type.kind === SyntaxKind.UnknownKeyword && type.pos >= 0) {
      unknown ??= reading;
    } else if (!knownNonAny(reading)) {
      return undefined;
    }
  }
  return unknown;
}

/** Nested any fields do not make an object any; opaque references and intersections prove neither. */
function knownNonAny(at: TypeReading): boolean {
  const { type } = at;
  if (NON_ANY.has(type.kind)) return true;
  if (!isTypeReferenceNode(type) || type.pos < 0) return false;
  const name = type.typeName;
  if (isQualifiedName(name)) {
    const builtin = qualifiedBuiltinName(name);
    return builtin !== undefined && (STANDARD_ERRORS.has(builtin) || ARRAY_TYPES.has(builtin));
  }
  const binding = localTypeBinding(name);
  if (binding === undefined) return STANDARD_ERRORS.has(name.text) || ARRAY_TYPES.has(name.text);
  return (
    binding !== null &&
    (isClassDeclaration(binding) || isClassExpression(binding) || isInterfaceDeclaration(binding))
  );
}
