import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isElementAccessExpression,
  isNewExpression,
  isPropertyAccessExpression,
} from 'typescript/ast';

import { useOf } from './code-globals.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { framedNativeErrorInput } from './framed-native-error-inputs.ts';
import {
  framedQuietData,
  framedQuietInputs,
  framedQuietSource,
} from './framed-native-evaluation.ts';
import { prototypeApisUnexposed } from './framed-prototype-apis.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';

/** Direct native prototype observations retain only the actual unexposed Object.create prototype. */

const GETTERS = new Set(['Object.getPrototypeOf', 'Reflect.getPrototypeOf']);
const CREATORS = new Set(['Object.create']);

/** Saved result aliases retain the old boundary instead of overlooking subsequent field writes. */
export function framedGetPrototypeValues(node: Expression): readonly Expression[] | undefined {
  if (!isCallExpression(node) || !immediateMember(node)) return undefined;
  const target = framedQuietSource(node.expression, false);
  if (target === undefined || !framedNativeConstructor(target, GETTERS)) return undefined;
  const args = writtenArguments(node);
  const source = args?.[0];
  if (source === undefined || args === undefined) return undefined;
  const created = framedQuietSource(source, false);
  if (created === undefined || !isCallExpression(created)) return undefined;
  const creator = framedQuietSource(created.expression, false);
  if (creator === undefined || !framedNativeConstructor(creator, CREATORS)) return undefined;
  const inputs = writtenArguments(created);
  const prototype = inputs?.[0];
  if (prototype === undefined || inputs === undefined) return undefined;
  const descriptors = inputs[1];
  if (descriptors !== undefined && !framedQuietData(descriptors)) return undefined;
  if (!framedQuietInputs([...args.slice(1), ...inputs.slice(1)], STANDARD_ERRORS)) return undefined;
  if (!quietPrototype(prototype, node) || !prototypeApisUnexposed(node, [target, creator]))
    return undefined;
  return [prototype];
}

/** A source-written member consumes the prototype before any saved-result mutation can run. */
function immediateMember(call: CallExpression): boolean {
  const { at, parent } = useOf(call);
  if (isPropertyAccessExpression(parent) && parent.expression === at) return true;
  return (
    isElementAccessExpression(parent) &&
    parent.expression === at &&
    framedMapKey(parent.argumentExpression) !== undefined
  );
}

/** Whole literal argument spreads retain all evaluated slots, including ignored trailing inputs. */
function writtenArguments(call: CallExpression): readonly Expression[] | undefined {
  const prefix = framedArgumentPrefix(call, call.arguments, Infinity);
  return prefix.unknown || prefix.alternatives !== undefined ? undefined : prefix.values;
}

/** Supplied prototype bindings stay unexposed; fresh native Error creation needs quiet data inputs. */
function quietPrototype(value: Expression, consumer: CallExpression): boolean {
  const source = framedQuietSource(value, false);
  if (source === undefined) return false;
  return (
    framedNativeErrorInput(value, consumer, undefined, false) ||
    framedQuietData(value) ||
    (isNewExpression(source) &&
      framedNativeConstructor(source.expression, STANDARD_ERRORS) &&
      (source.arguments ?? []).every((argument) => framedQuietData(argument)))
  );
}
