import {
  type ArrayBindingPattern,
  type BindingElement,
  type BindingName,
  type Expression,
  type Identifier,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isIdentifier,
  isOmittedExpression,
  type ObjectBindingPattern,
} from 'typescript/ast';

import { parameterValue } from './parameter-values.ts';
import { mutatedRestOrigins } from './proxy-array-writes.ts';
import { arrayChangedBefore, arrayIndex, restArrayChangedBefore } from './proxy-arrays.ts';
import {
  bindingPropertyKey,
  bindsHoistedName,
  destructuredBindingOrigins,
} from './proxy-parameter-patterns.ts';
import { assignedParameterOrigins, definitelyReassignedBefore } from './proxy-parameter-writes.ts';
import {
  argumentPresence,
  frameContextOf,
  parameterFrame,
  type ParameterFrame,
  parameterReassigned,
} from './proxy-presence.ts';
import { type PresenceStatus, projectedOriginPresence, restOrigins } from './proxy-rest-slices.ts';
import { type Frame, type Origin, sourceValue, writtenBefore } from './proxy-values.ts';
import { interveningEvaluation } from './written-evaluation.ts';

export { type ParameterFrame, parameterFrame } from './proxy-presence.ts';

interface RestPatternRead {
  readonly at: Origin;
  readonly defaultAt: Origin;
  readonly openTail: boolean;
  readonly targetText: string;
}

/** Checks definedness of a projected destructuring `source` using `argumentPresence` at leaves. */
function checkProjectedPresence(source: Origin): PresenceStatus {
  return projectedOriginPresence(source, argumentPresence);
}

/** Resolves a parameter read through replacements, reassignments, arguments, and defaults. */
export function parameterOrigins(
  name: Identifier,
  binding: ParameterFrame,
  at: Origin,
): readonly Origin[] {
  const { declared, frame, parameter } = binding;
  const replaced = parameterReassigned(frame.fn, declared)
    ? parameterValue(frame.fn, declared, name)
    : undefined;
  if (replaced !== undefined) {
    return [{ ...at, value: replaced.value }];
  }
  const defaultAt: Origin = { ...at, context: frameContextOf(at.context, frame) };
  const assigned = assignedParameterOrigins(frame.fn, declared, {
    bodyAt: at,
    defaultAt,
    isBypassed: (index) => isArgumentDefinedAt(frame, index),
  });
  if (isIdentifier(parameter.name) && parameter.dotDotDotToken !== undefined) {
    return [...assigned, ...restParameterOrigins(name, binding, declared, at)];
  }
  if (definitelyReassignedBefore(frame.fn, declared, name, at.context)) {
    return assigned;
  }
  const incoming = isIdentifier(parameter.name)
    ? incomingParameterOrigins(binding, at, defaultAt)
    : destructuredParameterOrigins(binding, at, defaultAt);
  return [...assigned, ...incoming];
}

/** Checks whether caller argument `index` in `frame` is guaranteed defined. */
function isArgumentDefinedAt(frame: Frame, index: number): boolean {
  const given =
    frame.given !== undefined && index < frame.given.length ? frame.given[index] : undefined;
  return given !== undefined && argumentPresence(given) === 'defined';
}

/** Incoming argument and `undefined`-fallback origins before any body assignment runs. */
function incomingParameterOrigins(
  binding: ParameterFrame,
  at: Origin,
  defaultAt: Origin,
): readonly Origin[] {
  const { frame, index, parameter } = binding;
  const fallback: readonly Origin[] =
    parameter.initializer === undefined ? [] : [{ ...defaultAt, value: parameter.initializer }];
  const given =
    frame.given !== undefined && index < frame.given.length ? frame.given[index] : undefined;
  if (given === undefined) {
    return fallback;
  }
  const forwarded: Origin = {
    ...given,
    excluded: at.excluded,
    keys: [...given.keys, ...at.keys],
    spread: at.spread,
  };
  const presence = argumentPresence(given);
  if (presence === 'undefined') {
    return fallback;
  }
  return presence === 'defined' ? [forwarded] : [forwarded, ...fallback];
}

