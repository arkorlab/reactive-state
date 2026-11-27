import {
  type Expression,
  isArrowFunction,
  isClassDeclaration,
  isClassExpression,
  isClassStaticBlockDeclaration,
  isConstructorDeclaration,
  isElementAccessExpression,
  isIdentifier,
  isNumericLiteral,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isSetAccessorDeclaration,
  isSourceFile,
  isStringLiteral,
  type ParameterDeclaration,
} from 'typescript/ast';

import { type Answering, isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { frameDeclarationOf, frameMemberName } from './framed-bindings.ts';
import { framedDirectMemberReturn } from './framed-direct-member-return.ts';
import { framedNativeErrorInput } from './framed-native-error-inputs.ts';
import { framedQuietPrimitive, framedQuietSource } from './framed-native-evaluation.ts';

/** A non-arrow callable's directly returned arguments slot retains its simple unchanged parameter. */

/** Known positional slots project only original parameter names, preserving their lexical member paths. */
export function framedArgumentMember(
  node: Expression,
  keys: readonly string[],
  error: (value: Expression, path: readonly string[]) => boolean,
): boolean {
  let value = unwrapped(node);
  const path = [...keys];
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    if (isElementAccessExpression(value) && implicitArguments(value.expression)) {
      const index = argumentIndex(value.argumentExpression);
      const owner = argumentOwner(value);
      const parameter =
        owner === undefined || index === undefined ? undefined : positionalParameter(owner, index);
      return (
        owner !== undefined &&
        parameter !== undefined &&
        isIdentifier(parameter.name) &&
        framedDirectMemberReturn(node, owner) &&
        framedNativeErrorInput(parameter.name, value, undefined, false) &&
        error(parameter.name, path)
      );
    }
    if (isElementAccessExpression(value) && !framedQuietPrimitive(value.argumentExpression))
      return false;
    const key = frameMemberName(value);
    if (key === undefined) return false;
    path.unshift(key);
    value = unwrapped(value.expression);
  }
  return false;
}

/** An actual implicit arguments object belongs to the nearest non-arrow callable. */
function implicitArguments(expression: Expression): boolean {
  const value = unwrapped(expression);
  return (
    isIdentifier(value) && value.text === 'arguments' && frameDeclarationOf(value) === undefined
  );
}

/** Only canonical non-negative own argument indices have a fixed parameter position. */
function argumentIndex(expression: Expression): number | undefined {
  const value = framedQuietSource(expression, false);
  if (value === undefined || (!isNumericLiteral(value) && !isStringLiteral(value)))
    return undefined;
  const key = isNumericLiteral(value) ? String(Number(value.text)) : value.text;
  if (!/^(?:0|[1-9]\d*)$/u.test(key)) return undefined;
  const index = Number(key);
  return Number.isSafeInteger(index) ? index : undefined;
}

/** Default and destructuring evaluation, rest positions and non-callable class contexts stay opaque. */
function positionalParameter(owner: Answering, index: number): ParameterDeclaration | undefined {
  const parameters = owner.parameters.filter((parameter) => runtimeParameter(parameter));
  if (parameters.some((parameter) => opaqueParameter(parameter))) return undefined;
  const selected = parameters[index];
  return selected?.questionToken === undefined ? selected : undefined;
}

/** TypeScript's explicit this parameter consumes no runtime argument position. */
function runtimeParameter(parameter: ParameterDeclaration): boolean {
  return !isIdentifier(parameter.name) || parameter.name.text !== 'this';
}

/** Parameter initialization must add no application evaluation before the returned observation. */
function opaqueParameter(parameter: ParameterDeclaration): boolean {
  return (
    !isIdentifier(parameter.name) ||
    parameter.initializer !== undefined ||
    parameter.dotDotDotToken !== undefined
  );
}

/** Arrows inherit arguments; another non-arrow callable or class initializer changes its owner. */
function argumentOwner(node: Expression): Answering | undefined {
  for (let at = node.parent; !isSourceFile(at); at = at.parent) {
    if (isArrowFunction(at)) continue;
    if (isAnswering(at)) return at;
    if (
      isConstructorDeclaration(at) ||
      isSetAccessorDeclaration(at) ||
      isClassDeclaration(at) ||
      isClassExpression(at) ||
      isClassStaticBlockDeclaration(at) ||
      isPropertyDeclaration(at)
    )
      return undefined;
  }
  return undefined;
}
