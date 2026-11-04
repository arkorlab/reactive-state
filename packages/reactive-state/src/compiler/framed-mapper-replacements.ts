import type { CallExpression, Expression, Identifier, ParameterDeclaration } from 'typescript/ast';

import type { ArrayElementView } from './framed-array-rest.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { iteratorCarriedUnexposed } from './framed-iterator-carried.ts';
import { quietMapperCall } from './framed-mapper-quiet.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedAssignedSources } from './framed-writes.ts';

/** Values a mapper's or reducer's body writes into its returned parameter, which it then returns. */

/** The native call a callback runs for, and its receiver. */
interface ReplacementRead {
  readonly receiver: Expression;
  readonly capture: CallExpression;
}

/**
 * The written replacements a returned parameter, or a name its pattern binds, may hold at its return
 * instead of its source slot, where the callback and its call run no other application code; the
 * call's result is read immediately by index and member, or by a member where `direct`.
 */
export function mapperReplacementViews(
  name: Identifier,
  parameter: ParameterDeclaration,
  read: ReplacementRead,
  direct = false,
): readonly ArrayElementView[] {
  const sources = framedAssignedSources(name);
  if (sources.length === 0) return [];
  const writable = (each: Identifier) => frameBindingOf(each)?.binding === parameter;
  if (!quietMapperCall(parameter, read.capture, read.receiver, { writable, direct })) return [];
  const values = sources.map((source) => ({ value: source.value }));
  if (
    sources.some((source) => !framedOriginCoowned(source.value, read.capture)) ||
    !iteratorCarriedUnexposed([read.receiver, ...read.capture.arguments], values, read.capture)
  )
    return [];
  return sources.map((source) => {
    return {
      value: source.value,
      index: undefined,
      element: true,
      capture: read.capture,
      keys: source.keys,
    };
  });
}
