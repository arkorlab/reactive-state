import {
  type Expression,
  isIdentifier,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { framedAtMethod } from './framed-at-methods.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { framedAssignedValues } from './framed-writes.ts';

/** Source-proven synchronous callback results, retaining writes at each immutable alias capture. */
export function framedReplacementCallback(
  callback: Expression,
  error: (value: Expression) => boolean,
): boolean {
  const pending: Expression[] = [callback];
  const seen = new Set<Node>();
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const value = unwrapped(at);
    if (seen.has(value)) continue;
    seen.add(value);
    if (framedAtMethod(value, error) === true) return true;
    if (!isIdentifier(value)) continue;
    pending.push(...framedAssignedValues(value));
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0) continue;
    const { binding } = selected;
    if (!isVariableDeclaration(binding) || binding.initializer === undefined) continue;
    const statement = binding.parent.parent;
    if (
      isVariableStatement(statement) &&
      /^const\s/u.test(statement.declarationList.getText(statement.getSourceFile()))
    )
      pending.push(binding.initializer);
  }
  return false;
}
