import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isComputedPropertyName,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isSpreadElement,
  isStringLiteral,
  type ObjectLiteralExpression,
  type PropertyName,
  SyntaxKind,
} from 'typescript/ast';

import { framedKeyNames } from './framed-keys.ts';
import {
  framedQuietData,
  framedQuietInputs,
  framedQuietPrimitive,
  framedQuietSource,
} from './framed-native-evaluation.ts';
import { framedObjectData } from './framed-object-data.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedQuietTextPrefix } from './framed-text-prefix.ts';

/** Native clones observe ordinary own data rather than an Object.create result's Error prototype. */

const CLONE: ReadonlySet<string> = new Set(['structuredClone']);
const CREATE: ReadonlySet<string> = new Set(['Object.create']);
const UNDEFINED: ReadonlySet<string> = new Set(['undefined']);

/** A selected cloned member keeps only quiet unchanged ordinary own data at the actual read. */
export function framedClonedObjectData(
  node: Expression,
  members: readonly string[] | undefined,
  errors: ReadonlySet<string>,
): boolean {
  if (members === undefined || members.length === 0) return false;
  const clone = framedQuietSource(node);
  if (
    clone === undefined ||
    !isCallExpression(clone) ||
    !framedNativeConstructor(clone.expression, CLONE)
  )
    return false;
  const [first, ...remaining] = clone.arguments;
  if (
    first === undefined ||
    isSpreadElement(first) ||
    remaining.some((argument) => !framedQuietData(argument)) ||
    !framedOriginCoowned(clone, node)
  )
    return false;
  const created = framedQuietSource(first);
  if (
    created === undefined ||
    !isCallExpression(created) ||
    !framedNativeConstructor(created.expression, CREATE)
  )
    return false;
  return (
    quietCreation(created, errors) &&
    clonedMembersData(created, members, errors) &&
    framedQuietTextPrefix(node, errors, (call) => call === created || call === clone)
  );
}

/** Every original creation operand evaluates before native cloning can discard the prototype. */
function quietCreation(node: CallExpression, errors: ReadonlySet<string>): boolean {
  return (
    node.arguments.length > 0 &&
    node.arguments.every((argument) => !isSpreadElement(argument)) &&
    framedQuietInputs(node.arguments, errors)
  );
}

/** Omitted own descriptors and closed hidden fields copy no inherited or hidden member. */
function clonedMembersData(
  created: CallExpression,
  members: readonly string[],
  errors: ReadonlySet<string>,
): boolean {
  const descriptors = created.arguments[1];
  if (descriptors === undefined || framedNativeConstructor(descriptors, UNDEFINED)) return true;
  const value = framedQuietSource(descriptors);
  if (value === undefined || !isObjectLiteralExpression(value) || !closedDescriptorValues(value))
    return false;
  return onlyHiddenFields(value) || framedObjectData(created, members, errors);
}

/** Every potentially copied field has primitive data; opaque descriptors and getter work stay opaque. */
function closedDescriptorValues(node: ObjectLiteralExpression): boolean {
  return node.properties.every((property) => {
    if (!isPropertyAssignment(property)) return false;
    const descriptor = framedQuietSource(property.initializer);
    return (
      descriptor !== undefined &&
      isObjectLiteralExpression(descriptor) &&
      copiedValueData(descriptor)
    );
  });
}

/** Hidden data is not read; each other own value must perform no recursive application cloning. */
function copiedValueData(node: ObjectLiteralExpression): boolean {
  let hidden = true;
  let value: Expression | undefined;
  for (const field of node.properties) {
    if (!isPropertyAssignment(field)) return false;
    const name = descriptorName(field.name);
    if (name === undefined || ['get', 'set'].includes(name)) return false;
    if (name === 'enumerable')
      hidden = framedQuietSource(field.initializer)?.kind === SyntaxKind.FalseKeyword;
    else if (name === 'value') value = field.initializer;
  }
  return hidden || value === undefined || framedQuietPrimitive(value);
}

/** Source-written descriptor flags absent or literally false make every own property hidden. */
function onlyHiddenFields(node: ObjectLiteralExpression): boolean {
  return node.properties.every((property) => {
    if (!isPropertyAssignment(property)) return false;
    const descriptor = framedQuietSource(property.initializer);
    if (descriptor === undefined || !isObjectLiteralExpression(descriptor)) return false;
    return descriptor.properties.every((field) => {
      if (!isPropertyAssignment(field)) return false;
      const name = descriptorName(field.name);
      if (name === undefined || ['get', 'set'].includes(name)) return false;
      if (name !== 'enumerable') return true;
      return framedQuietSource(field.initializer)?.kind === SyntaxKind.FalseKeyword;
    });
  });
}

/** A written descriptor flag uses its literal or unchanged computed primitive name. */
function descriptorName(name: PropertyName): string | undefined {
  if (
    isIdentifier(name) ||
    isStringLiteral(name) ||
    isNoSubstitutionTemplateLiteral(name) ||
    isNumericLiteral(name)
  )
    return name.text;
  if (!isComputedPropertyName(name)) return undefined;
  const keys = framedKeyNames(name.expression);
  return keys?.length === 1 ? keys[0] : undefined;
}
