import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isNewExpression,
  isElementAccessExpression,
  isFunctionDeclaration,
  isIdentifier,
  isOmittedExpression,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isSpreadElement,
  isSourceFile,
  isVariableDeclaration,
  isVariableStatement,
  isTypeReferenceNode,
  type Node,
  type ParameterDeclaration,
  type VariableDeclaration,
} from 'typescript/ast';

import { isAnswering, type Answering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { borrowedTextCall } from './framed-array-borrowing.ts';
import { enumeratedArrayViews } from './framed-array-enumerations.ts';
import {
  expandedReturnValues,
  flattenedArrayViews,
  flattenedReturnValues,
  flatMappedSourceIndex,
} from './framed-array-flatten.ts';
import { sourceArrayFunction } from './framed-array-functions.ts';
import type { ArrayElementView } from './framed-array-rest.ts';
import { arrayMethodMayBeOverridden } from './framed-arrays.ts';
import { framedAtMethod } from './framed-at-methods.ts';
import {
  frameBindingOf,
  frameDeclarationOf,
  frameMemberName,
  frameTypeOf,
} from './framed-bindings.ts';
import { concatSource } from './framed-concat-properties.ts';
import { framedUnreadCallback } from './framed-copied-inputs.ts';
import { flatReturnAlternatives } from './framed-flat-alternatives.ts';
import {
  flatMapOwnedSource,
  flatMapWrittenArray,
  quietFlatMapReturn,
} from './framed-flat-map-guards.ts';
import { framedGroupByOwnedInput } from './framed-groupby-inputs.ts';
import { framedAppliedArguments, framedArgumentPrefix } from './framed-keys.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { mapperDefaultViews } from './framed-mapper-defaults.ts';
import { mapperReturnedMemberViews } from './framed-mapper-member-returns.ts';
import { mapperReplacementViews } from './framed-mapper-replacements.ts';
import { mapperRestFlatViews, mapperRestReturnedViews } from './framed-mapper-rest.ts';
import { mapperSlotValues } from './framed-mapper-slots.ts';
import { mapperSpreadViews } from './framed-mapper-spreads.ts';
import { framedNativeConstructor, framedSourceValues } from './framed-sources.ts';
import { framedAssignedValues } from './framed-writes.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';
import { constantValue } from './numbers.ts';

/**
 * Written native enumerations and synchronous mappers retain their original selected element values.
 * A mapper that the file may give an array of its own is read as the language's here: a reader of the
 * answer asks `arrayProjectionMayBeOverridden` first.
 */
export function arrayProjectedViews(
  call: CallExpression,
  index: number | undefined,
  stable: (receiver: Expression) => boolean,
): readonly ArrayElementView[] | undefined {
  const values = enumeratedArrayViews(call, index);
  if (values !== undefined) return values;
  const selected = mappedCall(call);
  if (selected === undefined) return undefined;
  if (!selected.borrowed && sourceArrayFunction(call.expression)) return undefined;
  const memberViews: ArrayElementView[] = [];
  const mapping = { ...selected, memberViews };
  const at = stable(selected.receiver) ? index : undefined;
  if (selected.method === 'flatMap') {
    // A source of holes alone calls no callback: the result is empty wherever it is read.
    if (emptyMapPosition(selected.receiver, undefined)) return [];
    const views = flatMappedViews(mapping, at, call, stable);
    return framedUnreadCallback(call, selected) ?? mapperResultViews(views, mapping, call);
  }
  if (emptyMapPosition(selected.receiver, at)) return [];
  if (selected.callback === undefined || !unchangedMapper(selected.callback))
    return framedUnreadCallback(call, selected);
  const found: ArrayElementView[] = [];
  const known = framedAtMethod(selected.callback, (returned) => {
    found.push(...mappedReturns(returned, { ...mapping, index: at, capture: call, stable }));
    return false;
  });
  if (known === undefined) return undefined;
  return mapperResultViews(found, mapping, call);
}

interface Mapping {
  readonly method: string;
  readonly receiver: Expression;
  readonly callback: Expression | undefined;
  readonly borrowed: boolean;
  readonly expanded: boolean;
  readonly memberViews?: ArrayElementView[];
}

/** Independently proved own-data members keep their full-call proof after callback spread expansion. */
function mapperResultViews(
  views: readonly ArrayElementView[] | undefined,
  mapping: Mapping,
  call: CallExpression,
): readonly ArrayElementView[] | undefined {
  if (views === undefined || !mapping.expanded) return views;
  const known = mapperSpreadViews(views, mapping, call);
  const members = mapping.memberViews ?? [];
  return members.length === 0 ? known : [...(known ?? []), ...members];
}

/** A borrowed native map ignores the receiver's own map method and keeps its first callback argument. */
function mappedCall(call: CallExpression): Mapping | undefined {
  const borrowed = borrowedTextCall(call);
  const method = borrowed?.path.at(-1);
  if (
    borrowed?.path.slice(0, -1).join('.') === 'Array.prototype' &&
    (method === 'map' || method === 'flatMap')
  ) {
    const given =
      borrowed.applied === undefined
        ? borrowed.given
        : framedAppliedArguments(call, borrowed.applied);
    const selected = given === undefined ? undefined : framedArgumentPrefix(call, given, 1);
    return {
      receiver: borrowed.receiver,
      callback: selected?.unknown === false ? selected.values[0] : undefined,
      expanded: given?.[0] !== undefined && isSpreadElement(given[0]),
      borrowed: true,
      method,
    };
  }
  const member = unwrapped(call.expression);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return undefined;
  const name = frameMemberName(member);
  if (name !== 'map' && name !== 'flatMap') return undefined;
  const selected = framedArgumentPrefix(call, call.arguments, 1, false);
  const first = call.arguments[0];
  return {
    receiver: member.expression,
    callback: selected.unknown ? undefined : selected.values[0],
    expanded: first !== undefined && isSpreadElement(first),
    borrowed: false,
    method: name,
  };
}

/**
 * Whether the call is a native mapper named at an array the file may give a method of that name of
 * its own: what it answers is then no mapping of the array's elements, and a reader of the answer
 * refuses. A borrowed call runs the native method whatever the array holds.
 */
export function arrayProjectionMayBeOverridden(call: CallExpression): boolean {
  const selected = mappedCall(call);
  return (
    selected !== undefined &&
    !selected.borrowed &&
    arrayMethodMayBeOverridden(call, selected.method)
  );
}

/** Source-written holes and excluded fixed positions never invoke a native mapper. */
function emptyMapPosition(receiver: Expression, index: number | undefined): boolean {
  const value = unwrapped(receiver);
  if (isNewExpression(value) && globalPathOf(value.expression)?.join('.') === 'Array') {
    const given = value.arguments ?? [];
    if (given.length === 0) return true;
    const first = given[0];
    const size = first !== undefined && given.length === 1 ? constantValue(first) : undefined;
    if (typeof size === 'number' && Number.isSafeInteger(size) && size >= 0) return true;
  }
  if (!isArrayLiteralExpression(value) || value.elements.some((each) => isSpreadElement(each)))
    return false;
  if (index === undefined) return value.elements.every((each) => isOmittedExpression(each));
  const at = index < 0 ? value.elements.length + index : index;
  const element = value.elements[at];
  return element === undefined || isOmittedExpression(element);
}

/**
 * The callback's first parameter retains the source slot, the defaults it may apply and the values
 * its body writes into it; other returns keep their lexical nodes.
 */
function mappedReturns(
  returned: Expression,
  mapping: Mapping & {
    readonly index: number | undefined;
    readonly capture: CallExpression;
    readonly stable: (value: Expression) => boolean;
  },
  owner: Answering | undefined = answeringOwner(returned.parent),
): readonly ArrayElementView[] {
  const pending = [returned];
  const seen = new Set<Node>();
  const found: ArrayElementView[] = [];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const value = unwrapped(next);
    if (seen.has(value)) continue;
    seen.add(value);
    const sources = framedSourceValues(value);
    if (sources !== undefined) {
      pending.push(...sources);
      continue;
    }
    const packed = mapperRestReturnedViews(value, mapping, owner);
    if (packed !== undefined) {
      found.push(...packed);
      continue;
    }
    const memberViews = mapperReturnedMemberViews(value, mapping, owner);
    mapping.memberViews?.push(...memberViews);
    found.push(...memberViews);
    const inputValue = mapperRestAlias(value);
    const binding = isIdentifier(inputValue) ? frameBindingOf(inputValue) : undefined;
    const declared = binding?.binding;
    const input =
      declared !== undefined &&
      isParameterDeclaration(declared) &&
      retainsMapperInput(inputValue, declared) &&
      owner?.parameters[0] === declared;
    if (input && isIdentifier(inputValue))
      found.push(
        ...mapperDefaultViews(inputValue, declared, mapping),
        ...mapperReplacementViews(inputValue, declared, mapping),
      );
    found.push(
      input
        ? {
            value: mapping.receiver,
            index: mapping.index,
            capture: mapping.capture,
            keys: binding?.keys,
          }
        : { value: next, index: undefined, element: true },
    );
  }
  return found;
}

