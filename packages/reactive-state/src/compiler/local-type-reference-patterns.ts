import {
  isClassDeclaration,
  isClassExpression,
  isIdentifier,
  isInterfaceDeclaration,
  isTypeAliasDeclaration,
  isTypeReferenceNode,
  type TypeReferenceNode,
  SyntaxKind,
} from 'typescript/ast';

import { localTypeBinding, mergedHeritageDeclarations } from './local-type-aliases.ts';
import { qualifiedBuiltinName } from './local-type-builtins.ts';
import type { GenericDeclaration, TypeReading } from './local-type-environment.ts';
import { qualifiedLocalTypeBinding } from './local-type-namespaces.ts';

/** Matching native Promise and identical local generic declarations retain their actual arguments. */

/**
 * A pair of corresponding reference arguments; `unwritten` where the generic parameter writes no
 * variance, which TypeScript measures from the declaration rather than reading it.
 */
export interface ReferencePair {
  readonly checked: TypeReading;
  readonly pattern: TypeReading;
  readonly unwritten?: true;
}

/** Corresponding reference arguments, in each argument's original lexical environment. */
export function referencePatternPairs(
  checked: TypeReading,
  pattern: TypeReading,
  variance = false,
): readonly ReferencePair[] | undefined {
  if (!isTypeReferenceNode(checked.type) || !isTypeReferenceNode(pattern.type)) return undefined;
  if (nativePromise(checked.type) && nativePromise(pattern.type)) {
    const argument = checked.type.typeArguments?.[0];
    const parameter = pattern.type.typeArguments?.[0];
    return argument === undefined || parameter === undefined
      ? undefined
      : [{ checked: { ...checked, type: argument }, pattern: { ...pattern, type: parameter } }];
  }
  const source = localGeneric(checked.type);
  if (source === undefined || source !== localGeneric(pattern.type)) return undefined;
  const actual = localArguments(checked, checked.type, source);
  const target = localArguments(pattern, pattern.type, source);
  if (actual === undefined || target === undefined) return;
  const pairs: ReferencePair[] = [];
  for (const [index, argument] of actual.entries()) {
    const parameter = target[index];
    if (parameter === undefined) return;
    pairs.push(
      ...argumentPairs(
        argument,
        parameter,
        variance ? parameterVariance(source, index) : undefined,
      ),
    );
  }
  return pairs;
}

/**
 * Declared input parameters reverse a relation; invariant parameters require both directions; a
 * parameter of no written variance, read for variance, is marked so its pair holds only where both
 * directions do.
 */
function argumentPairs(
  checked: TypeReading,
  pattern: TypeReading,
  modifiers: ReadonlySet<SyntaxKind> | undefined,
): readonly ReferencePair[] {
  const forward = { checked, pattern };
  if (modifiers === undefined) return [forward];
  if (!modifiers.has(SyntaxKind.InKeyword) && !modifiers.has(SyntaxKind.OutKeyword))
    return [{ ...forward, unwritten: true }];
  if (!modifiers.has(SyntaxKind.InKeyword)) return [forward];
  const backward = { checked: pattern, pattern: checked };
  return modifiers.has(SyntaxKind.OutKeyword) ? [forward, backward] : [backward];
}

/** Merged declarations contribute annotations of the same original generic parameter position. */
function parameterVariance(
  declaration: GenericDeclaration,
  index: number,
): ReadonlySet<SyntaxKind> {
  const declarations = isTypeAliasDeclaration(declaration)
    ? [declaration]
    : mergedHeritageDeclarations(declaration, true);
  const modifiers = new Set<SyntaxKind>();
  for (const source of declarations) {
    const written = source.typeParameters?.[index]?.modifiers;
    if (written === undefined) continue;
    for (const modifier of written) modifiers.add(modifier.kind);
  }
  return modifiers;
}

/** Lexically identical local declarations, without equating unrelated imports or same-spelled names. */
function localGeneric(type: TypeReferenceNode): GenericDeclaration | undefined {
  const name = type.typeName;
  const binding = isIdentifier(name) ? localTypeBinding(name) : qualifiedLocalTypeBinding(name);
  return binding !== undefined &&
    binding !== null &&
    (isInterfaceDeclaration(binding) ||
      isClassDeclaration(binding) ||
      isClassExpression(binding) ||
      isTypeAliasDeclaration(binding))
    ? binding
    : undefined;
}

/** Supplied arguments keep the caller's scope; defaults can refer to preceding actual parameters. */
function localArguments(
  reading: TypeReading,
  reference: TypeReferenceNode,
  declaration: GenericDeclaration,
): readonly TypeReading[] | undefined {
  const parameters = declaration.typeParameters ?? [];
  if (parameters.length === 0 || (reference.typeArguments?.length ?? 0) > parameters.length) return;
  const bindings = new Map(reading.bindings);
  const argumentsOfType: TypeReading[] = [];
  for (const [index, parameter] of parameters.entries()) {
    const actual = reference.typeArguments?.[index];
    const type = actual ?? parameter.defaultType;
    if (type === undefined) return;
    const value = actual === undefined ? { ...reading, bindings, type } : { ...reading, type };
    bindings.set(parameter, value);
    argumentsOfType.push(value);
  }
  return argumentsOfType;
}

/** Whether a reference is the native Promise type, rather than an import or local declaration. */
function nativePromise(type: TypeReferenceNode): boolean {
  if (type.typeArguments?.length !== 1) return false;
  const name = type.typeName;
  return isIdentifier(name)
    ? name.text === 'Promise' && localTypeBinding(name) === undefined
    : qualifiedBuiltinName(name) === 'Promise';
}
