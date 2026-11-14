import {
  type Expression,
  isArrayLiteralExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isVariableDeclaration,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { arrayWritesUnfollowed, writtenArrayElements } from './framed-array-elements.ts';
import { writtenAsWhole } from './framed-array-identity.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { heldMemberWrites } from './framed-held-member-writes.ts';
import { knownUsesOnly } from './framed-known-mentions.ts';

/**
 * What a pattern takes apart may have been written since its literal was: a name a pattern takes apart
 * from a name that holds a literal reads what the name holds when the pattern runs, not what it was
 * written with. A literal written beside the pattern holds what it was written with.
 */

/** How many names a chain of constants may pass before its end is taken for unknown. */
const CHAIN = 32;

/**
 * Whether the name a pattern is given may hold something else than the literal it stands for: a name of
 * the chain is written as a whole, an element or a member of the literal is written (or may be, where a
 * use of the name is not one the compile follows), anywhere the conversion may follow. A literal written
 * where the pattern is, and a name that stands for no literal, are left as they are.
 */
export function sourceChanged(
  source: Expression,
  read: Node,
  scalar: (value: Expression, keys: readonly string[]) => boolean,
): boolean {
  const named = unwrapped(source);
  if (!isIdentifier(named)) return false;
  const chain = bindingsOf(named);
  if (chain === undefined) return false;
  if (chain.some((binding) => writtenAsWhole(binding))) return true;
  const last = chain.at(-1);
  const literal = last?.initializer === undefined ? undefined : unwrapped(last.initializer);
  if (literal !== undefined && isArrayLiteralExpression(literal))
    return (
      arrayWritesUnfollowed(named, read, scalar) || writtenArrayElements(named, read).length > 0
    );
  if (last === undefined || literal === undefined || !isObjectLiteralExpression(literal))
    return false;
  return objectChanged(last, read);
}

/** The declarations a chain of names passes to the literal it ends at, none where it ends at no literal. */
function bindingsOf(name: Expression): readonly FrameBinding[] | undefined {
  const chain: FrameBinding[] = [];
  let value = unwrapped(name);
  for (let links = 0; links <= CHAIN; links += 1) {
    if (isArrayLiteralExpression(value) || isObjectLiteralExpression(value)) return chain;
    if (!isIdentifier(value)) return undefined;
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0) return undefined;
    if (selected.binding.initializer === undefined) return undefined;
    chain.push(selected.binding);
    value = unwrapped(selected.binding.initializer);
  }
  return undefined;
}

/** Whether a member of the object a constant holds is written, or a use of it is not one the compile follows. */
function objectChanged(declaration: FrameBinding, read: Node): boolean {
  if (!isVariableDeclaration(declaration) || !isIdentifier(declaration.name)) return true;
  const { name } = declaration;
  return heldMemberWrites(name, [name], read).length > 0 || !knownUsesOnly(declaration, 'held');
}
