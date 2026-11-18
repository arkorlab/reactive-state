import {
  type ArrowFunction,
  type Expression,
  type FunctionDeclaration,
  type FunctionExpression,
  isArrowFunction,
  isIdentifier,
  isObjectBindingPattern,
  type MethodDeclaration,
  type Node,
  type ParameterDeclaration,
} from 'typescript/ast';

import { frameDeclarationOf } from './framed-bindings.ts';
import { bindingIdentifiers } from './scope.ts';

/** Parameter-position and implicit-arguments bindings for template tag wrapper functions. */

export type WrapperFunction =
  | ArrowFunction
  | FunctionDeclaration
  | FunctionExpression
  | MethodDeclaration;

export interface WrapperBindings {
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

export function isIdentifierForParam(
  value: Expression,
  expected: ParameterDeclaration | undefined,
): boolean {
  if (expected === undefined || !isIdentifier(value)) return false;
  const declared = frameDeclarationOf(value);
  return declared !== undefined && declared === expected;
}

export function collectWrapperBindings(fn: WrapperFunction): WrapperBindings {
  const firstInfo = classifyFirstParameter(fn.parameters[0]);
  const { positionalSubs, restSubs } = classifyRemainingParameters(fn.parameters);
  return {
    hasImplicitArguments: !isArrowFunction(fn) && !declaresArguments(fn),
    positionalSubs,
    rawParam: firstInfo.rawParam,
    restSubs,
    templateParam: firstInfo.templateParam,
    wholeRestParam: firstInfo.wholeRestParam,
  };
}

function classifyFirstParameter(
  firstParam: ParameterDeclaration | undefined,
): Pick<WrapperBindings, 'wholeRestParam' | 'templateParam' | 'rawParam'> {
  if (firstParam === undefined) {
    return { rawParam: undefined, templateParam: undefined, wholeRestParam: undefined };
  }
  if (firstParam.dotDotDotToken !== undefined) {
    return {
      rawParam: undefined,
      templateParam: undefined,
      wholeRestParam: isIdentifier(firstParam.name) ? firstParam : undefined,
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
): Pick<WrapperBindings, 'positionalSubs' | 'restSubs'> {
  const positionalSubs = new Map<Node, number>();
  let restSubs: { readonly param: ParameterDeclaration; readonly startIndex: number } | undefined;
  for (let index = 1; index < parameters.length; index += 1) {
    const param = parameters[index];
    if (param === undefined) continue;
    if (param.dotDotDotToken !== undefined) {
      if (isIdentifier(param.name)) restSubs = { param, startIndex: index - 1 };
      break;
    }
    if (isIdentifier(param.name)) positionalSubs.set(param, index - 1);
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
