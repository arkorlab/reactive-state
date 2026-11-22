import { type CallExpression, isSpreadElement } from 'typescript/ast';

import { type Origin } from './proxy-values.ts';

/** Natives of `Object` that give back their target, and that `Object.assign` fills from its sources. */
const GIVING_BACK: ReadonlySet<string> = new Set([
  'Object.assign',
  'Object.freeze',
  'Object.preventExtensions',
  'Object.seal',
  'Object.setPrototypeOf',
]);

/**
 * What the result of a call of a native function of the global namespaces (`Object.assign`,
 * `Object.freeze`, `Array.of`, `Object.fromEntries`, …) can hold: each argument, which the call
 * may give back or build into what it returns. An `Object` function that gives back its target
 * (and `Object.assign`, of its sources) keeps the read of the result as the read of the argument;
 * any other keeps the whole argument, which only refuses more. A native whose result is a
 * scalar is named apart (`SCALARS` of `proxy-origins.ts`), and a call of a source function is
 * followed into its body instead.
 */
export function nativeResultOrigins(
  call: CallExpression,
  path: string,
  at: Origin,
): readonly Origin[] {
  const kept = GIVING_BACK.has(path) ? at.keys : [];

  return call.arguments.map((argument) => {
    const spread = isSpreadElement(argument);

    return {
      ...at,
      excluded: undefined,
      keys: spread ? [null, ...kept] : kept,
      spread: undefined,
      value: spread ? argument.expression : argument,
    };
  });
}
