import {
  type Expression,
  isCallExpression,
  isElementAccessExpression,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isStringLiteral,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameMemberName } from './framed-bindings.ts';
import { iteratorQuietValues } from './framed-iterator-guards.ts';
import { framedRaceInput, type RaceInput } from './framed-race-values.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';

/** Finite Promise batches retain immediate inputs and quiet native Error constructions. */

const PROMISES = new Set(['Promise']);

/** A literal-message native Error has no application then getter or constructor callback. */
export function framedBatchInput(expression: Expression): RaceInput | undefined {
  const known = framedRaceInput(expression);
  if (known !== undefined) return known;
  let value = unwrapped(expression);
  while (isCallExpression(value) && nativeResolve(value.expression)) {
    if (!iteratorQuietValues(value.arguments.slice(1))) return undefined;
    const argument = value.arguments[0];
    if (argument === undefined) return undefined;
    value = unwrapped(argument);
  }
  if (!isCallExpression(value) && !isNewExpression(value)) return undefined;
  if (!framedNativeConstructor(value.expression, STANDARD_ERRORS)) return undefined;
  const args = value.arguments ?? [];
  const message = args[0] === undefined ? undefined : unwrapped(args[0]);
  if (args.length === 0) return { value };
  if (message === undefined || args.length !== 1) return undefined;
  return isStringLiteral(message) || isNoSubstitutionTemplateLiteral(message)
    ? { value }
    : undefined;
}

/** Source-written native Promise.resolve envelopes preserve the selected immediate value. */
function nativeResolve(node: Expression): boolean {
  const member = unwrapped(node);
  return (
    (isPropertyAccessExpression(member) || isElementAccessExpression(member)) &&
    frameMemberName(member) === 'resolve' &&
    framedNativeConstructor(member.expression, PROMISES)
  );
}
