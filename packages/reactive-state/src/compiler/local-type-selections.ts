import {
  isArrayTypeNode,
  isCallSignatureDeclaration,
  isExpressionWithTypeArguments,
  isFunctionTypeNode,
  isIdentifier,
  isIntersectionTypeNode,
  isNamedTupleMember,
  isOptionalTypeNode,
  isRestTypeNode,
  isTupleTypeNode,
  isParenthesizedTypeNode,
  isTypeLiteralNode,
  isTypeOperatorNode,
  isTypeReferenceNode,
  SyntaxKind,
  type TypeNode,
} from 'typescript/ast';

import { localTypeBinding } from './local-type-aliases.ts';
import { qualifiedBuiltinName } from './local-type-builtins.ts';
import { callableQueryReading } from './local-type-callable-queries.ts';
import type { TypeReading } from './local-type-environment.ts';
import { instanceUtilityReading } from './local-type-instance-utilities.ts';
import { interfaceMemberReadings, interfaceShapeReadings } from './local-type-interface-members.ts';
import {
  indexedKeyofReadings,
  keyedMemberTypes,
  unreadableKeyofReadings,
  writtenKeyofKeys,
} from './local-type-keyof.ts';
import { homomorphicSourceReading } from './local-type-mapped-members.ts';
import { selectedMemberTypes } from './local-type-members.ts';
import { parameterUtilityReading } from './local-type-parameter-utilities.ts';
import { receiverUtilityReading } from './local-type-receivers.ts';
import { writtenReturnReading } from './local-type-return-results.ts';
import { finiteIndexKeys } from './local-type-template-keys.ts';
import { writtenTupleReadings } from './local-type-tuple-selections.ts';
import { projectedIndexReadings, projectedMemberReadings } from './local-type-utility-readings.ts';

/** Written result, member and native array selections that retain each operand's environment. */

type Operands = (reading: TypeReading) => readonly TypeReading[];

const ARRAY_NAMES = new Set(['Array', 'ReadonlyArray']);

/** Written call results and parameter tuples selected by unshadowed native utilities. */
export function returnTypeReadings(
  at: TypeReading,
  operands: Operands,
): readonly TypeReading[] | undefined {
  const { type } = at;
  if (!isTypeReferenceNode(type)) return undefined;
  const name = nativeName(type);
  if (
    name !== 'ReturnType' &&
    name !== 'Parameters' &&
    name !== 'ConstructorParameters' &&
    name !== 'InstanceType' &&
    name !== 'ThisParameterType'
  )
    return undefined;
  const argument = type.typeArguments?.length === 1 ? type.typeArguments[0] : undefined;
  if (argument === undefined) return [];
  return operands({ ...at, type: argument }).flatMap((reading) => {
    const callable = callableQueryReading(reading) ?? reading;
    let result: TypeReading | undefined;
    switch (name) {
      case 'ReturnType': {
        result = callResultReading(callable, operands);
        break;
      }
      case 'InstanceType': {
        result = instanceUtilityReading(callable, operands);
        break;
      }
      case 'ThisParameterType': {
        result = receiverUtilityReading(callable, operands);
        break;
      }
      case 'Parameters':
      case 'ConstructorParameters': {
        result = parameterUtilityReading(callable, name, operands);
        break;
      }
    }
    return result === undefined ? [] : [result];
  });
}

/** The last written call signature supplies an overloaded callable's inferred result. */
function callResultReading(at: TypeReading, operands: Operands): TypeReading | undefined {
  let result: TypeReading | undefined;
  const pending = [at];
  for (let reading = pending.pop(); reading !== undefined; reading = pending.pop()) {
    const { type } = reading;
    const interfaces = interfaceShapeReadings(reading, operands);
    if (interfaces !== undefined) {
      pending.push(...interfaces.sources.toReversed());
    } else if (isIntersectionTypeNode(type)) {
      const signatures = type.types.flatMap((member) => operands({ ...reading, type: member }));
      pending.push(...signatures.toReversed());
    } else if (isFunctionTypeNode(type) && type.type !== undefined) {
      result = writtenReturnReading(reading, type);
    } else if (isTypeLiteralNode(type)) {
      for (const member of type.members) {
        if (isCallSignatureDeclaration(member) && member.type !== undefined) {
          result = writtenReturnReading(reading, member);
        }
      }
    }
  }
  return result;
}

