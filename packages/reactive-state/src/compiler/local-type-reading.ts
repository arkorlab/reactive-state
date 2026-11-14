import {
  type ConditionalTypeNode,
  type ExpressionWithTypeArguments,
  type LiteralTypeNode,
  type IndexedAccessTypeNode,
  isClassDeclaration,
  isClassExpression,
  isConditionalTypeNode,
  isExpressionWithTypeArguments,
  isIdentifier,
  isInterfaceDeclaration,
  isIntersectionTypeNode,
  isIndexedAccessTypeNode,
  isLiteralTypeNode,
  isParenthesizedTypeNode,
  isTypeAliasDeclaration,
  isTypeParameterDeclaration,
  isTypeOperatorNode,
  isTypeQueryNode,
  isTypeReferenceNode,
  isUnionTypeNode,
  SyntaxKind,
  type TypeNode,
} from 'typescript/ast';

import {
  localTypeBinding,
  type LocalTypeBinding,
  mergedHeritageDeclarations,
} from './local-type-aliases.ts';
import { selectedArrayReadings, type ArrayReadingSelection } from './local-type-array-words.ts';
import { qualifiedBuiltinName } from './local-type-builtins.ts';
import { type CallResultSelection, singleCallResultReading } from './local-type-call-results.ts';
import { capturedTypeReading } from './local-type-captured-sequences.ts';
import { heritageReference } from './local-type-class-bases.ts';
import { conditionalUtilityReadings, literalValue } from './local-type-conditional-utilities.ts';
import { constrainedOperands, onPathOf } from './local-type-constrained-operands.ts';
import { conditionalChecks } from './local-type-distribution.ts';
import {
  constraintReading,
  boundTypeBody as boundBody,
  initialTypeReading as initialReading,
  type TypeReading as Reading,
} from './local-type-environment.ts';
import { inferPattern } from './local-type-inference.ts';
import { intersectedIndexReadings } from './local-type-intersected-indices.ts';
import { intrinsicIndexReadings } from './local-type-intrinsic-keys.ts';
import { qualifiedLocalTypeBinding } from './local-type-namespaces.ts';
import {
  selectedNativeArgument,
  transparentOperand,
  utilityArgument,
  type NativeArgumentSelection,
} from './local-type-native-arguments.ts';
import { normalizedAnyOperand } from './local-type-never-any.ts';
import { neverOperandTruth } from './local-type-never-relations.ts';
import { omittedReceiverReadings } from './local-type-omitted-receivers.ts';
import {
  primitiveKeysReader,
  COMPARISON_PRIMITIVES as PRIMITIVES,
  type Reference,
} from './local-type-primitive-identities.ts';
import { prototypeQueryBuiltin } from './local-type-prototype-queries.ts';
import { sameBindings } from './local-type-reading-bindings.ts';
import {
  indexedMemberReadings,
  arrayIterationKeys,
  memberReadings,
  returnTypeReadings,
} from './local-type-selections.ts';
import { awaitedReadings, literalKind, STANDARD_ERRORS } from './local-type-utility-readings.ts';
import { valueQueryReading } from './local-type-value-queries.ts';

/** Local type names read through aliases and their actual arguments, without inferring a value's type. */

/** A declared literal member path, retaining the selected field's actual argument environment. */
export function namesLocalMemberType(
  type: TypeNode | undefined,
  keys: readonly string[],
  names: ReadonlySet<string>,
): boolean {
  const operands = constrainedOperands((at) => operandReadings(at, names));
  const readings = type === undefined ? [] : memberReadings(initialReading(type), keys, operands);
  return namesReadings(readings, names);
}

/** Primitive alternatives beside an Error origin keep the existing type argument environments. */
export const localTypePrimitiveIdentityKeys = primitiveKeysReader({
  resolve: operandOf,
  members: constituentsOf,
  reference: referenceOf,
  referred: referredTypes,
  names: (readings) => namesReadings(readings, STANDARD_ERRORS, undefined, false),
});

