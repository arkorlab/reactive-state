import {
  isInferTypeNode,
  isIntersectionTypeNode,
  isLiteralTypeNode,
  isTypeLiteralNode,
  isUnionTypeNode,
  SyntaxKind,
  type TypeElement,
  type TypeLiteralNode,
  type TypeNode,
  type TypeParameterDeclaration,
} from 'typescript/ast';

import type { TypeReading } from './local-type-environment.ts';
import {
  callableObjectShape,
  callableSourcesRefused,
  implicitFunctionField,
  implicitFunctionPrimitiveMismatch,
} from './local-type-function-members.ts';
import { functionPatternMatch } from './local-type-function-patterns.ts';
import { indexPatternMatch, interfaceIndexPatternMatch } from './local-type-index-patterns.ts';
import type {
  Bindings,
  Compare,
  Matching,
  MatchResult,
  Pair,
  Resolve,
} from './local-type-inference-types.ts';
import {
  alternativesOf,
  expandedObjectPair,
  inferenceOwner,
  inferenceParameters,
  matchingUnionTypes,
  memberValue,
  sourceMember,
  intersectionSources,
} from './local-type-inference-work.ts';
import { inferredContravariance } from './local-type-inferred-candidates.ts';
import { interfaceShapeReadings } from './local-type-interface-members.ts';
import { methodPatternMatch } from './local-type-method-patterns.ts';
import { normalizedAnyOperand } from './local-type-never-any.ts';
import { emptyObjectIntersection } from './local-type-object-empty.ts';
import { absentMember as missing } from './local-type-object-inheritance.ts';
import { overloadedMemberMatch } from './local-type-overload-relations.ts';
import { referencePatternPairs } from './local-type-reference-patterns.ts';
import {
  sequencePattern,
  sequencePatternMatch,
  sequenceReading,
} from './local-type-sequence-patterns.ts';
import { signatureMemberPatternMatch } from './local-type-signature-patterns.ts';
import { memberName, optionalMember, weakMismatch } from './local-type-weak-objects.ts';

/** Conditional inference from explicitly written local object, reference and sequence patterns. */

/** The syntax-known match and each candidate environment for its inferred parameters. */
export function inferPattern(
  checked: TypeReading,
  pattern: TypeReading,
  resolve: Resolve,
  compare: Compare,
): { readonly matches: boolean | undefined; readonly alternatives: readonly Bindings[] } {
  const pending: Matching[] = [
    {
      compare,
      groups: [],
      expandedObjects: new Set(),
      matches: true,
      parameters: inferenceParameters(pattern.type),
      pending: [{ checked, pattern }],
      resolve,
    },
  ];
  const completed: Matching[] = [];
  for (let state = pending.pop(); state !== undefined; state = pending.pop()) {
    if (matchedState(state, pending)) {
      if (state.parameters.length === 0 && state.groups.length === 0 && state.matches === true)
        return { matches: true, alternatives: [new Map()] };
      completed.push(state);
    }
  }
  const matches = completed.some((state) => state.matches === true) ? true : undefined;
  return {
    alternatives: completed.flatMap((state) => alternativesOf(state.groups, state.resolve)),
    matches: completed.length === 0 ? false : matches,
  };
}

/** Conjunctive source requirements, with each alternative pattern continuing its own worklist. */
function matchedState(state: Matching, pending: Matching[]): boolean {
  for (let pair = state.pending.pop(); pair !== undefined; pair = state.pending.pop()) {
    const result = matchPair(pair, state);
    if (result.branches !== undefined) {
      for (const branch of result.branches) pending.push(forkedState(state, branch));
      return false;
    }
    if (result.matches === false) return false;
    if (result.matches === undefined) state.matches = undefined;
  }
  return true;
}

/** Captures from a failed pattern cannot leak into another alternative. */
function forkedState(state: Matching, branch: Pair): Matching {
  return {
    ...state,
    expandedObjects: new Set(state.expandedObjects),
    groups: state.groups.map((group) => {
      return {
        ...group,
        candidates: [...group.candidates],
        declarations: new Set(group.declarations),
      };
    }),
    pending: [...state.pending, branch],
  };
}