/** Projects destructured formal parameter bindings across arguments, rest slices, and defaults. */
function destructuredParameterOrigins(
  binding: ParameterFrame,
  at: Origin,
  defaultAt: Origin,
): readonly Origin[] {
  const { declared, parameter } = binding;
  if (parameter.dotDotDotToken !== undefined) {
    return destructuredRestOrigins(binding, at, defaultAt);
  }
  const sources = outerDestructuredSources(binding, defaultAt);
  return sources.flatMap((source) => {
    return destructuredBindingOrigins({
      checkPresence: checkProjectedPresence,
      defaultAt,
      pattern: parameter.name,
      readAt: at,
      source,
      targetText: declared.text,
    });
  });
}

/** Computes incoming argument and outer-default `Origin`s for a destructured parameter. */
function outerDestructuredSources(
  binding: ParameterFrame,
  defaultAt: Origin,
): readonly (Origin | undefined)[] {
  const { frame, index, parameter } = binding;
  const outerDefault: Origin | undefined =
    parameter.initializer === undefined
      ? undefined
      : {
          ...defaultAt,
          excluded: undefined,
          keys: [],
          spread: undefined,
          value: parameter.initializer,
        };
  if (frame.given === undefined || (frame.openTail === true && index >= frame.given.length)) {
    return outerDefault === undefined ? [undefined] : [undefined, outerDefault];
  }
  const given = index < frame.given.length ? frame.given[index] : undefined;
  if (given === undefined) {
    return outerDefault === undefined ? [undefined] : [outerDefault];
  }
  const cleanGiven: Origin = {
    ...given,
    excluded: undefined,
    keys: [...given.keys],
    spread: undefined,
  };
  const presence = argumentPresence(given);
  if (presence === 'undefined') {
    return outerDefault === undefined ? [undefined] : [outerDefault];
  }
  if (presence === 'defined' || outerDefault === undefined) {
    return [cleanGiven];
  }
  return [cleanGiven, outerDefault];
}

/** Projects a destructured rest parameter (`...[a, b]` or `...{ 0: a }`) across caller args. */
function destructuredRestOrigins(
  binding: ParameterFrame,
  at: Origin,
  defaultAt: Origin,
): readonly Origin[] {
  const { declared, frame, index, parameter } = binding;
  if (frame.given !== undefined) {
    return restPatternOrigins(parameter.name, frame.given.slice(index), {
      at,
      defaultAt,
      openTail: frame.openTail === true,
      targetText: declared.text,
    });
  }
  return destructuredBindingOrigins({
    defaultAt,
    pattern: parameter.name,
    readAt: at,
    source: undefined,
    targetText: declared.text,
  });
}

/** Recursively projects a rest slice `givenSlice` onto an array, object, or leaf rest `pattern`. */
function restPatternOrigins(
  pattern: BindingName,
  givenSlice: readonly Origin[],
  origins: RestPatternRead,
): readonly Origin[] {
  if (isIdentifier(pattern)) {
    if (pattern.text !== origins.targetText) {
      return [];
    }
    return origins.openTail
      ? openTailRestOrigins(givenSlice, origins.at)
      : restOrigins(givenSlice, origins.at);
  }
  return isArrayBindingPattern(pattern)
    ? arrayRestPatternOrigins(pattern, givenSlice, origins)
    : objectRestPatternOrigins(pattern, givenSlice, origins);
}

/** Projects known prefix elements of an open-tail rest slice conservatively across `at`. */
function openTailRestOrigins(given: readonly Origin[], at: Origin): readonly Origin[] {
  if (at.keys.length === 0) {
    return given.map((each) => ({ ...each, excluded: undefined, spread: undefined }));
  }
  const [firstKey, ...rest] = at.keys;
  if (firstKey === null || (firstKey !== undefined && arrayIndex(firstKey) !== undefined)) {
    return given.map((each) => {
      return {
        ...each,
        excluded: at.excluded,
        keys: [...each.keys, ...rest],
        spread: at.spread,
      };
    });
  }
  return [];
}

