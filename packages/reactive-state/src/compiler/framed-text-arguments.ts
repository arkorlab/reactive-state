import {
  type CallExpression,
  type NewExpression,
  type Expression,
  isSpreadElement,
} from 'typescript/ast';

import { framedArgumentPrefix } from './framed-keys.ts';

/** Runtime values occupying a consumed argument prefix, with unknown spreads retaining possible entries. */
export function framedConsumedArguments(
  call: CallExpression | NewExpression,
  args: readonly Expression[],
  limit: number,
): readonly Expression[] {
  const prefix = framedArgumentPrefix(call, args, limit);
  if (!prefix.unknown) return prefix.values.slice(0, limit);
  const values: Expression[] = [];
  let remaining = limit;
  for (const argument of args) {
    if (remaining === 0) break;
    if (!isSpreadElement(argument)) {
      values.push(argument);
      remaining -= 1;
      continue;
    }
    const each = framedArgumentPrefix(call, [argument], remaining);
    const selected = each.values.slice(0, remaining);
    values.push(...selected);
    if (each.unknown) values.push(argument, ...(each.alternatives ?? []));
    else remaining -= selected.length;
  }
  return values;
}
