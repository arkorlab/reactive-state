import {
  type CallExpression,
  type Expression,
  isIdentifier,
  isVariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { framedArrayReduction } from './framed-array-reductions.ts';
import { framedArrayRemoval } from './framed-array-removals.ts';
import { framedArrayAt, framedArrayFind } from './framed-array-selections.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { namesTypedElements } from './framed-iterated-types.ts';
import { framedLiteralObject } from './framed-literal-data.ts';

/** Native array selectors retain the selected error and the origin of its words. */
export function framedArrayResult(
  call: CallExpression,
  made: boolean,
  names: ReadonlySet<string>,
  error: (value: Expression, local: boolean, keys?: readonly string[]) => boolean,
): boolean | undefined {
  const classify = (proof: Parameters<typeof framedArrayAt>[1]) => {
    return (
      framedArrayAt(call, proof) ??
      framedArrayFind(call, proof) ??
      framedArrayRemoval(call, proof) ??
      framedArrayReduction(call, proof)
    );
  };
  const selected = classify({
    error: (each, keys) => error(each, made, keys),
    typed: (each, index) => namesTypedElements(each, index, names),
  });
  if (selected === true) return true;
  if (
    !made &&
    classify({ error: (each, keys) => error(each, true, keys), typed: () => false }) === true &&
    classify({
      error: (each, keys) => !framedLiteralObject(each) && !error(each, true, keys),
      typed: opaqueArrayOrigin,
    }) === false
  )
    return false;
  return undefined;
}

/** Only a whole variable initializer can close an array origin while its written values are checked. */
function opaqueArrayOrigin(node: Expression): boolean {
  const value = unwrapped(node);
  if (!isIdentifier(value)) return true;
  const selected = frameBindingOf(value);
  return (
    selected === undefined ||
    selected.keys.length > 0 ||
    !isVariableDeclaration(selected.binding) ||
    selected.binding.initializer === undefined
  );
}