/** Projects a rest slice onto an `ArrayBindingPattern`, recursing into nested `...` patterns. */
function arrayRestPatternOrigins(
  pattern: ArrayBindingPattern,
  givenSlice: readonly Origin[],
  origins: RestPatternRead,
): readonly Origin[] {
  const found: Origin[] = [];
  for (const [slot, element] of pattern.elements.entries()) {
    if (
      isOmittedExpression(element) ||
      element.name === undefined ||
      !bindsHoistedName(element.name, origins.targetText)
    ) {
      continue;
    }
    if (element.dotDotDotToken !== undefined) {
      found.push(...restPatternOrigins(element.name, givenSlice.slice(slot), origins));
      continue;
    }
    found.push(...restSlotElementOrigins(element, givenSlice[slot], origins));
  }
  return found;
}

/** Projects a rest slice onto an `ObjectBindingPattern` (`...{ 0: a, ...rest }`). */
function objectRestPatternOrigins(
  pattern: ObjectBindingPattern,
  givenSlice: readonly Origin[],
  origins: RestPatternRead,
): readonly Origin[] {
  const found: Origin[] = [];
  const omittedKeys = new Set<string>();
  for (const element of pattern.elements) {
    if (element.dotDotDotToken !== undefined) {
      if (bindsHoistedName(element.name, origins.targetText)) {
        found.push(...objectRestSliceOrigins(givenSlice, origins, omittedKeys));
      }
      continue;
    }
    const key = bindingPropertyKey(element, origins.at.context);
    if (bindsHoistedName(element.name, origins.targetText)) {
      found.push(...objectRestElementOrigins(element, key, givenSlice, origins));
    }
    if (key !== null) {
      omittedKeys.add(key);
    }
  }
  return found;
}

/** Projects one indexed slot and optional default initializer of a rest destructuring element. */
function restSlotElementOrigins(
  element: BindingElement,
  slotOrigin: Origin | undefined,
  origins: RestPatternRead,
): readonly Origin[] {
  const { name } = element;
  if (name === undefined) {
    return [];
  }
  const fromSlot = slotOrigin === undefined ? [] : projectRestSlot(name, slotOrigin, origins);
  if (element.initializer === undefined) {
    return fromSlot;
  }
  if (slotOrigin !== undefined && argumentPresence(slotOrigin) === 'defined') {
    return fromSlot;
  }
  const fromDefault = projectRestDefault(name, element.initializer, origins);
  const skipSlot = slotOrigin !== undefined && argumentPresence(slotOrigin) === 'undefined';
  return skipSlot ? fromDefault : [...fromSlot, ...fromDefault];
}

/** Projects one `ObjectBindingPattern` property against `givenSlice` at `key`. */
function objectRestElementOrigins(
  element: BindingElement,
  key: string | null,
  givenSlice: readonly Origin[],
  origins: RestPatternRead,
): readonly Origin[] {
  const { name } = element;
  if (name === undefined) {
    return [];
  }
  if (key === null) {
    const fromSlots = givenSlice.flatMap((slot) => projectRestSlot(name, slot, origins));
    const fromDefault =
      element.initializer === undefined
        ? []
        : projectRestDefault(name, element.initializer, origins);
    return [...fromSlots, ...fromDefault];
  }
  const index = arrayIndex(key);
  if (index !== undefined) {
    return restSlotElementOrigins(element, givenSlice[index], origins);
  }
  if (key === 'length' || element.initializer === undefined) {
    return [];
  }
  return projectRestDefault(name, element.initializer, origins);
}

/** Projects a single `slotOrigin` through `pattern` for `origins.targetText`. */
function projectRestSlot(
  pattern: BindingName,
  slotOrigin: Origin,
  origins: RestPatternRead,
): readonly Origin[] {
  const cleanSlot: Origin = {
    ...slotOrigin,
    excluded: undefined,
    keys: [...slotOrigin.keys],
    spread: undefined,
  };
  return destructuredBindingOrigins({
    checkPresence: checkProjectedPresence,
    defaultAt: origins.defaultAt,
    pattern,
    readAt: origins.at,
    source: cleanSlot,
    targetText: origins.targetText,
  });
}

