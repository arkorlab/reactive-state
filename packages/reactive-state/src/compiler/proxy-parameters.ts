import {
  type Identifier,
  isArrayLiteralExpression,
  isIdentifier,
  type ParameterDeclaration,
} from 'typescript/ast';

import { parameterValue } from './parameter-values.ts';
import { mutatedRestOrigins } from './proxy-array-writes.ts';
import {
  arrayChangedBefore,
  arrayIndex,
  restArrayChangedBefore,
  spreadElementOrigins,
} from './proxy-arrays.ts';
import { assignedParameterOrigins, definitelyReassignedBefore } from './proxy-parameter-writes.ts';
import {
  argumentPresence,
  parameterFrame,
  type ParameterFrame,
  parameterReassigned,
} from './proxy-presence.ts';
import { type Frame, type Origin, sourceValue, writtenBefore } from './proxy-values.ts';
import { interveningEvaluation } from './written-evaluation.ts';

export { type ParameterFrame, parameterFrame } from './proxy-presence.ts';

/** Resolves a parameter read through replacements, reassignments, arguments, and defaults. */
export function parameterOrigins(
  name: Identifier,
  binding: ParameterFrame,
  at: Origin,
): readonly Origin[] {
  const { frame, index, parameter } = binding;
  if (!isIdentifier(parameter.name)) {
    return [];
  }
  const replaced = parameterReassigned(frame.fn, parameter.name)
    ? parameterValue(frame.fn, parameter.name, name)
    : undefined;
  if (replaced !== undefined) {
    return [{ ...at, value: replaced.value }];
  }
  if (parameter.dotDotDotToken !== undefined) {
    return restParameterOrigins(name, binding, parameter.name, at);
  }
  const assigned = assignedParameterOrigins(frame.fn, parameter.name, at);
  return definitelyReassignedBefore(frame.fn, parameter.name, name, at.context)
    ? assigned
    : [...assigned, ...incomingParameterOrigins(frame, index, parameter, at)];
}

/** Incoming argument and `undefined`-fallback origins before any body assignment runs. */
function incomingParameterOrigins(
  frame: Frame,
  index: number,
  parameter: ParameterDeclaration,
  at: Origin,
): readonly Origin[] {
  const fallback: readonly Origin[] =
    parameter.initializer === undefined ? [] : [{ ...at, value: parameter.initializer }];
  const given = frame.given?.[index];
  if (frame.given === undefined || given === undefined) {
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

/** Resolves a rest parameter read, preserving index exclusions only when the rest array is intact. */
function restParameterOrigins(
  name: Identifier,
  binding: ParameterFrame,
  declared: Identifier,
  at: Origin,
): readonly Origin[] {
  const { frame, index } = binding;
  const assigned = assignedParameterOrigins(frame.fn, declared, at);
  if (definitelyReassignedBefore(frame.fn, declared, name, at.context)) {
    return [
      ...assigned,
      ...mutatedRestOrigins({ declared, fn: frame.fn, given: undefined, name }, at),
    ];
  }
  const given = frame.given?.slice(index);
  if (given === undefined || restArrayChangedBefore(frame.fn, declared, name, at.context)) {
    return [...assigned, ...mutatedRestOrigins({ declared, fn: frame.fn, given, name }, at)];
  }
  return [...assigned, ...restOrigins(given, at)];
}

/** A rest array is fresh; only its indexed elements retain actual argument identities. */
function restOrigins(given: readonly Origin[], at: Origin): readonly Origin[] {
  if (at.keys.length === 0) {
    return spreadElementOrigins(given, at);
  }
  const [key, ...rest] = at.keys;
  if (key === undefined || key === null) {
    return given.map((each) => ({
      ...each,
      excluded: at.excluded,
      keys: [...each.keys, ...rest],
      spread: at.spread,
    }));
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
    !restArrayChangedBefore(frame.fn, parameter.name, name, at.context)
    ? { values: frame.given?.slice(index) }
    : {};
}