/** One pair after aliases and actual parameter environments have been resolved. */
function matchPair(pair: Pair, state: Matching): MatchResult {
  const written = state.resolve(pair.checked);
  const pattern = state.resolve(pair.pattern);
  if (written === undefined || pattern === undefined) return { matches: undefined };
  const checked =
    pattern.type.kind === SyntaxKind.NeverKeyword
      ? written
      : (normalizedAnyOperand(written, state.resolve, state.compare) ?? written);
  if (isInferTypeNode(pattern.type)) {
    inferredMatch(checked, pattern, pattern.type.typeParameter, state);
    return { matches: true };
  }
  if (isUnionTypeNode(checked.type)) {
    const types = matchingUnionTypes(checked.type.types, state);
    for (const type of types) {
      state.pending.push({ checked: { ...checked, type }, pattern });
    }
    return { matches: true };
  }
  if (isUnionTypeNode(pattern.type)) {
    if (checked.type.kind === SyntaxKind.BooleanKeyword) {
      return { matches: booleanUnionMatch(pattern, pattern.type.types, state) };
    }
    return {
      branches: matchingUnionTypes(pattern.type.types, state).map((type) => {
        const expected = { ...pattern, type };
        return { checked, pattern: expected };
      }),
      matches: true,
    };
  }
  // The first expansion keeps every child obligation in this branch's worklist.
  if (
    state.parameters.length === 0 &&
    inferenceParameters(pattern.type).length === 0 &&
    expandedObjectPair(checked, pattern, state.expandedObjects)
  ) {
    return { matches: true };
  }
  return structuredMatch(checked, pattern, state);
}

/** Written containers retain their own operand environments while their selected members match. */
function structuredMatch(checked: TypeReading, pattern: TypeReading, state: Matching): MatchResult {
  const callable = functionPatternMatch(checked, pattern, state.resolve, state.compare);
  if (callable !== undefined) {
    state.pending.push(...callable.pairs);
    return { matches: callable.matches };
  }
  const source = sequenceReading(checked);
  const target = sequenceReading(pattern);
  if (isTypeLiteralNode(target.reading.type)) {
    return { matches: objectMatch(source.reading, target.reading, target.reading.type, state) };
  }
  if (sequencePattern(target.reading)) {
    if (source.readonly && !target.readonly) return { matches: false };
    const result = sequencePatternMatch(source.reading, target.reading, state.resolve);
    if (result !== undefined) {
      state.pending.push(...result.pairs);
      return { matches: result.matches };
    }
  }
  const argumentsOfReference = referencePatternPairs(
    checked,
    pattern,
    state.parameters.length === 0 || inferenceParameters(pattern.type).length === 0,
  );
  if (argumentsOfReference !== undefined) {
    const unwritten = argumentsOfReference.filter((pair) => pair.unwritten === true);
    state.pending.push(...argumentsOfReference.filter((pair) => pair.unwritten !== true));
    return { matches: unwritten.every((pair) => bothWays(pair, state)) ? true : undefined };
  }
  return { matches: state.compare(checked, pattern) };
}

/** A parameter of no written variance holds where both directions do; otherwise either may hold. */
function bothWays(pair: Pair, state: Matching): boolean {
  return [pair, { checked: pair.pattern, pattern: pair.checked }].every(
    (each) =>
      inferPattern(each.checked, each.pattern, state.resolve, state.compare).matches === true,
  );
}

/** Boolean's two literal values can collectively match a union, although neither alone covers it. */
function booleanUnionMatch(
  pattern: TypeReading,
  alternatives: readonly TypeNode[],
  state: Matching,
): boolean | undefined {
  const kinds = new Set<SyntaxKind>();
  const pending = alternatives.map((type) => ({ ...pattern, type }));
  let unknown = false;
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const resolved = state.resolve(at);
    if (resolved?.type.kind === SyntaxKind.BooleanKeyword) return true;
    if (resolved !== undefined && isUnionTypeNode(resolved.type)) {
      pending.push(...resolved.type.types.map((type) => ({ ...resolved, type })));
    } else if (resolved !== undefined && isLiteralTypeNode(resolved.type)) {
      kinds.add(resolved.type.literal.kind);
    } else {
      unknown = true;
    }
  }
  if (kinds.has(SyntaxKind.TrueKeyword) && kinds.has(SyntaxKind.FalseKeyword)) return true;
  return unknown ? undefined : false;
}

/** An inferred candidate is the actual operand, never the constraint that bounds it. */
function inferredMatch(
  checked: TypeReading,
  pattern: TypeReading,
  parameter: TypeParameterDeclaration,
  state: Matching,
): void {
  const owner = inferenceOwner(parameter);
  let group = state.groups.find(
    (each) => each.owner === owner && each.name === parameter.name.text,
  );
  if (group === undefined) {
    const parameters = state.parameters.find(
      (each) => each.owner === owner && each.name === parameter.name.text,
    );
    group = {
      candidates: [],
      declarations: new Set(parameters?.declarations),
      name: parameter.name.text,
      owner,
    };
    state.groups.push(group);
  }
  group.declarations.add(parameter);
  group.candidates.push({
    reading: checked,
    contravariant: inferredContravariance(parameter, owner),
  });
  if (parameter.constraint !== undefined) {
    state.pending.push({ checked, pattern: { ...pattern, type: parameter.constraint } });
  }
}

