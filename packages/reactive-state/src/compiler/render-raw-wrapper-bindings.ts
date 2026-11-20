import {
  type ArrowFunction,
  type Expression,
  type FunctionDeclaration,
  type FunctionExpression,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isArrowFunction,
  isIdentifier,
  isObjectBindingPattern,
  isOmittedExpression,
  isSpreadElement,
  type MethodDeclaration,
  type Node,
  type ParameterDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { framedQuietPrimitive } from './framed-native-evaluation.ts';
import type { BoundArgCount, TagParameterEnv } from './render-raw-tag-calls.ts';
import { bindingIdentifiers } from './scope.ts';

/** Parameter-position and implicit-arguments bindings for template tag and helper functions. */

export type WrapperFunction =
  | ArrowFunction
  | FunctionDeclaration
  | FunctionExpression
  | MethodDeclaration;

export interface WrapperBindings {
  readonly paramOffset: number;
  readonly wildcardSubs: boolean;
  readonly wholeRestParam: ParameterDeclaration | undefined;
  readonly templateParam: ParameterDeclaration | undefined;
  readonly rawParam:
    | { readonly param: ParameterDeclaration; readonly localName: string }
    | undefined;
  readonly restSubs:
    | { readonly param: ParameterDeclaration; readonly startIndex: number }
    | undefined;
  readonly positionalSubs: ReadonlyMap<Node, number>;
  readonly hasImplicitArguments: boolean;
}

export interface RawWrapperSearch {
  readonly datedIndices: ReadonlySet<number>;
  readonly spanCount: number;
  readonly seenWrappers: ReadonlySet<string>;
  readonly env?: TagParameterEnv | undefined;
  readonly paramOffset?: number | undefined;
  readonly boundArgs?: BoundArgCount | undefined;
  readonly maxTemplateSubs?: number | undefined;
  readonly outerConsumedAsText?: boolean | undefined;
}

export type MaySelectRawTag = (tag: Expression, search: RawWrapperSearch) => boolean;

export interface RawWrapperQuery extends RawWrapperSearch {
  readonly maySelectTag: MaySelectRawTag;
}

export interface ForwardedSlotsResult {
  readonly forwardedSlots: ReadonlySet<number>;
  readonly effectiveSpanCount: number;
}

export function isIdentifierForParam(
  value: Expression,
  expected: ParameterDeclaration | undefined,
): boolean {
  if (expected === undefined || !isIdentifier(value) || !isIdentifier(expected.name)) return false;
  const declared = frameDeclarationOf(value);
  return declared !== undefined && declared === expected && value.text === expected.name.text;
}

export function collectWrapperBindings(
  fn: WrapperFunction,
  baseParamOffset = 1,
  boundArgs?: BoundArgCount,
): WrapperBindings {
  const parameters = runtimeWrapperParameters(fn.parameters);
  if (boundArgs === 'unknown') {
    return collectWildcardBindings(fn, parameters, baseParamOffset);
  }
  const paramOffset = baseParamOffset + (boundArgs ?? 0);
  const firstInfo = classifyLeadingParameters(parameters, paramOffset);
  const { positionalSubs, restSubs } = classifyRemainingParameters(parameters, paramOffset);
  return {
    hasImplicitArguments: !isArrowFunction(fn) && !declaresArguments(fn),
    paramOffset,
    positionalSubs,
    rawParam: firstInfo.rawParam,
    restSubs: firstInfo.earlyRestSubs ?? restSubs,
    templateParam: firstInfo.templateParam,
    wholeRestParam: firstInfo.wholeRestParam,
    wildcardSubs: false,
  };
}

function runtimeWrapperParameters(
  parameters: readonly ParameterDeclaration[],
): readonly ParameterDeclaration[] {
  return parameters.filter((each) => !isIdentifier(each.name) || each.name.text !== 'this');
}

function collectWildcardBindings(
  fn: WrapperFunction,
  parameters: readonly ParameterDeclaration[],
  paramOffset: number,
): WrapperBindings {
  const positionalSubs = new Map<Node, number>();
  let restSubs: { readonly param: ParameterDeclaration; readonly startIndex: number } | undefined;
  for (const param of parameters) {
    if (param.dotDotDotToken !== undefined) {
      restSubs = { param, startIndex: 0 };
      break;
    }
    positionalSubs.set(param, 0);
  }
  return {
    hasImplicitArguments: !isArrowFunction(fn) && !declaresArguments(fn),
    paramOffset,
    positionalSubs,
    rawParam: undefined,
    restSubs,
    templateParam: undefined,
    wholeRestParam: undefined,
    wildcardSubs: true,
  };
}

function classifyLeadingParameters(
  parameters: readonly ParameterDeclaration[],
  paramOffset: number,
): Pick<WrapperBindings, 'wholeRestParam' | 'templateParam' | 'rawParam'> & {
  readonly earlyRestSubs?: { readonly param: ParameterDeclaration; readonly startIndex: number };
} {
  if (paramOffset <= 0) {
    return { rawParam: undefined, templateParam: undefined, wholeRestParam: undefined };
  }
  for (let index = 0; index < paramOffset - 1; index += 1) {
    const prior = parameters[index];
    if (prior?.dotDotDotToken !== undefined) {
      return {
        earlyRestSubs: { param: prior, startIndex: 0 },
        rawParam: undefined,
        templateParam: undefined,
        wholeRestParam: isIdentifier(prior.name) ? prior : undefined,
      };
    }
  }
  return classifyTemplateParameter(parameters[paramOffset - 1]);
}

function classifyTemplateParameter(
  firstParam: ParameterDeclaration | undefined,
): Pick<WrapperBindings, 'wholeRestParam' | 'templateParam' | 'rawParam'> {
  if (firstParam === undefined) {
    return { rawParam: undefined, templateParam: undefined, wholeRestParam: undefined };
  }
  if (firstParam.dotDotDotToken !== undefined) {
    return {
      rawParam: undefined,
      templateParam: undefined,
      wholeRestParam:
        isIdentifier(firstParam.name) || isArrayBindingPattern(firstParam.name)
          ? firstParam
          : undefined,
    };
  }
  if (isIdentifier(firstParam.name)) {
    return { rawParam: undefined, templateParam: firstParam, wholeRestParam: undefined };
  }
  const localName = findRawBindingLocalName(firstParam);
  return {
    rawParam: localName === undefined ? undefined : { localName, param: firstParam },
    templateParam: undefined,
    wholeRestParam: undefined,
  };
}

function classifyRemainingParameters(
  parameters: readonly ParameterDeclaration[],
  paramOffset: number,
): Pick<WrapperBindings, 'positionalSubs' | 'restSubs'> {
  const positionalSubs = new Map<Node, number>();
  let restSubs: { readonly param: ParameterDeclaration; readonly startIndex: number } | undefined;
  for (let index = paramOffset; index < parameters.length; index += 1) {
    const param = parameters[index];
    if (param === undefined) continue;
    if (param.dotDotDotToken !== undefined) {
      if (isIdentifier(param.name) || isArrayBindingPattern(param.name)) {
        restSubs = { param, startIndex: index - paramOffset };
      }
      break;
    }
    if (isIdentifier(param.name)) positionalSubs.set(param, index - paramOffset);
  }
  return { positionalSubs, restSubs };
}

export function findRawBindingLocalName(param: ParameterDeclaration): string | undefined {
  if (!isObjectBindingPattern(param.name)) return undefined;
  for (const element of param.name.elements) {
    if (
      element.dotDotDotToken !== undefined ||
      element.name === undefined ||
      !isIdentifier(element.name)
    )
      continue;
    if (element.propertyName === undefined && element.name.text === 'raw') {
      return element.name.text;
    }
    if (
      element.propertyName !== undefined &&
      isIdentifier(element.propertyName) &&
      element.propertyName.text === 'raw'
    ) {
      return element.name.text;
    }
  }
  return undefined;
}

function declaresArguments(fn: WrapperFunction): boolean {
  return fn.parameters.some((param) =>
    bindingIdentifiers(param.name).some((id) => id.text === 'arguments'),
  );
}

export function hasDatedFromIndex(datedIndices: ReadonlySet<number>, startIndex: number): boolean {
  for (const index of datedIndices) {
    if (index >= startIndex) return true;
  }
  return false;
}

export function rangeHasDated(
  datedIndices: ReadonlySet<number>,
  minInclusive: number,
  maxExclusive: number | undefined,
): boolean {
  for (const index of datedIndices) {
    if (index >= minInclusive && (maxExclusive === undefined || index < maxExclusive)) return true;
  }
  return false;
}

export function isWholeArgumentsReference(value: Expression, bindings: WrapperBindings): boolean {
  if (isIdentifierForParam(value, bindings.wholeRestParam)) return true;
  return (
    bindings.hasImplicitArguments &&
    isIdentifier(value) &&
    value.text === 'arguments' &&
    frameDeclarationOf(value) === undefined
  );
}

export function directPositionalParamIndex(
  expr: Expression,
  bindings: WrapperBindings,
): number | undefined {
  if (!isIdentifier(expr)) return undefined;
  const declared = frameDeclarationOf(expr);
  return declared === undefined ? undefined : bindings.positionalSubs.get(declared);
}

export function quietWrapperParameters(fn: WrapperFunction, paramOffset: number): boolean {
  for (const [index, param] of fn.parameters.entries()) {
    if (param.initializer !== undefined) return false;
    if (isIdentifier(param.name)) continue;
    if (
      paramOffset === 1 &&
      index === 0 &&
      param.dotDotDotToken === undefined &&
      isQuietRawPattern(param)
    ) {
      continue;
    }
    return false;
  }
  return true;
}

function isQuietRawPattern(param: ParameterDeclaration): boolean {
  if (!isObjectBindingPattern(param.name) || param.name.elements.length !== 1) return false;
  const [element] = param.name.elements;
  return (
    element !== undefined &&
    element.initializer === undefined &&
    findRawBindingLocalName(param) !== undefined
  );
}

export function isQuietDatedPositional(
  expr: Expression,
  bindings: WrapperBindings,
  datedIndices: ReadonlySet<number>,
): boolean {
  const paramIndex = directPositionalParamIndex(expr, bindings);
  return paramIndex !== undefined && datedIndices.has(paramIndex);
}

export function isQuietDatedArrayCarrier(
  expr: Expression,
  bindings: WrapperBindings,
  datedIndices: ReadonlySet<number>,
): boolean {
  if (
    bindings.restSubs !== undefined &&
    isIdentifierForParam(expr, bindings.restSubs.param) &&
    hasDatedFromIndex(datedIndices, bindings.restSubs.startIndex)
  ) {
    return true;
  }
  if (!isArrayLiteralExpression(expr)) return false;
  let foundDated = false;
  for (const element of expr.elements) {
    if (isOmittedExpression(element)) continue;
    if (isSpreadElement(element)) return false;
    if (isQuietDatedCarrier(unwrapped(element), bindings, datedIndices)) {
      foundDated = true;
      continue;
    }
    if (!isQuietOperand(element, bindings)) return false;
  }
  return foundDated;
}

export function isQuietDatedCarrier(
  expr: Expression,
  bindings: WrapperBindings,
  datedIndices: ReadonlySet<number>,
): boolean {
  return (
    isQuietDatedPositional(expr, bindings, datedIndices) ||
    isQuietDatedArrayCarrier(expr, bindings, datedIndices)
  );
}

export function isQuietOperand(expr: Expression, bindings: WrapperBindings): boolean {
  return (
    !isSpreadElement(expr) &&
    (framedQuietPrimitive(expr) ||
      directPositionalParamIndex(unwrapped(expr), bindings) !== undefined)
  );
}