/** A single written callable result retains its original generic environment and selected return path. */
export function namesLocalCallResult(
  type: TypeNode,
  keys: readonly string[],
  path: CallResultSelection,
  names: ReadonlySet<string>,
): boolean {
  const operands = (at: Reading) => operandReadings(at, names, false);
  const callables = memberReadings(initialReading(type), keys, operands).flatMap((at) =>
    operands(at),
  );
  return callables.some((callable) => {
    const result = singleCallResultReading(callable, operands, path.kind);
    if (result === undefined) return false;
    const selected = memberReadings(result.reading, path.keys, operands);
    return namesReadings(selected, names, undefined, path.kind === 'call' && !result.generic);
  });
}

/** A selected declared native array retains its original field and generic argument environments. */
export function namesLocalMemberArrayType(
  type: TypeNode | undefined,
  keys: readonly string[],
  names: ReadonlySet<string>,
  selection: ArrayReadingSelection = {},
): boolean {
  return (
    type !== undefined &&
    selectedArrayReadings(initialReading(type), keys, selection, {
      matches: (reading) => namesReadings([reading], names),
      operands: constrainedOperands((reading) => operandReadings(reading, names)),
    })
  );
}

/** A resolved native reference's selected actual argument, including written local class heritage. */
export function namesLocalTypeArgument(
  type: TypeNode | undefined,
  nativeNames: ReadonlySet<string>,
  index: number,
  names: ReadonlySet<string>,
): boolean {
  return namesReadings(type === undefined ? [] : [initialReading(type)], names, {
    nativeNames,
    index,
  });
}

const iterationOperands = constrainedOperands((reading) =>
  operandReadings(reading, STANDARD_ERRORS),
);

/**
 * Literal places of the iteration tuples a type may be, retaining each original type environment. A
 * type parameter no actual argument fills stands for its written constraint, as it does where
 * members and elements are selected.
 */
export function localArrayIterationKeys(
  type: TypeNode,
  keys: readonly string[],
): readonly string[] | undefined {
  const readings = memberReadings(initialReading(type), keys, iterationOperands);
  return arrayIterationKeys(readings, iterationOperands);
}

/** Whether any selected reading names a requested native type. */
function namesReadings(
  readings: readonly Reading[],
  names: ReadonlySet<string>,
  argument?: NativeArgumentSelection,
  constraints = true,
): boolean {
  const pending = [...readings];
  const seen = new Set<Reading>();
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (seen.has(at)) {
      continue;
    }
    seen.add(at);
    const each = at.type;
    const members = constituentsOf(each, at, names);
    if (members !== undefined) {
      pending.push(...members);
      continue;
    }
    const referred = referenceOf(each);
    if (referred === undefined) {
      continue;
    }
    const { binding, builtin } = referred;
    if (argument === undefined && builtin !== undefined && names.has(builtin)) return true;
    const selected = selectedNativeArgument(at, builtin, argument);
    if (selected !== undefined && namesReadings([selected], names, undefined, constraints))
      return true;
    pending.push(...referredTypes(binding, each as Reference, at, constraints));
  }
  return false;
}

/** The transparent constituents of a type; none of a reference or a structural shape. */
function constituentsOf(
  type: TypeNode | ExpressionWithTypeArguments,
  at: Reading,
  names: ReadonlySet<string>,
): readonly Reading[] | undefined {
  const captured = capturedTypeReading(type);
  if (captured !== undefined) return [captured];
  if (isParenthesizedTypeNode(type)) {
    return [{ ...at, type: type.type }];
  }
  if (isUnionTypeNode(type) || isIntersectionTypeNode(type)) {
    return type.types.map((member) => ({ ...at, type: member }));
  }
  if (isConditionalTypeNode(type)) return conditionalBranches(type, at, names);
  if (isIndexedAccessTypeNode(type)) return indexedReadings(type, at, names);
  const query = valueQueryReading(at, (reading) => operandReadings(reading, names));
  if (query !== undefined) return query;
  const result = utilityResults(at, names);
  if (result !== undefined) return result;
  const utility = utilityArgument(type);
  return utility === undefined ? undefined : [{ ...at, type: utility }];
}

/**
 * Explicit members selected from each possible written object and index result. A type parameter no
 * actual argument fills reads as its written constraint wherever the access names it, as it does
 * where a member is selected directly, and what is selected stays on the path that reached the
 * object, so a constraint that names its own parameter ends as a cycle.
 */