/** Declared fields selected one literal step at a time, without flattening generic bindings. */
export function memberReadings(
  at: TypeReading,
  keys: readonly string[],
  operands: Operands,
): readonly TypeReading[] {
  let selected = [at];
  for (const key of keys) {
    selected = selected.flatMap((reading) => {
      return operands(reading).flatMap((source) => {
        const projected = projectedMemberReadings(source, key, {
          operands,
          select: (projectedSource, member) => memberReadings(projectedSource, [member], operands),
        });
        if (projected !== undefined) return projected;
        const mapped = homomorphicSourceReading(source);
        if (mapped !== undefined) return memberReadings(mapped, [key], operands);
        const members = interfaceMemberReadings(source, key, operands);
        if (members !== undefined)
          return members.map((member) => ({ ...member, aliases: new Set<string>() }));
        if (isExpressionWithTypeArguments(source.type)) return [];
        if (/^(?:0|[1-9]\d*)$/u.test(key)) {
          const tuple = writtenTupleReadings(
            source,
            Number(key),
            (rest, index) => restElementReadings(rest, operands, index),
            operands,
          );
          if (tuple !== undefined)
            return tuple.map((member) => ({ ...member, aliases: new Set<string>() }));
        }
        const element = nativeArrayElement(source.type);
        const types =
          element !== undefined && /^(?:0|[1-9]\d*)$/u.test(key)
            ? [element]
            : selectedMemberTypes(source.type, [key]);
        return types?.map((type) => ({ ...source, aliases: new Set<string>(), type })) ?? [];
      });
    });
  }
  return selected;
}

/** Indexed fields use interface and native utility selections before syntax-only array fallback. */
export function indexedMemberReadings(
  object: TypeReading,
  index: TypeReading,
  operands: Operands,
  resolve: (reading: TypeReading) => TypeReading | undefined,
): readonly TypeReading[] {
  const projected = projectedIndexReadings(object, index, {
    operands,
    select: (reading, key) => memberReadings(reading, [key], operands),
  });
  if (projected !== undefined) return projected;
  const literalKeys = finiteIndexKeys(index, operands);
  if (literalKeys !== undefined)
    return literalKeys.flatMap((key) => memberReadings(object, [key], operands));
  if (isExpressionWithTypeArguments(object.type)) return [];
  if (index.type.kind === SyntaxKind.NumberKeyword) {
    const selected = restElementReadings(object, operands);
    if (selected.length > 0) return selected;
  }
  const keys = writtenKeyofKeys(index, resolve);
  if (keys !== undefined)
    return [
      ...keys.flatMap((member) => memberReadings(object, [member], operands)),
      ...unreadableKeyofReadings(object, index, resolve),
    ];
  const indexedKeys = indexedKeyofReadings(object, index, resolve);
  if (indexedKeys !== undefined) return indexedKeys;
  const members = keyedMemberTypes(object.type, index, resolve) ?? [];
  return members.map((type) => ({ ...object, type }));
}

/** Native rest arrays and finite tuple positions keep their operand's original argument environment. */
function restElementReadings(
  at: TypeReading,
  operands: Operands,
  index?: number,
): readonly TypeReading[] {
  return operands(at).flatMap((source) => {
    if (isExpressionWithTypeArguments(source.type)) return [];
    const element = nativeArrayElement(source.type);
    if (element !== undefined) return [{ ...source, type: element }];
    return (
      writtenTupleReadings(
        source,
        index,
        (rest, relative) => restElementReadings(rest, operands, relative),
        operands,
      ) ?? []
    );
  });
}

