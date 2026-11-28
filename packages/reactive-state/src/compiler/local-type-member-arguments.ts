import type { TypeNode } from 'typescript/ast';

import { constrainedOperands } from './local-type-constrained-operands.ts';
import { initialTypeReading } from './local-type-environment.ts';
import type { NativeArgumentSelection } from './local-type-native-arguments.ts';
import { namesReadings, operandReadings } from './local-type-reading.ts';
import { memberReadings } from './local-type-selections.ts';

/**
 * A resolved native reference's selected actual argument where the reference stands at a written
 * member path of the type (`options.list` of `{ list: Set<Error> }`): the member is selected through
 * aliases, optional members and a type parameter's constraint as `namesLocalMemberType` selects it,
 * and the argument as `namesLocalTypeArgument` does.
 */
export function namesLocalMemberTypeArgument(
  type: TypeNode | undefined,
  keys: readonly string[],
  selection: NativeArgumentSelection,
  names: ReadonlySet<string>,
): boolean {
  if (type === undefined) return false;
  const operands = constrainedOperands((at) => operandReadings(at, names));
  return namesReadings(memberReadings(initialTypeReading(type), keys, operands), names, selection);
}