/** A whole constant alias to a rest binding keeps the mapper's prior conservative fallback. */
function mapperRestAlias(value: Expression): Expression {
  const source = framedGroupByOwnedInput(value, value);
  const declared = isIdentifier(source) ? frameBindingOf(source)?.binding : undefined;
  return declared !== undefined &&
    isParameterDeclaration(declared) &&
    declared.dotDotDotToken !== undefined
    ? source
    : value;
}

/** Only an unassigned rest binding keeps the old conservative first-input fallback. */
function retainsMapperInput(value: Expression, parameter: ParameterDeclaration): boolean {
  return (
    parameter.dotDotDotToken === undefined ||
    (isIdentifier(value) && framedAssignedValues(value).length === 0)
  );
}

/** Callable syntax boundaries preserve outer captures instead of treating them as mapper parameters. */
function answeringOwner(value: Node): Answering | undefined {
  for (let at = value; !isSourceFile(at); at = at.parent) if (isAnswering(at)) return at;
  return undefined;
}

/** A mapper's named binding keeps its written callable only before possible reassignment. */
function unchangedMapper(callback: Expression): boolean {
  const pending = [callback];
  const seen = new Set<Node>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const value = unwrapped(next);
    if (seen.has(value)) continue;
    seen.add(value);
    const sources = mapperSources(value);
    if (sources === undefined) return false;
    pending.push(...sources);
  }
  return true;
}

