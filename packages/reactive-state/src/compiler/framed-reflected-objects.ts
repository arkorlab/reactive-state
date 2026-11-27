import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isSpreadAssignment,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { frameBindingOf, frameMemberName } from './framed-bindings.ts';
import { framedAppliedArguments, framedArgumentPrefix } from './framed-keys.ts';
import { framedNativeArguments } from './framed-native-arguments.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** Native `Object` reached through Reflect or a borrowed call answers the object it is given. */

const OBJECT: ReadonlySet<string> = new Set(['Object']);

/** The slots of `Reflect.construct`: its target, its list, and the constructor it may make as. */
const CONSTRUCT = { slots: 3, made: 2 } as const;

/** The slots of `Reflect.apply` invoking `Reflect.construct`: the function, its receiver, its list. */
const APPLIED = { slots: 3, list: 2 } as const;

/** What a construction through `Reflect.construct` is given: its target, its list, its constructor. */
interface Construction {
  readonly call: CallExpression;
  readonly target: Expression | undefined;
  readonly list: Expression | undefined;
  readonly made: Expression | undefined;
}

/**
 * What native `Object` answers where `Reflect.construct`, `Reflect.apply`, or its own `call` or
 * `apply` invokes it, as a direct `Object(value)` does: the object it is given first —
 * `Reflect.construct(Object, [error])` is `error`, through a whole constant or destructured alias of
 * `Reflect.construct`, its `call` and `apply`, and `Reflect.apply(Reflect.construct, …)`, and of
 * `Object` reached as a fresh literal's `constructor`. A list the compile cannot read, and a
 * `newTarget` other than `Object`, which makes a fresh object instead, keep the existing boundary.
 */
export function framedReflectedObjectValues(node: Expression): readonly Expression[] | undefined {
  const value = unwrapped(node);
  if (!isCallExpression(value)) return undefined;
  const construction = reflectedConstruction(value);
  if (construction !== undefined) return constructedObject(construction);
  const selected = framedNativeArguments(value, OBJECT);
  if (selected === undefined || selected.target === value.expression || selected.constructed)
    return undefined;
  return firstObject(selected.args);
}

/** The object a construction of native `Object` as itself answers: the first one it is given. */
function constructedObject(construction: Construction): readonly Expression[] | undefined {
  const { call, target, list, made } = construction;
  if (target === undefined || list === undefined || !nativeObject(target)) return undefined;
  if (made !== undefined && !framedNativeConstructor(made, OBJECT)) return undefined;
  return firstObject(framedAppliedArguments(call, list, false));
}

/** The first argument, where none is unknown or spread before it. */
function firstObject(args: readonly Expression[] | undefined): readonly Expression[] | undefined {
  const first = args?.[0];
  return first === undefined || isSpreadElement(first) ? undefined : [first];
}

/** `Reflect.construct(…)` called, borrowed by `call` or `apply`, or invoked by `Reflect.apply`. */
function reflectedConstruction(call: CallExpression): Construction | undefined {
  const callee = unwrapped(call.expression);
  if (constructFunction(callee)) return directSlots(call, call.arguments);
  if (globalPathOf(callee)?.join('.') === 'Reflect.apply') {
    const values = knownArguments(call, call.arguments, APPLIED.slots);
    const fn = values?.[0];
    return fn !== undefined && constructFunction(fn)
      ? appliedSlots(call, values?.[APPLIED.list])
      : undefined;
  }
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) return undefined;
  if (!constructFunction(callee.expression)) return undefined;
  const method = frameMemberName(callee);
  if (method === 'call') return directSlots(call, call.arguments.slice(1));
  return method === 'apply'
    ? appliedSlots(call, knownArguments(call, call.arguments, 2)?.[1])
    : undefined;
}

/** The construction slots of arguments given directly. */
function directSlots(call: CallExpression, args: readonly Expression[]): Construction | undefined {
  const values = knownArguments(call, args, CONSTRUCT.slots);
  return values === undefined
    ? undefined
    : { call, target: values[0], list: values[1], made: values[CONSTRUCT.made] };
}

/** The construction slots an applied list holds. */
function appliedSlots(
  call: CallExpression,
  list: Expression | undefined,
): Construction | undefined {
  const values = list === undefined ? undefined : framedAppliedArguments(call, list);
  if (values?.some((each) => isSpreadElement(each)) !== false) return undefined;
  return { call, target: values[0], list: values[1], made: values[CONSTRUCT.made] };
}

/** A known argument prefix; none where an argument the compile cannot place comes first. */
function knownArguments(
  call: CallExpression,
  args: readonly Expression[],
  slots: number,
): readonly Expression[] | undefined {
  const prefix = framedArgumentPrefix(call, args, slots);
  return prefix.unknown || prefix.alternatives !== undefined ? undefined : prefix.values;
}

/** Native `Reflect.construct`, through whole constant aliases and a destructured `construct`. */
function constructFunction(node: Expression): boolean {
  let value = unwrapped(node);
  const seen = new Set<Node>();
  while (!seen.has(value)) {
    seen.add(value);
    if (globalPathOf(value)?.join('.') === 'Reflect.construct') return true;
    if (!isIdentifier(value)) return false;
    const selected = frameBindingOf(value);
    const binding = selected?.binding;
    if (
      selected === undefined ||
      binding === undefined ||
      !isVariableDeclaration(binding) ||
      binding.initializer === undefined ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile()))
    )
      return false;
    if (selected.keys.length > 0) {
      const path = globalPathOf(unwrapped(binding.initializer)) ?? [];
      return [...path, ...selected.keys].join('.') === 'Reflect.construct';
    }
    value = unwrapped(binding.initializer);
  }
  return false;
}

/** Native `Object`: its name, `Object.prototype.constructor`, or a fresh literal's `constructor`. */
function nativeObject(node: Expression): boolean {
  if (framedNativeConstructor(node, OBJECT)) return true;
  const value = unwrapped(node);
  if (globalPathOf(value)?.join('.') === 'Object.prototype.constructor') return true;
  if (
    (!isPropertyAccessExpression(value) && !isElementAccessExpression(value)) ||
    frameMemberName(value) !== 'constructor'
  )
    return false;
  const object = unwrapped(value.expression);
  return (
    isObjectLiteralExpression(object) &&
    object.properties.every((property) => {
      if (isSpreadAssignment(property) || isComputedPropertyName(property.name)) return false;
      const name = writtenArrayKey(property.name);
      return name !== 'constructor' && name !== '__proto__';
    })
  );
}
