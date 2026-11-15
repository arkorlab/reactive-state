import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  type MethodDeclaration,
  type ObjectLiteralExpression,
  type PropertyName,
  SyntaxKind,
} from 'typescript/ast';

import { answersLater } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedDirectMemberReturn } from './framed-direct-member-return.ts';
import { framedNativeErrorInput } from './framed-native-error-inputs.ts';
import {
  framedQuietData,
  framedQuietInputs,
  framedQuietPrimitive,
} from './framed-native-evaluation.ts';
import { framedObjectSources } from './framed-object-members.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedQuietTextPrefix } from './framed-text-prefix.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';

/** A literal's directly invoked synchronous method retains only a quiet returned this member path. */

const ERRORS = new Set([...STANDARD_ERRORS, 'AggregateError', 'DOMException']);

/** No saved receiver, extracted method, borrowed invocation or general this binding is inferred. */
export function framedObjectThisMember(
  node: Expression,
  keys: readonly string[],
  error: (value: Expression, path: readonly string[]) => boolean,
): boolean {
  let value = unwrapped(node);
  const path = [...keys];
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    if (isElementAccessExpression(value) && !framedQuietPrimitive(value.argumentExpression))
      return false;
    const key = frameMemberName(value);
    if (key === undefined) return false;
    path.unshift(key);
    value = unwrapped(value.expression);
  }
  if (value.kind !== SyntaxKind.ThisKeyword || path.length === 0) return false;
  const owner = executionOwner(value);
  if (
    !isMethodDeclaration(owner) ||
    !isObjectLiteralExpression(owner.parent) ||
    answersLater(owner) ||
    !framedDirectMemberReturn(node, owner)
  )
    return false;
  const call = literalMethodCall(owner, owner.parent);
  if (
    call === undefined ||
    !quietLiteralMethod(owner.parent, owner, call) ||
    !framedQuietTextPrefix(call, ERRORS)
  )
    return false;
  return (
    framedObjectSources(owner.parent, path)?.some((each) => {
      return (
        framedOriginCoowned(each.value, call) &&
        (framedNativeErrorInput(each.value, call) || quietFreshError(each.value)) &&
        error(each.value, each.keys)
      );
    }) === true
  );
}

/** The selected member call must use the fresh literal itself as the native method receiver. */
function literalMethodCall(
  method: MethodDeclaration,
  receiver: ObjectLiteralExpression,
): CallExpression | undefined {
  const { at, parent: member } = useOf(receiver);
  if (
    (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) ||
    member.expression !== at
  )
    return undefined;
  if (isElementAccessExpression(member) && !framedQuietPrimitive(member.argumentExpression))
    return undefined;
  const key = frameMemberName(member);
  if (key === undefined || literalName(method.name) !== key) return undefined;
  const used = useOf(member);
  return isCallExpression(used.parent) && used.parent.expression === used.at
    ? used.parent
    : undefined;
}

/** Literal fields and ignored arguments must add no application evaluation before the body read. */
function quietLiteralMethod(
  receiver: ObjectLiteralExpression,
  method: MethodDeclaration,
  call: CallExpression,
): boolean {
  if (
    method.parameters.some(
      (parameter) => !isIdentifier(parameter.name) || parameter.initializer !== undefined,
    ) ||
    !framedQuietInputs(call.arguments, ERRORS)
  )
    return false;
  let selected: ObjectLiteralExpression['properties'][number] | undefined;
  for (const property of receiver.properties) {
    if (isSpreadAssignment(property)) return false;
    const name = literalName(property.name);
    if (name === undefined || name === '__proto__') return false;
    if (name === literalName(method.name)) selected = property;
    if (!quietLiteralField(property)) return false;
  }
  return selected === method;
}

/** A method is created without execution; ordinary fields retain only quiet written inputs. */
function quietLiteralField(property: ObjectLiteralExpression['properties'][number]): boolean {
  if (isMethodDeclaration(property)) return true;
  if (isPropertyAssignment(property)) return framedQuietInputs([property.initializer], ERRORS);
  return (
    isShorthandPropertyAssignment(property) &&
    isIdentifier(property.name) &&
    property.objectAssignmentInitializer === undefined
  );
}

/** Written literal names cannot execute a computed key or hide another possible selected member. */
function literalName(name: PropertyName | undefined): string | undefined {
  if (name === undefined) return undefined;
  const value = isComputedPropertyName(name) ? unwrapped(name.expression) : name;
  if (!isComputedPropertyName(name) && isIdentifier(value)) return value.text;
  if (isNumericLiteral(value)) return String(Number(value.text));
  return isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value) ? value.text : undefined;
}

/** A fresh native construction with literal data arguments cannot have a prior own Error member write. */
function quietFreshError(node: Expression): boolean {
  const value = unwrapped(node);
  return (
    isNewExpression(value) &&
    framedNativeConstructor(value.expression, ERRORS) &&
    (value.arguments ?? []).every((argument) => framedQuietData(argument))
  );
}