/** Required written fields are matched by name, without inspecting unrelated source fields. */
function objectMatch(
  checked: TypeReading,
  pattern: TypeReading,
  target: TypeLiteralNode,
  state: Matching,
): boolean | undefined {
  const interfaces = interfaceShapeReadings(checked, (at) => [state.resolve(at) ?? at]);
  if (interfaces !== undefined) return interfaceObjectMatch(interfaces, pattern, target, state);
  if (isIntersectionTypeNode(checked.type))
    return intersectionObjectMatch(checked, pattern, target, state);
  const shape = callableObjectShape(checked.type);
  if (shape === undefined) return state.compare(checked, pattern);
  if (weakMismatch([shape], target) === true) return false;
  let matches: boolean | undefined = true;
  for (const member of target.members) {
    const result = isTypeLiteralNode(checked.type)
      ? objectMember({ ...checked, type: checked.type }, pattern, member, state)
      : missingObjectMember([checked], pattern, member, state);
    if (result === false) return false;
    if (result === undefined) matches = undefined;
  }
  return matches;
}

/** One named object member, with optional source and target fields kept distinct. */
function objectMember(
  checked: TypeReading & { readonly type: TypeLiteralNode },
  pattern: TypeReading,
  member: TypeElement,
  state: Matching,
): boolean | undefined {
  const signature = signatureMemberPatternMatch(
    checked,
    { reading: pattern, member },
    {
      resolve: state.resolve,
      compare: state.compare,
      overloads: sourceOverloadComparison(member, state),
    },
  );
  if (signature !== undefined) {
    state.pending.push(...signature.pairs);
    return signature.matches;
  }
  const indexed = indexPatternMatch(checked, pattern, member);
  if (indexed !== undefined) {
    state.pending.push(...indexed.pairs);
    return indexed.matches;
  }
  const name = memberName(member);
  if (name === undefined) return undefined;
  const overloaded = overloadedMatch([checked], pattern, { member, name }, state);
  if (overloaded !== undefined) return overloaded.matches;
  const source = sourceMember(checked.type, name);
  if (source === undefined) return undefined;
  if (source === null) return missingObjectMember([checked], pattern, member, state);
  if (optionalMember(source) && !optionalMember(member)) return false;
  const method = methodPatternMatch(
    { member: source, reading: checked },
    { member, reading: pattern },
    state.resolve,
    state.compare,
  );
  if (method !== undefined) {
    state.pending.push(...method.pairs);
    return method.matches;
  }
  const value = memberValue(member);
  const actual = memberValue(source);
  if (actual === undefined || value === undefined) return undefined;
  state.pending.push({
    checked: { ...checked, type: actual },
    pattern: { ...pattern, type: value },
  });
  return true;
}

/** Written suppliers win before any implicit Function metadata or inherited Object fallback. */
function missingObjectMember(
  sources: readonly TypeReading[],
  pattern: TypeReading,
  member: TypeElement,
  state: Matching,
): boolean | undefined {
  const name = memberName(member);
  if (name === undefined) return undefined;
  const actual = implicitFunctionField(sources, name);
  if (actual === null) return missing(member, pattern, state);
  const value = memberValue(member);
  if (value === undefined) return undefined;
  if (actual === undefined)
    return implicitFunctionPrimitiveMismatch(
      name,
      state.resolve({ ...pattern, type: value }),
      state.resolve,
    );
  state.pending.push({ checked: actual, pattern: { ...pattern, type: value } });
  return true;
}

/** A source method's overloads meet a non-inference requirement where any one alone does. */
function overloadedMatch(
  sources: readonly (TypeReading & { readonly type: TypeLiteralNode })[],
  pattern: TypeReading,
  required: { readonly member: TypeElement; readonly name: string },
  state: Matching,
): { readonly matches: boolean | undefined } | undefined {
  if (inferenceParameters(required.member).length > 0) return undefined;
  return overloadedMemberMatch(
    sources,
    pattern,
    required,
    (overload, expected) => inferPattern(overload, expected, state.resolve, state.compare).matches,
  );
}

/** Non-inference requirements compare finite overload alternatives with the existing matcher. */
function sourceOverloadComparison(member: TypeElement, state: Matching): Compare | undefined {
  if (inferenceParameters(member).length > 0) return undefined;
  return (overload, expected) => {
    const matched = inferPattern(overload, expected, state.resolve, state.compare);
    return matched.matches;
  };
}