/** Possible callback implementations retain original alias reads and reject rewritten named bodies. */
function mapperSources(value: Expression): readonly Expression[] | undefined {
  const sources = framedSourceValues(value);
  if (sources !== undefined) return sources;
  if (!isIdentifier(value)) return sourceArrayFunction(value) ? [] : undefined;
  if (framedAssignedValues(value).length > 0) return undefined;
  const declaration = frameDeclarationOf(value);
  if (declaration !== undefined && isFunctionDeclaration(declaration)) return [];
  const initializer =
    declaration !== undefined && isVariableDeclaration(declaration)
      ? mapperInitializer(declaration)
      : undefined;
  return initializer === undefined ? undefined : [initializer];
}

/** Whole immutable callback aliases preserve the value captured at their initializer. */
function mapperInitializer(declaration: VariableDeclaration): Expression | undefined {
  if (!isIdentifier(declaration.name)) return undefined;
  const statement = declaration.parent.parent;
  return isVariableStatement(statement) &&
    /^const\s/u.test(statement.declarationList.getText(statement.getSourceFile()))
    ? declaration.initializer
    : undefined;
}

/** Flat mappers retain written return-array positions without adding contextual parameter inference. */
function flatMappedViews(
  mapping: Mapping,
  index: number | undefined,
  call: CallExpression,
  stable: (value: Expression) => boolean,
): readonly ArrayElementView[] | undefined {
  if (mapping.callback === undefined || !unchangedMapper(mapping.callback)) return undefined;
  const returned: Expression[] = [];
  const known = framedAtMethod(mapping.callback, (value) => {
    returned.push(value);
    return false;
  });
  if (known === undefined) return undefined;
  const alternatives = returned.flatMap((each) => flatReturnAlternatives(each));
  const sole = alternatives[0];
  const soleOwner = sole === undefined ? undefined : answeringOwner(sole.from.parent);
  if (sole !== undefined && alternatives.length === 1) {
    const packed = mapperRestFlatViews(
      sole.value,
      { ...mapping, index, stable, capture: call },
      soleOwner,
    );
    if (packed !== undefined) return packed;
  }
  if (sole !== undefined && alternatives.length === 1 && directMappedInput(sole.value, soleOwner))
    return identityMappedViews(sole.value, { ...mapping, index, stable, capture: call });
  return alternatives.flatMap(({ value, from }) => {
    return flatReturnViews(value, {
      ...mapping,
      index,
      capture: call,
      unique: alternatives.length === 1,
      fixedReceiver: stable(mapping.receiver),
      owner: answeringOwner(from.parent),
      stable,
    });
  });
}

