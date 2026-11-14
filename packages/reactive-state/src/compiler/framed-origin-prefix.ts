import {
  type Expression,
  isElementAccessExpression,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isStringLiteral,
  type NewExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { type FramedOwnerPrefixProof, framedQuietOwnerPrefix } from './framed-native-prefix.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** Finite native collection and fulfillment origins require quiet prior owner evaluation. */

const ERRORS = new Set([
  'DOMException',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);
const PRIMITIVES = new Set(['Infinity', 'NaN', 'Symbol.iterator', 'undefined']);
const FIELDS = new Set([
  'Array',
  'Array.prototype',
  'Array.prototype.entries',
  'Array.prototype.keys',
  'Array.prototype.splice',
  'Array.prototype.values',
  'Iterator',
  'Iterator.from',
  'Map',
  'Map.groupBy',
  'Map.prototype',
  'Map.prototype.entries',
  'Map.prototype.get',
  'Map.prototype.keys',
  'Map.prototype.set',
  'Map.prototype.values',
  'Object.keys',
  'Promise',
  'Promise.all',
  'Promise.allSettled',
  'Promise.race',
  'Promise.resolve',
  'Reflect.apply',
  'Reflect.ownKeys',
  'Set',
  'Set.prototype',
  'Set.prototype.add',
  'Set.prototype.entries',
  'Set.prototype.keys',
  'Set.prototype.values',
  'Symbol.iterator',
  'WeakMap',
  'WeakMap.prototype',
  'WeakMap.prototype.get',
  'WeakMap.prototype.set',
]);
const IDENTITIES = new Set(FIELDS);
for (const name of ERRORS) IDENTITIES.add(name);
const CALLERS = new Set(['apply', 'bind', 'call']);

/** Unknown completed calls and conversions retain the preexisting opaque projection boundary. */
export function framedOriginPrefix(
  consumer: Expression,
  prior?: Pick<FramedOwnerPrefixProof, 'call' | 'construct' | 'parameter'>,
): boolean {
  return framedQuietOwnerPrefix(consumer, {
    parameter: (value) => prior?.parameter?.(value) === true,
    primitive: primitiveValue,
    value: nativeField,
    call: (node) => prior?.call?.(node) === true,
    construct: (node) => quietErrorConstruction(node) || prior?.construct?.(node) === true,
  });
}

/** Literal primitive operands and stable native primitive identities invoke no supplied conversion. */
function primitiveValue(value: Expression): boolean {
  return framedMapKey(value) !== undefined || framedNativeConstructor(value, PRIMITIVES);
}

/** Reading a known native field is quiet without asserting that invoking it would be quiet. */
function nativeField(value: Expression): boolean {
  let member = unwrapped(value);
  const suffix: string[] = [];
  for (;;) {
    for (const identity of IDENTITIES) {
      if (
        framedNativeConstructor(member, new Set([identity])) &&
        knownField([identity, ...suffix].join('.'))
      )
        return true;
    }
    if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return false;
    if (isElementAccessExpression(member) && !primitiveValue(member.argumentExpression))
      return false;
    const name = frameMemberName(member);
    if (name === undefined) return false;
    suffix.unshift(name);
    member = unwrapped(member.expression);
  }
}

/** Native function caller fields retain the same identity through their finite member chain. */
function knownField(path: string): boolean {
  const parts = path.split('.');
  for (
    let last = parts.at(-1);
    last !== undefined && CALLERS.has(last) && !IDENTITIES.has(parts.join('.'));
    last = parts.at(-1)
  )
    parts.pop();
  return IDENTITIES.has(parts.join('.'));
}

/** A prior native Error with an absent or literal message performs no application conversion. */
function quietErrorConstruction(node: NewExpression): boolean {
  if (!framedNativeConstructor(node.expression, ERRORS)) return false;
  const args = node.arguments ?? [];
  if (args.length === 0) return true;
  if (args.length !== 1) return false;
  const first = args[0];
  if (first === undefined) return false;
  const message = unwrapped(first);
  return isStringLiteral(message) || isNoSubstitutionTemplateLiteral(message);
}
