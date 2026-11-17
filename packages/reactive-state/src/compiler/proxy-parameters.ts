import {
  type ArrayBindingPattern,
  type Expression,
  type Identifier,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isIdentifier,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import { parameterValue } from './parameter-values.ts';
import { mutatedRestOrigins } from './proxy-array-writes.ts';
import {
  arrayChangedBefore,
  arrayIndex,
  restArrayChangedBefore,
  spreadElementOrigins,
} from './proxy-arrays.ts';
import { bindsHoistedName, destructuredBindingOrigins } from './proxy-parameter-patterns.ts';
import { assignedParameterOrigins, definitelyReassignedBefore } from './proxy-parameter-writes.ts';
import {
  argumentPresence,
  frameContextOf,
  parameterFrame,
  type ParameterFrame,
  parameterReassigned,
} from './proxy-presence.ts';
import {
  type Context,
  type Frame,
  heldConstant,
  type Origin,
  peeled,
  propertyKey,
  sourceValue,
  writtenBefore,
} from './proxy-values.ts';
import { interveningEvaluation } from './written-evaluation.ts';

export { type ParameterFrame, parameterFrame } from './proxy-presence.ts';

interface ProjectedStep {
  readonly next?: Expression | undefined;
  readonly status?: 'defined' | 'possible' | 'undefined' | undefined;
}

/** Own property names on `Object.prototype` that are inherited by plain `{}` literals. */
const OBJECT_PROTOTYPE_KEYS: ReadonlySet<string> = new Set(
  Object.getOwnPropertyNames(Object.prototype),
);

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
      checkPresence: projectedOriginPresence,
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
  if (
    frame.given !== undefined &&
    frame.openTail !== true &&
    isArrayBindingPattern(parameter.name)
  ) {
    return exactArrayRestPatternOrigins(parameter.name, frame.given.slice(index), declared.text, {
      at,
      defaultAt,
    });
  }
  const fromDefaults = destructuredBindingOrigins({
    defaultAt,
    pattern: parameter.name,
    readAt: at,
    source: undefined,
    targetText: declared.text,
  });
  const fromGiven = (frame.given?.slice(index) ?? []).map((each) => {
    return {
      ...each,
      excluded: at.excluded,
      keys: [...each.keys, ...at.keys],
      spread: at.spread,
    };
  });
  return [...fromDefaults, ...fromGiven];
}

/** Projects an exact closed rest slice onto an `ArrayBindingPattern` rest parameter. */
function exactArrayRestPatternOrigins(
  pattern: ArrayBindingPattern,
  givenSlice: readonly Origin[],
  targetText: string,
  origins: { readonly at: Origin; readonly defaultAt: Origin },
): readonly Origin[] {
  const found: Origin[] = [];
  for (const [slot, element] of pattern.elements.entries()) {
    if (
      isOmittedExpression(element) ||
      element.name === undefined ||
      !bindsHoistedName(element.name, targetText)
    ) {
      continue;
    }
    if (element.dotDotDotToken !== undefined) {
      found.push(...restOrigins(givenSlice.slice(slot), origins.at));
      continue;
    }
    const slotOrigin = givenSlice[slot];
    if (slotOrigin !== undefined) {
      const cleanSlot: Origin = {
        ...slotOrigin,
        excluded: undefined,
        keys: [...slotOrigin.keys],
        spread: undefined,
      };
      found.push(
        ...destructuredBindingOrigins({
          checkPresence: projectedOriginPresence,
          defaultAt: origins.defaultAt,
          pattern: element.name,
          readAt: origins.at,
          source: cleanSlot,
          targetText,
        }),
      );
    }
    if (
      element.initializer !== undefined &&
      (slotOrigin === undefined || argumentPresence(slotOrigin) !== 'defined')
    ) {
      const fallback: Origin = {
        ...origins.defaultAt,
        excluded: undefined,
        keys: [],
        spread: undefined,
        value: element.initializer,
      };
      found.push(
        ...destructuredBindingOrigins({
          checkPresence: projectedOriginPresence,
          defaultAt: origins.defaultAt,
          pattern: element.name,
          readAt: origins.at,
          source: fallback,
          targetText,
        }),
      );
    }
  }
  return found;
}

