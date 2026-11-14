import { isIdentifier, isTypeParameterDeclaration, isTypeReferenceNode } from 'typescript/ast';

import { localTypeBinding } from './local-type-aliases.ts';
import { constraintReading, type TypeReading } from './local-type-environment.ts';

/**
 * A type parameter no actual argument fills, `T` of `function f<T extends { e: Error }>(value: T)`,
 * is to the reader what its written constraint says, and nothing but that: where members or elements
 * of a type are selected, it stands for the constraint, through another parameter's and an alias's,
 * as the member or the element of an actual argument would stand.
 */

type Operands = (reading: TypeReading) => readonly TypeReading[];

/** The operands of a reading, each type parameter among them no argument fills read as its constraint. */
export function constrainedOperands(operands: Operands): Operands {
  return (at) => {
    const result: TypeReading[] = [];
    const pending = [at];
    for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
      for (const reading of operands(each)) {
        const constraint = unfilledConstraint(reading);
        if (constraint === undefined) result.push(reading);
        else pending.push(constraint);
      }
    }
    return result;
  };
}

/** The written constraint of a reading that is a type parameter without an actual argument. */
function unfilledConstraint(reading: TypeReading): TypeReading | undefined {
  const { type } = reading;
  if (!isTypeReferenceNode(type) || !isIdentifier(type.typeName)) return undefined;
  const binding = localTypeBinding(type.typeName);
  if (
    binding === undefined ||
    binding === null ||
    !isTypeParameterDeclaration(binding) ||
    reading.bindings.has(binding)
  )
    return undefined;
  return constraintReading(binding, reading);
}

/**
 * Readings selected from the operands stay on the path that reached those operands, which member
 * selection otherwise starts anew. A constraint that names its own parameter through a member then
 * ends as the cycle it is, where a path begun anew would read it again for ever.
 */
export function onPathOf(
  selected: readonly TypeReading[],
  operands: readonly TypeReading[],
): TypeReading[] {
  const keys = operands.flatMap((operand) => [...operand.aliases]);
  return selected.map((reading) => {
    const aliases = new Set(reading.aliases);
    for (const key of keys) aliases.add(key);
    return { ...reading, aliases };
  });
}