function indexedReadings(
  indexed: IndexedAccessTypeNode,
  at: Reading,
  names: ReadonlySet<string>,
): Reading[] {
  const operands = (reading: Reading, intersections?: boolean) =>
    constrainedOperands((each) => operandReadings(each, names, intersections))(reading);
  const single = (each: Reading) => [operandOf(each, true)].filter((read) => read !== undefined);
  const resolve = (reading: Reading) => constrainedOperands(single)(reading)[0];
  const objects = operands({ ...at, type: indexed.objectType });
  const indexReading = { ...at, type: indexed.indexType };
  const finite = intersectedIndexReadings(indexReading, resolve);
  const indices = finite ?? operands(indexReading);
  const result: Reading[] = [];
  for (const object of objects) {
    if (isExpressionWithTypeArguments(object.type)) continue;
    for (const index of indices) {
      if (isExpressionWithTypeArguments(index.type)) continue;
      result.push(...indexedMemberReadings(object, index, operands, resolve));
    }
  }
  if (finite === undefined) result.push(...intrinsicIndexReadings(indexReading, objects, operands));
  return onPathOf(result, objects);
}

/** Transparent operands of a selected member, keeping each result's actual argument environment. */
function operandReadings(at: Reading, names: ReadonlySet<string>, intersections = true): Reading[] {
  const result: Reading[] = [];
  const pending = [at];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    const read = operandOf(each, true);
    if (read === undefined) continue;
    if (!intersections && isIntersectionTypeNode(read.type)) {
      result.push(read);
      continue;
    }
    const members = constituentsOf(read.type, read, names);
    if (members === undefined) result.push(read);
    else pending.push(...members);
  }
  return result;
}

/** A type reference's binding, or a class base's value binding and unshadowed built-in name. */
function referenceOf(
  type: TypeNode | ExpressionWithTypeArguments,
): { readonly binding: LocalTypeBinding; readonly builtin: string | undefined } | undefined {
  if (isTypeQueryNode(type)) {
    const builtin = prototypeQueryBuiltin(type);
    return builtin === undefined ? undefined : { binding: undefined, builtin };
  }
  if (isTypeReferenceNode(type)) {
    const { typeName } = type;
    const binding = isIdentifier(typeName)
      ? localTypeBinding(typeName)
      : qualifiedLocalTypeBinding(typeName);
    let builtin: string | undefined;
    if (binding === undefined) {
      builtin = isIdentifier(typeName) ? typeName.text : qualifiedBuiltinName(typeName);
    }
    return { binding, builtin };
  }
  if (!isExpressionWithTypeArguments(type)) {
    return undefined;
  }
  return heritageReference(type.expression);
}

/** The local declaration's body or actual parameter argument a reference denotes. */
function referredTypes(
  binding: LocalTypeBinding,
  reference: Reference,
  at: Reading,
  constraints = true,
): Reading[] {
  if (binding === undefined || binding === null) {
    return [];
  }
  if (isTypeAliasDeclaration(binding)) {
    const bound = boundBody(binding, reference, at);
    return bound === undefined ? [] : [{ ...bound, type: binding.type }];
  }
  if (
    isClassDeclaration(binding) ||
    isClassExpression(binding) ||
    isInterfaceDeclaration(binding)
  ) {
    const declarations = mergedHeritageDeclarations(binding, isTypeReferenceNode(reference));
    return declarations.flatMap((declaration) => {
      const bound = boundBody(declaration, reference, at);
      const bases = declaration.heritageClauses?.find(
        (clause) => clause.token === SyntaxKind.ExtendsKeyword,
      );
      return bound === undefined
        ? []
        : (bases?.types.flatMap((type) => {
            return isExpressionWithTypeArguments(type) || isTypeReferenceNode(type)
              ? [{ ...bound, type }]
              : [];
          }) ?? []);
    });
  }
  const value =
    at.bindings.get(binding) ?? (constraints ? constraintReading(binding, at) : undefined);
  return value === undefined ? [] : [value];
}

/**
 * One operand in its original scope. Utilities preserve fields for member selection, but their
 * assignability can differ from the argument, so conditional comparisons leave them intact.
 */