/** Native array or tuple elements; a structural numeric index does not prove an array receiver. */
export function arrayElementReadings(
  at: TypeReading,
  operands: Operands,
  index?: number,
): readonly TypeReading[] {
  return operands(at).flatMap((source) => {
    if (isExpressionWithTypeArguments(source.type)) return [];
    const element = nativeArrayElement(source.type);
    const types = element === undefined ? tupleSelection(source.type, index) : [element];
    return types?.map((type) => ({ ...source, type })) ?? [];
  });
}

/** Every position of a finite required tuple may be produced by source iteration. */
export function arrayIterationKeys(
  readings: readonly TypeReading[],
  operands: Operands,
): readonly string[] | undefined {
  const sources = readings.flatMap((reading) => operands(reading));
  if (sources.length === 0) return undefined;
  const keys = new Set<string>();
  for (const source of sources) {
    let type = source.type;
    while (
      isParenthesizedTypeNode(type) ||
      (isTypeOperatorNode(type) && type.operator === SyntaxKind.ReadonlyKeyword)
    )
      type = type.type;
    if (
      !isTupleTypeNode(type) ||
      type.elements.some((element) => {
        return (
          isRestTypeNode(element) ||
          isOptionalTypeNode(element) ||
          (isNamedTupleMember(element) &&
            (element.dotDotDotToken !== undefined || element.questionToken !== undefined))
        );
      })
    )
      return undefined;
    for (const [index] of type.elements.entries()) keys.add(String(index));
  }
  return [...keys];
}

/** A finite tuple's native at position, including each possible length of trailing optional fields. */
function tupleSelection(
  type: TypeNode,
  index: number | undefined,
): readonly TypeNode[] | undefined {
  let each = type;
  while (
    isParenthesizedTypeNode(each) ||
    (isTypeOperatorNode(each) && each.operator === SyntaxKind.ReadonlyKeyword)
  )
    each = each.type;
  if (!isTupleTypeNode(each)) return undefined;
  if (index === undefined) return selectedMemberTypes(each, 'number');
  if (index >= 0) return selectedMemberTypes(each, [String(index)]);
  if (
    each.elements.some((element) => {
      return (
        isRestTypeNode(element) ||
        (isNamedTupleMember(element) && element.dotDotDotToken !== undefined)
      );
    })
  )
    return selectedMemberTypes(each, 'number');
  const firstOptional = each.elements.findIndex((element) => {
    return (
      isOptionalTypeNode(element) ||
      (isNamedTupleMember(element) && element.questionToken !== undefined)
    );
  });
  const minimum = firstOptional === -1 ? each.elements.length : firstOptional;
  const keys: string[] = [];
  for (let length = minimum; length <= each.elements.length; length += 1) {
    const offset = length + index;
    if (offset >= 0) keys.push(String(offset));
  }
  return selectedMemberTypes(each, keys);
}

/** A native array's written element, including readonly syntax and valid global qualifications. */
function nativeArrayElement(type: TypeReading['type']): TypeNode | undefined {
  let each = type;
  while (
    isParenthesizedTypeNode(each) ||
    (isTypeOperatorNode(each) && each.operator === SyntaxKind.ReadonlyKeyword)
  ) {
    each = each.type;
  }
  if (isArrayTypeNode(each)) return each.elementType;
  if (!isTypeReferenceNode(each) || each.typeArguments?.length !== 1) return undefined;
  const name = nativeName(each);
  return name !== undefined && ARRAY_NAMES.has(name) ? each.typeArguments[0] : undefined;
}

/** A type reference's native name only where no local type or namespace binds it. */
function nativeName(type: TypeReading['type']): string | undefined {
  if (!isTypeReferenceNode(type)) return undefined;
  if (!isIdentifier(type.typeName)) return qualifiedBuiltinName(type.typeName);
  return localTypeBinding(type.typeName) === undefined ? type.typeName.text : undefined;
}
