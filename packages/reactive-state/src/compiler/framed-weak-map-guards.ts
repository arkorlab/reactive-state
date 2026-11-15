import {
  type CallExpression,
  type Expression,
  isBinaryExpression,
  type Node,
  SyntaxKind,
  isElementAccessExpression,
  isNewExpression,
  isArrayLiteralExpression,
  isOmittedExpression,
  type NewExpression,
  isStringLiteral,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf, useOf } from './code-globals.ts';
import { frameMemberName } from './framed-bindings.ts';
import { iteratorCarriedUnexposed } from './framed-iterator-carried.ts';
import { iteratorQuietValues } from './framed-iterator-guards.ts';
import { framedAppliedArguments, framedArgumentPrefix } from './framed-keys.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { framedNativeArguments } from './framed-native-arguments.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedOriginPrefix } from './framed-origin-prefix.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';

/** New WeakMap mutation origins retain quiet evaluated inputs and unexposed carried fields. */

const GETTERS = new Set(['WeakMap.prototype.get']);
const SETTERS = new Set(['WeakMap.prototype.set']);
const TAIL = { reflect: 3 } as const;

/** Complete evaluated wrapper tails stay part of the proof even where the native method ignores them. */
export function weakMapWritesQuiet(
  read: CallExpression,
  writes: readonly { readonly call: CallExpression; readonly value: Expression }[],
  construction: NewExpression,
): boolean {
  if (!immediateRead(read) || !constructionQuiet(construction, read)) return false;
  const roots: Expression[] = [];
  const modeled = new Set<Node>(writes.map((write) => write.call));
  for (const call of [read, ...writes.map((write) => write.call)]) {
    const values = invocationValues(call, call === read ? 'get' : 'set');
    if (values === undefined || !quietValues(values, call === read ? modeled : undefined))
      return false;
    roots.push(...values);
  }
  return (
    framedOriginPrefix(read, {
      call: (node) => writes.some((write) => write.call === node),
      construct: (node) => node === construction,
    }) &&
    writes.every(({ value }) => framedOriginCoowned(value, read)) &&
    iteratorCarriedUnexposed(roots, writes, read)
  );
}

/**
 * Native Error construction with quiet literal inputs has no application side effects of its own;
 * a modeled write the read evaluates first, `(weak.set(key, error), key)`, is part of the proof.
 */
function quietValues(values: readonly Expression[], modeled?: ReadonlySet<Node>): boolean {
  return values.every((value) => {
    let current = unwrapped(value);
    while (
      isBinaryExpression(current) &&
      current.operatorToken.kind === SyntaxKind.CommaToken &&
      modeled?.has(unwrapped(current.left)) === true
    )
      current = unwrapped(current.right);
    return (
      iteratorQuietValues([current]) ||
      (isNewExpression(current) &&
        framedNativeConstructor(current.expression, STANDARD_ERRORS) &&
        quietErrorArguments(current.arguments ?? []))
    );
  });
}

/** Direct receiver methods and explicit native borrowing keep their consumed values and ignored tails. */
function invocationValues(call: CallExpression, method: string): readonly Expression[] | undefined {
  const callee = unwrapped(call.expression);
  const native = framedNativeArguments(call, method === 'get' ? GETTERS : SETTERS);
  if (native === undefined) {
    return (isPropertyAccessExpression(callee) || isElementAccessExpression(callee)) &&
      frameMemberName(callee) === method
      ? argumentsOf(call, call.arguments)
      : undefined;
  }
  if (native.constructed || native.args === undefined) return undefined;
  const consumed = argumentsOf(call, native.args);
  const original = argumentsOf(call, call.arguments);
  if (consumed === undefined || original === undefined) return undefined;
  const reflect = globalPathOf(callee)?.join('.') === 'Reflect.apply';
  const apply = !reflect && frameMemberName(callee) === 'apply';
  const offset = apply ? 2 : 1;
  const tail = original.slice(reflect ? TAIL.reflect : offset);
  return [...consumed, ...tail];
}

/** Opaque spreads retain their old boundary instead of hiding an evaluated argument. */
function argumentsOf(
  call: CallExpression,
  args: readonly Expression[],
): readonly Expression[] | undefined {
  const prefix = framedArgumentPrefix(call, args, Infinity);
  return prefix.unknown || prefix.alternatives !== undefined ? undefined : prefix.values;
}

/** Only an absent or literal text Error message proves conversion and options creation quiet. */
function quietErrorArguments(args: readonly Expression[]): boolean {
  if (args.length === 0) return true;
  if (args.length !== 1) return false;
  const first = args[0];
  if (first === undefined) return false;
  const value = unwrapped(first);
  return isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value);
}

/** New origins require a quiet native construction, including its ignored evaluated arguments. */
function constructionQuiet(construction: NewExpression, read: CallExpression): boolean {
  const prefix = framedArgumentPrefix(construction, construction.arguments ?? [], Infinity);
  if (prefix.unknown || prefix.alternatives !== undefined || !quietValues(prefix.values.slice(1)))
    return false;
  const input = prefix.values[0];
  if (input === undefined) return true;
  const key = framedMapKey(input);
  if (key === 'null' || key === 'undefined') return true;
  const entries = framedAppliedArguments(read, input);
  if (entries === undefined) return false;
  const values = argumentsOf(read, entries);
  return values?.every((entry) => quietEntry(entry, read)) === true;
}

/** Native construction reads entry data slots; accessor-backed tuple substitutes stay opaque. */
function quietEntry(entry: Expression, read: CallExpression): boolean {
  const value = unwrapped(entry);
  if (!isArrayLiteralExpression(value)) return false;
  const values = argumentsOf(read, value.elements);
  if (values === undefined || !quietValues(values)) return false;
  const key = values[0];
  return key !== undefined && !isOmittedExpression(key);
}

/** Only an immediate member consumption adds an origin; saved get results retain their old opacity. */
function immediateRead(read: CallExpression): boolean {
  const { at, parent } = useOf(read);
  if (isPropertyAccessExpression(parent) && parent.expression === at) return true;
  return (
    isElementAccessExpression(parent) &&
    parent.expression === at &&
    framedMapKey(parent.argumentExpression) !== undefined
  );
}