/** Classifies whether a projected destructuring `source` is defined, `undefined`, or either. */
function projectedOriginPresence(source: Origin): 'defined' | 'possible' | 'undefined' {
  if (source.keys.length === 0) {
    return argumentPresence(source);
  }
  let current: Expression = source.value;
  for (const key of source.keys) {
    if (key === null) {
      return 'possible';
    }
    const resolved = unwrapUnmutatedLiteral(current, source.context);
    if (resolved === undefined) {
      return 'possible';
    }
    const stepped = stepProjectedLiteral(resolved, key, source.context);
    if (stepped.status !== undefined) {
      return stepped.status;
    }
    if (stepped.next === undefined) {
      return 'possible';
    }
    current = stepped.next;
  }
  return argumentPresence({ ...source, keys: [], value: current });
}

/** Unwraps `expr` to an unmutated array or object literal when statically fixed. */
function unwrapUnmutatedLiteral(expr: Expression, context: Context): Expression | undefined {
  let current = peeled(expr);
  const seen = new Set<Expression>();
  while (isIdentifier(current) && !seen.has(current)) {
    seen.add(current);
    const held = heldConstant(current, context);
    if (
      held === undefined ||
      writtenBefore(current, context) ||
      arrayChangedBefore(current, context)
    ) {
      return undefined;
    }
    current = peeled(held);
  }
  return isObjectLiteralExpression(current) || isArrayLiteralExpression(current)
    ? current
    : undefined;
}

/** Steps one static `key` into an unmutated object or array literal for definedness checks. */
function stepProjectedLiteral(literal: Expression, key: string, context: Context): ProjectedStep {
  if (isArrayLiteralExpression(literal)) {
    const index = arrayIndex(key);
    if (index === undefined || literal.elements.some((each) => isSpreadElement(each))) {
      return { status: 'possible' };
    }
    const element = literal.elements[index];
    return element === undefined || isOmittedExpression(element)
      ? { status: 'undefined' }
      : { next: element };
  }
  return isObjectLiteralExpression(literal)
    ? stepProjectedObject(literal, key, context)
    : { status: 'possible' };
}

/** Steps one static `key` into an unmutated `ObjectLiteralExpression` for definedness checks. */
function stepProjectedObject(
  object: ObjectLiteralExpression,
  key: string,
  context: Context,
): ProjectedStep {
  for (const property of object.properties.toReversed()) {
    if (isSpreadAssignment(property)) {
      return { status: 'possible' };
    }
    const named = propertyKey(property.name, context);
    if (named === undefined) {
      return { status: 'possible' };
    }
    if (named !== key) {
      continue;
    }
    if (isPropertyAssignment(property)) {
      return { next: property.initializer };
    }
    if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
      return { next: property.name };
    }
    return { status: isMethodDeclaration(property) ? 'defined' : 'possible' };
  }
  return key === '__proto__' || OBJECT_PROTOTYPE_KEYS.has(key)
    ? { status: 'possible' }
    : { status: 'undefined' };
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

/** A rest array is fresh; only its indexed elements retain actual argument identities. */
function restOrigins(given: readonly Origin[], at: Origin): readonly Origin[] {
  if (at.keys.length === 0) {
    return spreadElementOrigins(given, at);
  }
  const [key, ...rest] = at.keys;
  if (key === undefined || key === null) {
    return given.map((each) => {
      return {
        ...each,
        excluded: at.excluded,
        keys: [...each.keys, ...rest],
        spread: at.spread,
      };
    });
  }
  const index = arrayIndex(key);
  const selected = index === undefined ? undefined : given[index];
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
