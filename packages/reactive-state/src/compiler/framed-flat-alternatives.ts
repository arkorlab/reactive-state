import {
  type Expression,
  type Identifier,
  isIdentifier,
  isVariableDeclaration,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { framedSourceValues } from './framed-sources.ts';

/** A flatMap return is flattened once for each value it may be, never as the one value it was written as. */

export interface ReturnAlternative {
  readonly value: Expression;
  /** The expression the callback returns, which the alternative was reached from. */
  readonly from: Expression;
}

/**
 * The values a flatMap callback's return may be: the branches of a conditional, a logical or a comma
 * expression, an assignment's value, and those of a whole constant's initializer that is one, read
 * by their own. A branch can be an array where its sibling is not, so flattening what the return is
 * written as, a conditional taken for one scalar, would give the branches an output position the
 * flattening never gives them. A return that is none of these stands as written. A branch is read
 * once however many names of it the return holds, so a chain of constants that each hold the one
 * before twice costs as much as it is long.
 */
export function flatReturnAlternatives(returned: Expression): readonly ReturnAlternative[] {
  const found: ReturnAlternative[] = [];
  const pending: Expression[] = [returned];
  const seen = new Set<Node>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const value = unwrapped(next);
    const source = isIdentifier(value) ? constantSource(value) : value;
    const key = source ?? value;
    if (seen.has(key)) continue;
    seen.add(key);
    const branches = source === undefined ? undefined : framedSourceValues(source);
    if (branches === undefined) found.push({ value: next, from: returned });
    else pending.push(...branches.toReversed());
  }
  return found;
}

/** What a whole constant name holds, through the names of whole constants it is the initializer of. */
function constantSource(name: Identifier): Expression | undefined {
  let value: Expression = name;
  const seen = new Set<Node>();
  while (isIdentifier(value)) {
    const declaration = frameDeclarationOf(value);
    if (
      declaration === undefined ||
      seen.has(declaration) ||
      !isVariableDeclaration(declaration) ||
      !isIdentifier(declaration.name) ||
      declaration.initializer === undefined ||
      !/^const\b/u.test(declaration.parent.getText(declaration.getSourceFile()))
    )
      return undefined;
    seen.add(declaration);
    value = unwrapped(declaration.initializer);
  }
  return value;
}
