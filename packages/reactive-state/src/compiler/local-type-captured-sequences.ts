import { factory, type Node } from 'typescript/ast';

import type { TypeReading } from './local-type-environment.ts';

/** Captured type positions retain their individual written type environments. */

export interface CapturedPosition {
  readonly reading: TypeReading;
  readonly rest: boolean;
  readonly optional?: boolean;
}

const SLOTS = new WeakMap<Node, TypeReading>();
const SEQUENCES = new WeakMap<Node, readonly CapturedPosition[]>();

/** A private syntax slot denotes its original reading, never its synthetic name. */
export function capturedTypeReading(node: Node): TypeReading | undefined {
  return SLOTS.get(node);
}

/** Original constituent positions retain argument identity instead of fresh synthetic node identities. */
export function capturedSequencePositions(node: Node): readonly CapturedPosition[] | undefined {
  return SEQUENCES.get(node);
}

/** A joint intersection keeps each original operand scope and a stable constituent argument identity. */
export function capturedIntersection(
  context: TypeReading,
  readings: readonly TypeReading[],
): TypeReading {
  const type = factory.createIntersectionTypeNode(readings.map((reading) => capturedSlot(reading)));
  SEQUENCES.set(
    type,
    readings.map((reading) => ({ reading, rest: false })),
  );
  return { ...context, type };
}

/** A whole remaining tuple whose slots keep distinct generic arguments and alias histories. */
export function capturedSequence(
  context: TypeReading,
  positions: readonly CapturedPosition[],
): TypeReading {
  const elements = positions.map((position) => {
    const slot = capturedSlot(position.reading);
    if (position.rest) return factory.createRestTypeNode(slot);
    return position.optional === true ? factory.createOptionalTypeNode(slot) : slot;
  });
  const type = factory.createTupleTypeNode(elements);
  SEQUENCES.set(type, positions);
  return { ...context, type };
}

/** A readonly native rest contributes mutable positions to the inferred remaining array. */
export function capturedArray(context: TypeReading, element: TypeReading): TypeReading {
  const type = factory.createArrayTypeNode(capturedSlot(element));
  SEQUENCES.set(type, [{ reading: element, rest: true }]);
  return { ...context, type };
}

/** Each private slot retains one original lexical reading, without merging its bindings. */
function capturedSlot(reading: TypeReading): ReturnType<typeof factory.createTypeReferenceNode> {
  const slot = factory.createTypeReferenceNode(factory.createIdentifier('__captured_sequence'));
  SLOTS.set(slot, reading);
  return slot;
}