/** Definite scalar positions or one input retain initialized origins beside the old identity view. */
function identityMappedViews(
  returned: Expression,
  mapping: Mapping & {
    readonly index: number | undefined;
    readonly capture: CallExpression;
    readonly stable: (value: Expression) => boolean;
  },
): readonly ArrayElementView[] {
  const { receiver, index, stable, capture } = mapping;
  const original = flattenedArrayViews(receiver, index, 1, { stable, capture });
  const name = unwrapped(returned);
  if (!isIdentifier(name)) return original;
  const declaration = frameBindingOf(name)?.binding;
  const source = concatSource(receiver, stable, false);
  if (
    declaration === undefined ||
    source === undefined ||
    !isParameterDeclaration(declaration) ||
    !isArrayLiteralExpression(source) ||
    emptyMapPosition(source, undefined)
  )
    return original;
  const origins = (at: number | undefined) => {
    const read = { ...mapping, index: at };
    return [
      ...mapperDefaultViews(name, declaration, read),
      ...mapperReplacementViews(name, declaration, read),
    ];
  };
  const all = origins(undefined);
  const scalars =
    source.elements.every((each) => isOmittedExpression(each) || identityScalar(each)) &&
    all.every((each) => (each.keys?.length ?? 0) === 0 && identityScalar(each.value));
  if (!scalars && !singleMapInput(source)) return original;
  const at = flatMappedSourceIndex(source, index);
  if (at === Infinity && scalars) return original;
  const added = scalars ? origins(at) : all;
  return [...original, ...added.flatMap((each) => identityOriginViews(each, scalars ? 0 : index))];
}

/** Literal data and native Error identities occupy one flatMap slot rather than an array layer. */
function identityScalar(source: Expression): boolean {
  return mapperSlotValues(source).every((value) => {
    if (value === 'absent') return true;
    if (typeof value === 'string') return false;
    const actual = unwrapped(value);
    if (isObjectLiteralExpression(actual) || framedMapKey(actual) !== undefined) return true;
    if (isNewExpression(actual) && framedNativeConstructor(actual.expression, STANDARD_ERRORS))
      return true;
    const selected = frameTypeOf(actual);
    return (
      selected?.keys.length === 0 &&
      isTypeReferenceNode(selected.type) &&
      isIdentifier(selected.type.typeName) &&
      framedNativeConstructor(selected.type.typeName, STANDARD_ERRORS)
    );
  });
}

/** An added array result loses one native layer; a scalar occupies only the first output position. */
function identityOriginViews(
  view: ArrayElementView,
  index: number | undefined,
): readonly ArrayElementView[] {
  const value = unwrapped(view.value);
  const array =
    isArrayLiteralExpression(value) ||
    flattenedReturnValues(value) !== undefined ||
    flatMapWrittenArray(value);
  if (array) return [{ ...view, index, element: false }];
  return index === undefined || index === 0 ? [view] : [];
}

