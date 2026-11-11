import {
  factory,
  isCallSignatureDeclaration,
  isFunctionTypeNode,
  isIdentifier,
  isIntersectionTypeNode,
  isTypeLiteralNode,
  isTypeReferenceNode,
  type FunctionTypeNode,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { localTypeBinding } from './local-type-aliases.ts';
import { qualifiedBuiltinName } from './local-type-builtins.ts';
import type { TypeReading } from './local-type-environment.ts';
import { interfaceShapeReadings } from './local-type-interface-members.ts';
import {
  omittedGenericReading,
  type OmittedCallableReading,
} from './local-type-omitted-generics.ts';
import { receiverAcceptsUnknown } from './local-type-receiver-domains.ts';
import { receiverReading } from './local-type-receivers.ts';

const OMITTED = new WeakMap<Node, FunctionTypeNode>();

type Operands = (reading: TypeReading) => readonly TypeReading[];

/** Native OmitThisParameter preserves a callable result while removing a known explicit receiver. */
export function omittedReceiverReadings(
  at: TypeReading,
  operands: Operands,
): readonly TypeReading[] | undefined {
  const { type } = at;
  if (!isTypeReferenceNode(type)) return undefined;
  let name: string | undefined;
  if (isIdentifier(type.typeName)) {
    if (localTypeBinding(type.typeName) === undefined) name = type.typeName.text;
  } else name = qualifiedBuiltinName(type.typeName);
  if (name !== 'OmitThisParameter') return undefined;
  const argument = type.typeArguments?.length === 1 ? type.typeArguments[0] : undefined;
  if (argument === undefined) return [];
  const original = { ...at, type: argument };
  const readings = operands(original);
  if (readings.some((reading) => keepsOriginalReceiver(reading, operands))) return readings;
  // An arm whose receiver cannot be removed keeps its own type beside the others, rather than
  // leaving them alone to stand for the whole operand; a lone such arm still reads as no type.
  return readings.flatMap((reading) => {
    const omitted = omittedCallable(reading, operands, original);
    return omitted.length === 0 && readings.length > 1 ? [reading] : omitted;
  });
}

/** A noncallable or receiver-free operand keeps its type; a known receiver leaves a signature. */
function omittedCallable(
  at: TypeReading,
  operands: Operands,
  original: TypeReading,
): readonly TypeReading[] {
  const selected = lastCallable(at, operands);
  if (selected === undefined) return [at];
  const receiver = receiverReading(selected.reading, selected.signature.parameters);
  if (!knownReceiver(receiver, operands)) return [at];
  const reading = omittedGenericReading(selected, receiver, original);
  if (reading === undefined) return [];
  let type = OMITTED.get(selected.signature);
  if (type === undefined) {
    type = factory.createFunctionTypeNode(
      undefined,
      selected.signature.parameters.slice(1),
      selected.signature.type ?? factory.createKeywordTypeNode(SyntaxKind.UnknownKeyword),
    );
    OMITTED.set(selected.signature, type);
  }
  return [{ ...reading, type }];
}

/** One unknown receiver arm makes the native union-wide receiver guard keep its whole operand. */
function keepsOriginalReceiver(at: TypeReading, operands: Operands): boolean {
  const selected = lastCallable(at, operands);
  return (
    selected === undefined ||
    !knownReceiver(receiverReading(selected.reading, selected.signature.parameters), operands)
  );
}

/** A known explicit receiver excludes the native any/unknown preservation guard. */
function knownReceiver(
  receiver: TypeReading | undefined,
  operands: Operands,
): receiver is TypeReading {
  return receiver !== undefined && !receiverAcceptsUnknown(receiver, operands);
}

/** The existing interface and intersection traversal selects the last written call signature. */
function lastCallable(at: TypeReading, operands: Operands): OmittedCallableReading | undefined {
  let result: OmittedCallableReading | undefined;
  let unknown = false;
  const pending = [at];
  for (let reading = pending.pop(); reading !== undefined; reading = pending.pop()) {
    const { type } = reading;
    const interfaces = interfaceShapeReadings(reading, operands);
    if (interfaces !== undefined) {
      unknown ||= interfaces.unknown;
      pending.push(...interfaces.sources.toReversed());
    } else if (isIntersectionTypeNode(type))
      pending.push(
        ...type.types.flatMap((member) => operands({ ...reading, type: member })).toReversed(),
      );
    else if (isFunctionTypeNode(type)) result = { reading, signature: type };
    else if (isTypeLiteralNode(type)) {
      for (const member of type.members) {
        if (isCallSignatureDeclaration(member)) result = { reading, signature: member };
      }
    }
  }
  return result === undefined ? undefined : { ...result, unknown };
}
