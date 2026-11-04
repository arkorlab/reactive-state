import {
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isElementAccessExpression,
  isIdentifier,
  isOmittedExpression,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isSpreadElement,
  type ParameterDeclaration,
} from 'typescript/ast';

import type { Answering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { flatMappedSourceIndex, flattenedArrayViews } from './framed-array-flatten.ts';
import type { ArrayElementView } from './framed-array-rest.ts';
import { frameBindingOf, frameMemberName } from './framed-bindings.ts';
import { concatSource } from './framed-concat-properties.ts';
import { framedGroupByOwnedInput } from './framed-groupby-inputs.ts';
import { iteratorCarriedUnexposed } from './framed-iterator-carried.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { packedParameterDefaults, type MapperDefaultRead } from './framed-mapper-defaults.ts';
import { quietMapperCall } from './framed-mapper-quiet.ts';
import { mapperSlotValues, type MapperSlot } from './framed-mapper-slots.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedOriginPrefix } from './framed-origin-prefix.ts';
import { framedAssignedValues } from './framed-writes.ts';

/** Native map and flatMap give each rest binding a fresh array of their remaining three arguments. */
const MAPPER_ARGUMENTS = { count: 3, receiver: 2 } as const;
const INDEX = /^(?:0|[1-9]\d*)$/u;

interface RestBinding {
  readonly name: Identifier;
  readonly parameter: ParameterDeclaration;
  readonly offset: number;
  readonly keys: readonly string[];
}

/** A returned rest binding keeps its packed array layer before any following member is selected. */
export function mapperRestReturnedViews(
  value: Expression,
  read: MapperDefaultRead & { readonly method: string },
  owner: Answering | undefined,
): readonly ArrayElementView[] | undefined {
  const selected = restBinding(value, owner, read);
  if (selected === undefined) return undefined;
  if (read.method === 'flatMap' && selected.keys.length === 0)
    return Array.from(
      { length: Math.max(0, MAPPER_ARGUMENTS.count - selected.offset) },
      (_, at) => {
        return {
          value,
          index: undefined,
          element: true,
          capture: read.capture,
          keys: [String(at)],
          packedRest: { receiver: read.receiver, index: undefined, offset: selected.offset },
        };
      },
    );
  return [
    {
      value,
      index: undefined,
      element: true,
      capture: read.capture,
      keys: selected.keys,
      packedRest: { receiver: read.receiver, index: read.index, offset: selected.offset },
    },
    ...restDefaults(selected, read),
  ];
}

/** A native flatMap removes the whole rest array's single known layer, not an input's layer. */
export function mapperRestFlatViews(
  value: Expression,
  read: MapperDefaultRead,
  owner: Answering | undefined,
): readonly ArrayElementView[] | undefined {
  const selected = restBinding(value, owner, read);
  if (selected === undefined) return undefined;
  if (selected.keys.length > 0) return flatArgumentViews(selected, read);
  const length = MAPPER_ARGUMENTS.count - selected.offset;
  if (length <= 0) return [];
  const fixed = read.index !== undefined && read.index >= 0;
  const sourceIndex = fixed ? Math.floor(read.index / length) : undefined;
  const index = read.stable(read.receiver)
    ? flatMappedSourceIndex(read.receiver, sourceIndex)
    : undefined;
  if (index === Infinity) return [];
  const positions = fixed ? [read.index % length] : Array.from({ length }, (_, at) => at);
  return positions.map((at) => {
    return {
      value,
      index: undefined,
      element: true,
      keys: [String(at)],
      capture: read.capture,
      packedRest: { receiver: read.receiver, index, offset: selected.offset },
    };
  });
}

/** A directly selected argument retains its own source-proved native flattening layer. */
function flatArgumentViews(
  selected: RestBinding,
  read: MapperDefaultRead,
): readonly ArrayElementView[] | undefined {
  const key = selected.keys[0];
  if (key === undefined || selected.keys.length !== 1 || !INDEX.test(key)) return undefined;
  const argument = selected.offset + Number(key);
  if (argument === 0 && restDefaults(selected, read).length === 0)
    return flattenedArrayViews(read.receiver, read.index, 1, {
      stable: read.stable,
      capture: read.capture,
    });
  const source = concatSource(read.receiver, read.stable);
  if (
    source !== undefined &&
    argument === MAPPER_ARGUMENTS.receiver &&
    isArrayLiteralExpression(source) &&
    !source.elements.some((each) => isSpreadElement(each)) &&
    source.elements.filter((each) => !isOmittedExpression(each)).length === 1
  )
    return flattenedArrayViews(source, read.index, 0, {
      stable: read.stable,
      capture: read.capture,
    });
  return undefined;
}

/** A selected packed argument keeps the input, numeric index, or original receiver's actual layer. */
export function mapperRestReadingViews(
  reading: ArrayElementView,
): readonly ArrayElementView[] | undefined {
  const packed = reading.packedRest;
  if (packed === undefined || reading.capture === undefined) return undefined;
  const [key, ...keys] = reading.keys ?? [];
  if (key === undefined || !INDEX.test(key)) return [];
  const argument = packed.offset + Number(key);
  const { receiver } = packed;
  if (argument === 0)
    return [{ value: receiver, index: packed.index, keys, capture: reading.capture }];
  return argument === MAPPER_ARGUMENTS.receiver
    ? [{ value: receiver, index: undefined, element: true, keys, capture: reading.capture }]
    : [];
}

/** A quiet original rest read retains its packed binding and literal keys through whole aliases. */
function restBinding(
  value: Expression,
  owner: Answering | undefined,
  read: MapperDefaultRead,
): RestBinding | undefined {
  if (owner === undefined) return undefined;
  const keys: string[] = [];
  let input = unwrapped(framedGroupByOwnedInput(value, value));
  while (isPropertyAccessExpression(input) || isElementAccessExpression(input)) {
    const key = frameMemberName(input);
    if (
      key === undefined ||
      (isElementAccessExpression(input) && framedMapKey(input.argumentExpression) === undefined)
    )
      return undefined;
    keys.unshift(key);
    input = unwrapped(framedGroupByOwnedInput(input.expression, value));
  }
  if (!isIdentifier(input) || framedAssignedValues(input).length > 0) return undefined;
  const binding = frameBindingOf(input);
  if (binding === undefined || !isParameterDeclaration(binding.binding)) return undefined;
  const parameter = binding.binding;
  if (parameter.dotDotDotToken === undefined) return undefined;
  if (
    !framedOriginPrefix(value) &&
    !quietMapperCall(parameter, read.capture, read.receiver, { packedRest: parameter })
  )
    return undefined;
  const parameters = owner.parameters;
  const first = parameters[0];
  const skipped =
    first !== undefined && isIdentifier(first.name) && first.name.text === 'this' ? 1 : 0;
  const offset = parameters.indexOf(parameter) - skipped;
  return offset < 0
    ? undefined
    : { name: input, parameter, offset, keys: [...binding.keys, ...keys] };
}

/** Defaults apply to the argument inside a rest pattern only after quiet original evaluation. */
function restDefaults(selected: RestBinding, read: MapperDefaultRead): readonly ArrayElementView[] {
  const source = concatSource(read.receiver, read.stable);
  if (
    source === undefined ||
    !isArrayLiteralExpression(source) ||
    !quietMapperCall(selected.parameter, read.capture, source, { packedRest: selected.parameter })
  )
    return [];
  const defaults = packedParameterDefaults(selected.name, selected.parameter, (key) => {
    if (!INDEX.test(key)) return ['unknown'];
    const argument = selected.offset + Number(key);
    if (argument === 0) return selectedInputSlots(source.elements, read.index);
    if (argument === 1) return ['defined'];
    return [argument === MAPPER_ARGUMENTS.receiver ? source : 'absent'];
  });
  const values = defaults.map(({ value }) => ({ value }));
  if (
    defaults.some(({ value }) => !framedOriginCoowned(value, read.capture)) ||
    !iteratorCarriedUnexposed([source, ...read.capture.arguments], values, read.capture)
  )
    return [];
  return defaults.map(({ value, keys }) => {
    return {
      value,
      keys,
      index: undefined,
      element: true,
      capture: read.capture,
    };
  });
}

/** A native mapper sees a selected present slot, with written holes invoking no callback. */
function selectedInputSlots(
  elements: readonly Expression[],
  index: number | undefined,
): MapperSlot[] {
  const chosen = index === undefined ? elements : elements.slice(index, index + 1);
  return chosen.flatMap((each) => (isOmittedExpression(each) ? [] : mapperSlotValues(each)));
}