function operandOf(
  at: Reading,
  utilities = false,
  preserve?: ReadonlySet<LocalTypeBinding>,
): Reading | undefined {
  let reading = at;
  const seen = new Set<Reading>();
  while (!seen.has(reading)) {
    seen.add(reading);
    const { type } = reading;
    const transparent = transparentOperand(reading, utilities);
    if (transparent !== undefined) {
      reading = transparent;
      continue;
    }
    const referred = referenceOf(type);
    if (
      referred?.binding === undefined ||
      referred.binding === null ||
      isClassDeclaration(referred.binding) ||
      isClassExpression(referred.binding) ||
      isInterfaceDeclaration(referred.binding) ||
      preserve?.has(referred.binding) === true
    ) {
      return reading;
    }
    const [next] = referredTypes(referred.binding, type as Reference, reading, false);
    if (next === undefined) {
      return isTypeParameterDeclaration(referred.binding) ? reading : undefined;
    }
    reading = next;
  }
  return undefined;
}

const WRITTEN_OBJECTS = new Set([
  SyntaxKind.ArrayType,
  SyntaxKind.ConstructorType,
  SyntaxKind.FunctionType,
  SyntaxKind.MappedType,
  SyntaxKind.TupleType,
  SyntaxKind.TypeLiteral,
]);
const ARRAY_TYPES = new Set(['Array', 'ReadonlyArray']);

/** The primitive category explicitly named by an operand, without treating a shape as a constraint. */
function operandKind(
  at: Reading,
  names: ReadonlySet<string>,
  constraint: boolean,
): SyntaxKind | undefined {
  const { type } = at;
  const referred = referenceOf(type);
  if (referred !== undefined) {
    const knownObject =
      (referred.builtin !== undefined &&
        (names.has(referred.builtin) || ARRAY_TYPES.has(referred.builtin))) ||
      (referred.binding !== undefined &&
        referred.binding !== null &&
        (isClassDeclaration(referred.binding) || isClassExpression(referred.binding)));
    return knownObject && !constraint ? SyntaxKind.ObjectKeyword : undefined;
  }
  if (isLiteralTypeNode(type)) {
    return constraint ? SyntaxKind.LiteralType : literalKind(type);
  }
  const readonly = isTypeOperatorNode(type) && type.operator === SyntaxKind.ReadonlyKeyword;
  return !constraint && (readonly || WRITTEN_OBJECTS.has(type.kind))
    ? SyntaxKind.ObjectKeyword
    : type.kind;
}

/** A literal constraint compared by value, with a distributive boolean keeping both alternatives. */
function literalTruth(
  checked: Reading,
  extended: LiteralTypeNode,
  check: SyntaxKind | undefined,
  distributes: boolean,
): boolean | undefined {
  if (isLiteralTypeNode(checked.type)) {
    const value = literalValue(checked.type);
    const target = literalValue(extended);
    return value === undefined || target === undefined ? undefined : value === target;
  }
  if (
    distributes &&
    check === SyntaxKind.BooleanKeyword &&
    literalKind(extended) === SyntaxKind.BooleanKeyword
  ) {
    return undefined;
  }
  if (check === SyntaxKind.UnknownKeyword) return false;
  return check !== undefined && PRIMITIVES.has(check) ? false : undefined;
}

/** A built-in error constraint's syntax-known relation; application shapes remain unknown. */
function builtinTruth(
  checked: Reading,
  extended: Reading,
  names: ReadonlySet<string>,
): boolean | undefined {
  const target = referenceOf(extended.type)?.builtin;
  if (target === undefined || !names.has(target)) return undefined;
  const source = referenceOf(checked.type)?.builtin;
  if (source !== undefined && names.has(source)) {
    return source === target || STANDARD_ERRORS.has(target) ? true : undefined;
  }
  const check = operandKind(checked, names, false);
  if (check === SyntaxKind.UnknownKeyword) return false;
  return check !== undefined && check !== SyntaxKind.ObjectKeyword && PRIMITIVES.has(check)
    ? false
    : undefined;
}

