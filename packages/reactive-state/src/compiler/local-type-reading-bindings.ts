import type { TypeReading } from './local-type-environment.ts';

/** Repeated written operands with the same actual environment cannot select another result. */
export function sameBindings(left: TypeReading, right: TypeReading): boolean {
  if (left.bindings.size !== right.bindings.size) return false;
  for (const [parameter, value] of left.bindings) {
    if (right.bindings.get(parameter) !== value) return false;
  }
  return true;
}
