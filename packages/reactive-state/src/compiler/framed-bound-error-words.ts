import type { Expression } from 'typescript/ast';

import { framedQuietPrimitive } from './framed-native-evaluation.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** Bound native Error identity does not by itself prove that its message words were locally written. */

const AGGREGATE = new Set(['AggregateError']);
const DOM = new Set(['DOMException']);

/** Native messages occupy a different slot for AggregateError, and DOMException also converts its name. */
export function boundErrorWordSlots(target: Expression): readonly number[] {
  if (framedNativeConstructor(target, DOM)) return [0, 1];
  return [framedNativeConstructor(target, AGGREGATE) ? 1 : 0];
}

/** Only omitted or source-known primitive message values establish the added local-word exemption. */
export function locallyWrittenBoundWords(target: Expression, args: readonly Expression[]): boolean {
  return boundErrorWordSlots(target).every((index) => {
    const value = args[index];
    return value === undefined || framedQuietPrimitive(value);
  });
}
