import type { Expression, Node } from 'typescript/ast';

import { framedArrayCallbackMemberError } from './framed-array-callback-errors.ts';
import { framedValueShape } from './framed-values.ts';

/** Actual error observations keep their callback owner apart from recursively selected sources. */

type ErrorValue = (value: Expression, made: boolean, keys?: readonly string[]) => boolean;

export interface ErrorObservation {
  readonly error: ErrorValue;
  readonly words: (value: Expression | undefined, keys?: readonly string[]) => boolean;
}

/** New native rest-member origins belong only to the original observation's execution owner. */
export function observedErrorAt(
  observer: Node,
  names: ReadonlySet<string>,
  read: ErrorValue,
): ErrorObservation {
  const error: ErrorValue = (value, made, keys = []) => {
    return (
      framedArrayCallbackMemberError(framedValueShape(value).value, made, names, {
        error: read,
        keys,
        observer,
      }) || read(value, made, keys)
    );
  };
  return {
    error,
    words: (value, keys) => value !== undefined && error(value, false, keys),
  };
}
