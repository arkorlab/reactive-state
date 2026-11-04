import type { CallExpression, Expression, Identifier, ParameterDeclaration } from 'typescript/ast';

import { iteratorCarriedUnexposed } from './framed-iterator-carried.ts';
import { type DefaultValue, hasDefaults, parameterDefaults } from './framed-mapper-defaults.ts';
import { quietMapperCall } from './framed-mapper-quiet.ts';
import { mapperSlotValues, type MapperSlot } from './framed-mapper-slots.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';

/** Written defaults a native reducer's returned parameter applies where its incoming value is undefined. */

/** The native reduction, its receiver, and what reaches the returned parameter, where shown. */
export interface ReductionDefaultRead {
  readonly call: CallExpression;
  readonly receiver: Expression;
  readonly incoming: readonly Expression[] | undefined;
}

/**
 * The defaults a reducer's returned accumulator or element parameter, or a name its pattern binds,
 * may take where the values reaching it may be undefined, when the reduction is read immediately
 * by a member and the reducer, its receiver and its arguments run no application code.
 */
export function reductionDefaults(
  name: Identifier,
  parameter: ParameterDeclaration,
  read: ReductionDefaultRead,
): readonly DefaultValue[] {
  if (
    !hasDefaults(name, parameter) ||
    !quietMapperCall(parameter, read.call, read.receiver, { direct: true })
  )
    return [];
  const slots: readonly MapperSlot[] =
    read.incoming === undefined
      ? ['unknown']
      : read.incoming.flatMap((each) => mapperSlotValues(each));
  const defaults = parameterDefaults(name, parameter, slots);
  const values = defaults.map(({ value }) => ({ value }));
  return defaults.some(({ value }) => !framedOriginCoowned(value, read.call)) ||
    !iteratorCarriedUnexposed([read.receiver, ...read.call.arguments], values, read.call)
    ? []
    : defaults;
}
