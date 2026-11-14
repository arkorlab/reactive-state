import {
  type ArrayLiteralExpression,
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isCallExpression,
  isElementAccessExpression,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isOmittedExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isStringLiteral,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import type { ArrayElementView } from './framed-array-rest.ts';
import { frameMemberName } from './framed-bindings.ts';
import { concatQuietArguments, concatSource } from './framed-concat-properties.ts';
import { iteratorCarriedUnexposed } from './framed-iterator-carried.ts';
import { iteratorPrefixQuiet } from './framed-iterator-guards.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';

/** Native copies select exact source slots only at an immediate read of a quiet literal source. */

const INFINITY = new Set(['Infinity']);
const REFLECT = new Set(['Reflect.apply']);
const TAIL = { reflect: 3 } as const;
const AT_INDEX = /^number:(?:0|[1-9]\d*)$/u;

/** A direct or known borrowed native array method call, with its explicit receiver. */
export interface QuietCopyCall {
  readonly call: CallExpression;
  readonly receiver: Expression;
  readonly given: readonly Expression[];
  readonly unknownArguments?: boolean;
}

/** The written literal source and every operand evaluated before the native method reads it. */
export interface QuietCopy {
  readonly source: ArrayLiteralExpression;
  readonly roots: readonly Expression[];
}

/** The literal source of an immediately selected native call whose evaluated operands stay quiet. */
export function quietCopy(
  copy: QuietCopyCall,
  operands: readonly Expression[],
  stable: (receiver: Expression) => boolean,
): QuietCopy | undefined {
  return immediateSelection(copy.call) ? quietSource(copy, operands, stable) : undefined;
}

/** The literal source of a native call whose receiver, operands and wrapper tails stay quiet. */
export function quietSource(
  copy: QuietCopyCall,
  operands: readonly Expression[],
  stable: (receiver: Expression) => boolean,
): QuietCopy | undefined {
  if (copy.unknownArguments === true) return undefined;
  const source = concatSource(copy.receiver, stable);
  if (source === undefined || !isArrayLiteralExpression(source)) return undefined;
  const tails = wrapperTails(copy.call);
  if (tails === undefined) return undefined;
  const roots = [source, ...operands, ...tails];
  return quietValues(roots, stable) && iteratorPrefixQuiet(source, copy.call)
    ? { source, roots }
    : undefined;
}

/** Selected written slots keep their values while their carried bindings stay unexposed. */
export function quietElementViews(
  copy: QuietCopyCall,
  quiet: QuietCopy,
  selected: readonly Expression[],
): readonly ArrayElementView[] | undefined {
  const elements = selected.filter((each) => !isOmittedExpression(each));
  return iteratorCarriedUnexposed(
    quiet.roots,
    elements.map((value) => ({ value })),
    copy.call,
  )
    ? elements.map((value) => ({ value, index: undefined, element: true, capture: copy.call }))
    : undefined;
}

/** A signed native infinity performs no application conversion, unlike an arbitrary unary operand. */
export function signedInfinity(value: Expression): number | undefined {
  if (!isPrefixUnaryExpression(value) || !framedNativeConstructor(value.operand, INFINITY)) return;
  if (value.operator === SyntaxKind.MinusToken) return -Infinity;
  return value.operator === SyntaxKind.PlusToken ? Infinity : undefined;
}

/** A direct member read consumes a selected value before a saved one can be rewritten. */
export function immediateMember(value: Expression): boolean {
  const { at, parent } = useOf(value);
  if (isPropertyAccessExpression(parent) && parent.expression === at) return true;
  return (
    isElementAccessExpression(parent) &&
    parent.expression === at &&
    framedMapKey(parent.argumentExpression) !== undefined
  );
}

/** A direct indexed member is consumed before a saved result array or value can be rewritten. */
export function immediateSelection(value: Expression): boolean {
  const { at, parent } = useOf(value);
  if (isElementAccessExpression(parent))
    return (
      parent.expression === at &&
      framedMapKey(parent.argumentExpression) !== undefined &&
      immediateMember(parent)
    );
  const call = parent.parent;
  return (
    isPropertyAccessExpression(parent) &&
    parent.expression === at &&
    parent.name.text === 'at' &&
    isCallExpression(call) &&
    call.expression === parent &&
    fixedAtIndex(call.arguments) &&
    immediateMember(call)
  );
}

/** A native at by an omitted or written nonnegative integer index runs no conversion of the key. */
function fixedAtIndex(args: readonly Expression[]): boolean {
  const [first, ...rest] = args;
  if (first === undefined) return true;
  return rest.length === 0 && AT_INDEX.test(framedMapKey(first) ?? '');
}

/** Full wrapper expansion keeps ignored apply tails, including tails inside a source-written spread. */
function wrapperTails(call: CallExpression): readonly Expression[] | undefined {
  const member = unwrapped(call.expression);
  const reflected = framedNativeConstructor(member, REFLECT);
  const applied =
    (isPropertyAccessExpression(member) || isElementAccessExpression(member)) &&
    frameMemberName(member) === 'apply';
  if (!reflected && !applied) return [];
  const all = framedArgumentPrefix(call, call.arguments, Infinity);
  if (all.unknown || all.alternatives !== undefined) return undefined;
  const start = reflected ? TAIL.reflect : 2;
  return all.values.slice(start);
}

/** Source construction and all evaluated arguments run without application effects. */
function quietValues(
  values: readonly Expression[],
  stable: (value: Expression) => boolean,
): boolean {
  const pending = [...values];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    const value = unwrapped(each);
    if (signedInfinity(value) !== undefined) continue;
    if (isOmittedExpression(value) || concatQuietArguments([value], stable)) continue;
    if (isArrayLiteralExpression(value)) {
      pending.push(...value.elements);
      continue;
    }
    if (!quietErrorConstruction(value)) return false;
  }
  return true;
}

/** A native Error with no arguments or one literal message has no application conversion. */
export function quietErrorConstruction(value: Expression): boolean {
  if (!isNewExpression(value) || !framedNativeConstructor(value.expression, STANDARD_ERRORS))
    return false;
  const args = value.arguments ?? [];
  if (args.length === 0) return true;
  if (args.length !== 1 || args[0] === undefined) return false;
  const message = unwrapped(args[0]);
  return isStringLiteral(message) || isNoSubstitutionTemplateLiteral(message);
}