/** A fixed callback result length maps a flattened output position back to its original input. */
function flatReturnViews(
  value: Expression,
  context: Mapping & {
    readonly index: number | undefined;
    readonly capture: CallExpression;
    readonly unique: boolean;
    readonly fixedReceiver: boolean;
    readonly owner: Answering | undefined;
    readonly stable: (value: Expression) => boolean;
  },
): readonly ArrayElementView[] {
  const plain = flattenedReturnValues(value);
  if (plain === undefined && quietFlatMapReturn(value, context.capture, context.receiver)) {
    const added = expandedFlatReturn(value, context);
    if (added !== undefined) return added;
  }
  const elements = plain ?? [value];
  if (elements.length === 0) return [];
  const { index } = context;
  const fixed = index !== undefined && context.unique && index >= 0;
  const inputIndex = fixed ? Math.floor(index / elements.length) : undefined;
  const sourceIndex = context.fixedReceiver
    ? flatMappedSourceIndex(context.receiver, inputIndex)
    : undefined;
  if (sourceIndex === Infinity || emptyMapPosition(context.receiver, sourceIndex)) return [];
  const chosen = fixed
    ? elements.slice(index % elements.length, (index % elements.length) + 1)
    : elements;
  // An element written outside the mapper, of an alias it returns, is never the mapper's input.
  return chosen.flatMap((element) =>
    mappedReturns(element, { ...context, index: sourceIndex }, context.owner),
  );
}

/** Only the added finite expansion or single-input written array return changes the prior fallback. */
function expandedFlatReturn(
  value: Expression,
  context: Mapping & {
    readonly index: number | undefined;
    readonly capture: CallExpression;
    readonly unique: boolean;
    readonly fixedReceiver: boolean;
    readonly owner: Answering | undefined;
    readonly stable: (value: Expression) => boolean;
  },
): readonly ArrayElementView[] | undefined {
  const expanded = expandedReturnValues(
    value,
    (source) => source === value || stableReturn(source),
  );
  if (expanded === undefined) {
    const source = flatMapOwnedSource(value, value, context.capture);
    if (source === undefined || !flatMapWrittenArray(source) || !singleMapInput(context.receiver))
      return undefined;
    return [{ value: source, index: undefined, capture: context.capture }];
  }
  if (expanded.length === 0) return [];
  const { index } = context;
  const fixed = index !== undefined && context.unique && index >= 0;
  const inputIndex = fixed ? Math.floor(index / expanded.length) : undefined;
  const sourceIndex = context.fixedReceiver
    ? flatMappedSourceIndex(context.receiver, inputIndex)
    : undefined;
  if (sourceIndex === Infinity) return [];
  const selected = fixed
    ? expanded.slice(index % expanded.length, (index % expanded.length) + 1)
    : expanded;
  const found = selected.flatMap((element) =>
    mappedReturns(element, { ...context, index: sourceIndex }, context.owner),
  );
  return found.every((each) => flatMapOwnedSource(each.value, value, context.capture) !== undefined)
    ? found
    : undefined;
}

/** Literal whole const return arrays retain only their written creation source. */
function stableReturn(source: Expression): boolean {
  let value = unwrapped(source);
  const seen = new Set<Node>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    const binding = selected?.binding;
    if (
      binding === undefined ||
      selected?.keys.length !== 0 ||
      seen.has(binding) ||
      !isVariableDeclaration(binding) ||
      binding.initializer === undefined ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile()))
    )
      return false;
    seen.add(binding);
    value = unwrapped(binding.initializer);
  }
  return true;
}

/** One definite present source slot avoids inventing output offsets for unknown return-array lengths. */
function singleMapInput(receiver: Expression): boolean {
  const value = unwrapped(receiver);
  return (
    isArrayLiteralExpression(value) &&
    !value.elements.some((each) => isSpreadElement(each)) &&
    value.elements.filter((each) => !isOmittedExpression(each)).length === 1
  );
}

/**
 * A direct first-parameter return is native identity flattening rather than array text conversion.
 * The parameter is the callback's own: a value a return reaches through a constant stands where that
 * constant does, so its owner is the callback the return belongs to, not the function it is written in.
 */
function directMappedInput(returned: Expression, owner: Answering | undefined): boolean {
  const value = unwrapped(returned);
  if (!isIdentifier(value)) return false;
  const binding = frameBindingOf(value);
  return (
    binding?.keys.length === 0 &&
    isParameterDeclaration(binding.binding) &&
    binding.binding === owner?.parameters[0]
  );
}
