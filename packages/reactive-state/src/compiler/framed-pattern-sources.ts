import {
  type ArrayLiteralExpression,
  type Expression,
  isArrayLiteralExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isVariableDeclaration,
  type Node,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { writtenAsWhole } from './framed-array-identity.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { heldMemberWrites } from './framed-held-member-writes.ts';
import { knownUsesOnly } from './framed-known-mentions.ts';
import { mayBeList } from './framed-nested-lists.ts';

/**
 * What a pattern takes apart may have been written since its literal was: a name a pattern takes apart
 * from a name that holds a literal reads what the name holds when the pattern runs, not what it was
 * written with. A literal written beside the pattern holds what it was written with.
 */

/** How many names a chain of constants may pass before its end is taken for unknown. */
const CHAIN = 32;

/**
 * Whether the name a pattern is given may hold something else than the literal it stands for: a name of
 * the chain is written as a whole, an element or a member of the literal is written, or an array that is
 * reordered or resized (`reverse`, `sort`, `splice`, `shift`, `unshift`, `copyWithin`, `fill`, `pop`,
 * `push`), or a use of the name is not one the compile follows, anywhere in the file. A literal written
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
  const last = chain?.at(-1);
  if (chain === undefined || last === undefined) return false;
  if (chain.some((binding) => writtenAsWhole(binding))) return true;
  const literal = last.initializer === undefined ? undefined : unwrapped(last.initializer);
  if (literal === undefined) return false;
  if (isArrayLiteralExpression(literal))
    return (
      holdsContainers(literal, scalar) ||
      !isVariableDeclaration(last) ||
      !knownUsesOnly(last, 'echo')
    );
  if (!isObjectLiteralExpression(literal)) return false;
  return holdsContainers(literal, scalar) || objectChanged(last, read);
}

/**
 * Whether a literal holds an array or an object, or what may be one (an element or a member of an unknown
 * value, a spread): a copy of it (a spread, `slice`, `map`, `Object.assign`) shares what it holds, and a
 * write through the copy is a write to the array or the object the pattern selects from.
 */
function holdsContainers(
  literal: ArrayLiteralExpression | ObjectLiteralExpression,
  scalar: (value: Expression, keys: readonly string[]) => boolean,
): boolean {
  if (isArrayLiteralExpression(literal))
    return literal.elements.some(
      (each) =>
        isSpreadElement(each) || (!isOmittedExpression(each) && mayBeContainer(each, scalar)),
    );
  return literal.properties.some((each) => {
    if (isSpreadAssignment(each)) return true;
    if (isShorthandPropertyAssignment(each))
      return !isIdentifier(each.name) || mayBeContainer(each.name, scalar);
    return isPropertyAssignment(each) && mayBeContainer(each.initializer, scalar);
  });
}

/** Whether a value is, or may be, an array or an object: a literal of either, a name of one, or what may be a list. */
function mayBeContainer(
  value: Expression,
  scalar: (value: Expression, keys: readonly string[]) => boolean,
): boolean {
  const written = unwrapped(value);
  if (isArrayLiteralExpression(written) || isObjectLiteralExpression(written)) return true;
  if (isIdentifier(written) && bindingsOf(written) !== undefined) return true;
  return mayBeList(value, scalar);
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