/** An intersection's uniquely supplied named fields retain each constituent's argument environment. */
function intersectionObjectMatch(
  checked: TypeReading,
  pattern: TypeReading,
  target: TypeLiteralNode,
  state: Matching,
): boolean | undefined {
  const sources = intersectionSources(checked, state.resolve);
  const empty = emptyObjectIntersection(sources, state.resolve);
  if (empty === true) return inferenceParameters(pattern.type).length === 0 ? true : undefined;
  const rejected = empty === undefined ? undefined : false;
  const types = sources.sources.map((each) => each.type);
  if (!sources.unknown && weakMismatch(types, target) === true) return rejected;
  const writtenOnly =
    inferenceParameters(pattern.type).length === 0 &&
    callableSourcesRefused(
      [...sources.sources, ...sources.callables],
      pattern,
      (actual, expected) => inferPattern(actual, expected, state.resolve, state.compare).matches,
    );
  const shape = { ...sources, writtenOnly };
  let matches: boolean | undefined = sources.unknown ? undefined : true;
  for (const member of target.members) {
    const result = intersectionMember(shape, pattern, member, state);
    if (result === false) return rejected;
    if (result === undefined) matches = undefined;
  }
  return matches;
}

/** A named requirement follows one known supplier; conflicting or opaque suppliers remain uncertain. */
function intersectionMember(
  source: ReturnType<typeof intersectionSources> & { readonly writtenOnly: boolean },
  pattern: TypeReading,
  member: TypeElement,
  state: Matching,
): boolean | undefined {
  const name = memberName(member);
  if (name === undefined) return undefined;
  const supplied = source.sources.filter((each) => sourceMember(each.type, name) !== null);
  if (supplied.length === 0)
    return source.unknown
      ? undefined
      : missingObjectMember([...source.sources, ...source.callables], pattern, member, state);
  const [selected] = supplied;
  if (selected === undefined || supplied.length !== 1) return undefined;
  if (source.writtenOnly || optionalMember(member))
    return objectMember(selected, pattern, member, state);
  const others = [...source.sources.filter((each) => each !== selected), ...source.callables];
  const implicit = implicitFunctionField(others, name);
  if (implicit === null) return objectMember(selected, pattern, member, state);
  const written = sourceMember(selected.type, name);
  if (implicit === undefined || written === undefined || written === null) return undefined;
  const actual = memberValue(written);
  const value = memberValue(member);
  if (actual === undefined || value === undefined) return undefined;
  const reading = { ...selected, type: actual };
  const expected = { ...pattern, type: value };
  if (
    inferPattern(reading, expected, state.resolve, state.compare).matches !== true &&
    inferPattern(reading, implicit, state.resolve, state.compare).matches !== true
  )
    return undefined;
  state.pending.push({ checked: reading, pattern: expected });
  return true;
}

/** Own fields precede inherited fields; each match keeps its selected declaration's environment. */
function interfaceObjectMatch(
  interfaces: NonNullable<ReturnType<typeof interfaceShapeReadings>>,
  pattern: TypeReading,
  target: TypeLiteralNode,
  state: Matching,
): boolean | undefined {
  const unknown =
    interfaces.unknown || interfaces.sources.some((source) => !isTypeLiteralNode(source.type));
  const shape = { sources: interfaces.sources, unknown };
  const types = interfaces.sources.flatMap((source) =>
    isTypeLiteralNode(source.type) ? [source.type] : [],
  );
  if (!unknown && weakMismatch(types, target) === true) return false;
  let matches: boolean | undefined = unknown ? undefined : true;
  for (const member of target.members) {
    const result = interfaceMemberMatch(shape, pattern, member, state);
    if (result === false) return false;
    if (result === undefined) matches = undefined;
  }
  return matches;
}

/** One selected interface domain or named member, with each source retaining its own bindings. */
function interfaceMemberMatch(
  { sources, unknown }: NonNullable<ReturnType<typeof interfaceShapeReadings>>,
  pattern: TypeReading,
  member: TypeElement,
  state: Matching,
): boolean | undefined {
  const indexed = interfaceIndexPatternMatch({ sources, unknown }, pattern, member, state);
  if (indexed !== undefined) {
    state.pending.push(...indexed.pairs);
    return indexed.matches;
  }
  const name = memberName(member);
  if (name === undefined) return undefined;
  const shapes = sources.flatMap((source) => {
    const { type } = source;
    return isTypeLiteralNode(type) ? [{ ...source, aliases: new Set<string>(), type }] : [];
  });
  const overloaded = overloadedMatch(shapes, pattern, { member, name }, state);
  if (overloaded !== undefined) return overloaded.matches;
  const selected = sources.find(
    (source) => isTypeLiteralNode(source.type) && sourceMember(source.type, name) !== null,
  );
  if (selected !== undefined && isTypeLiteralNode(selected.type))
    return objectMember(
      { ...selected, aliases: new Set<string>(), type: selected.type },
      pattern,
      member,
      state,
    );
  return unknown ? undefined : missingObjectMember(sources, pattern, member, state);
}