/** The result of comparing syntax-known operands; unknown comparisons keep both branches. */
function conditionalTruth(
  checked: Reading,
  extended: Reading,
  names: ReadonlySet<string>,
  distributes: boolean,
): boolean | undefined {
  const check = operandKind(checked, names, false);
  const constraint = operandKind(extended, names, true);
  if (constraint === SyntaxKind.UnknownKeyword || constraint === SyntaxKind.AnyKeyword) {
    return true;
  }
  if (check === SyntaxKind.NeverKeyword) {
    return true;
  }
  if (check === SyntaxKind.AnyKeyword) {
    return undefined;
  }
  if (isLiteralTypeNode(extended.type)) {
    return literalTruth(checked, extended.type, check, distributes);
  }
  const builtin = builtinTruth(checked, extended, names);
  if (builtin !== undefined) return builtin;
  if (check === undefined || constraint === undefined) {
    return undefined;
  }
  if (PRIMITIVES.has(check) && PRIMITIVES.has(constraint)) {
    return (
      check === constraint ||
      (check === SyntaxKind.UndefinedKeyword && constraint === SyntaxKind.VoidKeyword)
    );
  }
  if (constraint === SyntaxKind.NeverKeyword)
    return neverOperandTruth(checked, {
      written: (reading, preserve) => operandOf(reading, false, preserve),
      kind: (reading) => operandKind(reading, names, false),
      selected: (reading) => conditionalOperandOf(reading, names),
      compare: (source, target) => conditionalTruth(source, target, names, true),
    });
  return check === SyntaxKind.UnknownKeyword && PRIMITIVES.has(constraint) ? false : undefined;
}

/** Branches possible from the syntax of a conditional's operands; neither operand is its result. */
function conditionalBranches(
  conditional: ConditionalTypeNode,
  at: Reading,
  names: ReadonlySet<string>,
): readonly Reading[] {
  const resolve = (reading: Reading) => conditionalOperandOf(reading, names);
  return conditionalChecks(at, conditional.checkType, resolve, operandOf).flatMap(
    ({ context, checked, distributes }) => {
      const extended = { ...context, type: conditional.extendsType };
      const compare = (source: Reading, target: Reading) =>
        conditionalTruth(source, target, names, distributes);
      const operand = normalizedAnyOperand(checked, resolve, compare);
      const inferred =
        operand === undefined
          ? { matches: undefined, alternatives: [new Map(context.bindings)] }
          : inferPattern(operand, extended, resolve, compare);
      const yes = inferred.alternatives.map((bindings) => {
        const captured = new Map(context.bindings);
        for (const [parameter, value] of bindings) captured.set(parameter, value);
        return { ...context, bindings: captured, type: conditional.trueType };
      });
      const no = { ...context, type: conditional.falseType };
      if (inferred.matches === undefined) return [...yes, no];
      return inferred.matches ? yes : [no];
    },
  );
}

/** A uniquely selected conditional result, without distributing multiple result alternatives. */
function conditionalOperandOf(at: Reading, names: ReadonlySet<string>): Reading | undefined {
  const seen = new Map<Reading['type'], Reading[]>();
  let reading = operandOf(at);
  while (reading !== undefined) {
    const operand = reading;
    const { type } = operand;
    const results = utilityResults(operand, names);
    if (results === undefined && !isConditionalTypeNode(type)) return operand;
    const previous = seen.get(operand.type) ?? [];
    if (previous.some((each) => sameBindings(each, operand))) return operand;
    previous.push(operand);
    seen.set(operand.type, previous);
    const branches =
      results ?? (isConditionalTypeNode(type) ? conditionalBranches(type, operand, names) : []);
    if (branches.length !== 1) return operand;
    const selected = branches[0];
    reading = selected === undefined ? undefined : operandOf(selected);
  }
  return reading;
}

/** Native selected results can serve as conditional check operands in their original contexts. */
function utilityResults(at: Reading, names: ReadonlySet<string>): readonly Reading[] | undefined {
  return (
    omittedReceiverReadings(at, (reading) => operandReadings(reading, names, false)) ??
    returnTypeReadings(at, (reading) => operandReadings(reading, names, false)) ??
    awaitedReadings(at, (reading) => operandReadings(reading, names, false)) ??
    conditionalUtilityReadings(
      at,
      (reading) => conditionalOperandOf(reading, names),
      (source, target) => conditionalTruth(source, target, names, true),
    )
  );
}