/** Projects a rest binding element's `initializer` default expression through `pattern`. */
function projectRestDefault(
  pattern: BindingName,
  initializer: Expression,
  origins: RestPatternRead,
): readonly Origin[] {
  const fallback: Origin = {
    ...origins.defaultAt,
    excluded: undefined,
    keys: [],
    spread: undefined,
    value: initializer,
  };
  return destructuredBindingOrigins({
    checkPresence: checkProjectedPresence,
    defaultAt: origins.defaultAt,
    pattern,
    readAt: origins.at,
    source: fallback,
    targetText: origins.targetText,
  });
}

/** Projects `{ ...rest }` on a rest-parameter slice `givenSlice`, excluding `omittedKeys`. */
function objectRestSliceOrigins(
  givenSlice: readonly Origin[],
  origins: RestPatternRead,
  omittedKeys: ReadonlySet<string>,
): readonly Origin[] {
  const { at } = origins;
  if (at.keys.length === 0) {
    return givenSlice.flatMap((each, idx) => {
      const skipped =
        omittedKeys.has(String(idx)) ||
        (at.spread === true && at.excluded?.has(String(idx)) === true) ||
        isOmittedExpression(each.value);
      return skipped ? [] : [{ ...each, excluded: undefined, keys: each.keys, spread: undefined }];
    });
  }
  const [firstKey, ...rest] = at.keys;
  if (firstKey !== undefined && firstKey !== null && omittedKeys.has(firstKey)) {
    return [];
  }
  if (firstKey === undefined || firstKey === null) {
    return givenSlice.flatMap((each, idx) => {
      return omittedKeys.has(String(idx))
        ? []
        : [{ ...each, excluded: at.excluded, keys: [...each.keys, ...rest], spread: at.spread }];
    });
  }
  const index = arrayIndex(firstKey);
  const selected = index === undefined ? undefined : givenSlice[index];
  return selected === undefined
    ? []
    : [
        {
          ...selected,
          excluded: at.excluded,
          keys: [...selected.keys, ...rest],
          spread: at.spread,
        },
      ];
}

/** Resolves a rest parameter read, preserving index exclusions only when the rest array is intact. */
function restParameterOrigins(
  name: Identifier,
  binding: ParameterFrame,
  declared: Identifier,
  at: Origin,
): readonly Origin[] {
  const { frame, index } = binding;
  if (definitelyReassignedBefore(frame.fn, declared, name, at.context)) {
    return mutatedRestOrigins({ declared, fn: frame.fn, given: undefined, name }, at);
  }
  const given = frame.given?.slice(index);
  if (
    given === undefined ||
    frame.openTail === true ||
    restArrayChangedBefore(frame.fn, declared, name, at.context)
  ) {
    return mutatedRestOrigins({ declared, fn: frame.fn, given, name }, at);
  }
  return restOrigins(given, at);
}

/** A rest array's entries, or an explicitly unknown binding after a prior write/evaluation. */
export function spreadBinding(
  name: Identifier,
  at: Origin,
): { readonly values?: readonly Origin[] | undefined } | undefined {
  if (writtenBefore(name, at.context)) {
    return {};
  }
  const held = sourceValue(name, at.context);
  if (
    isArrayLiteralExpression(held) &&
    (interveningEvaluation(held, name) || arrayChangedBefore(name, at.context))
  ) {
    return {};
  }
  const binding = parameterFrame(name, at.context.frames);
  if (binding?.parameter.dotDotDotToken === undefined || at.keys.length > 0) {
    return undefined;
  }
  const { frame, index, parameter } = binding;
  return isIdentifier(parameter.name) &&
    frame.openTail !== true &&
    !restArrayChangedBefore(frame.fn, parameter.name, name, at.context)
    ? { values: frame.given?.slice(index) }
    : {};
}
