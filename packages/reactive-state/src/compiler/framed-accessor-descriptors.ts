import {
  type ArrowFunction,
  type Expression,
  type FunctionExpression,
  isArrayLiteralExpression,
  isArrowFunction,
  isBlock,
  isComputedPropertyName,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  type MethodDeclaration,
  type ObjectLiteralExpression,
  type PropertyName,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { framedQuietPrimitive } from './framed-native-evaluation.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';

/** Native descriptor fields preserve omission separately from an explicit undefined getter. */
export interface AccessorDescriptor {
  readonly kind: 'accessor' | 'data' | 'generic';
  readonly hasGet: boolean;
  readonly getter: Expression | undefined;
  readonly hasSet: boolean;
  readonly setter: boolean;
  readonly hasValue: boolean;
  readonly value: Expression | undefined;
  readonly writable: boolean | undefined;
  readonly configurable: boolean | undefined;
}

type Callable = ArrowFunction | FunctionExpression | MethodDeclaration;
type Fields = ReadonlyMap<string, Expression | Callable>;

/** All descriptor reads are plain own data; conversion cannot execute a descriptor getter. */
export function framedAccessorDescriptor(node: Expression): AccessorDescriptor | undefined {
  const literal = unwrapped(node);
  if (!isObjectLiteralExpression(literal)) return undefined;
  const fields = descriptorFields(literal);
  if (fields === undefined) return undefined;
  const dataValue = fields.get('value');
  if (dataValue !== undefined && isMethodDeclaration(dataValue)) return undefined;
  const accessor = fields.has('get') || fields.has('set');
  const data = fields.has('value') || fields.has('writable');
  if (accessor && data) return undefined;
  const callables = callableFields(fields);
  const writable = booleanField(fields, 'writable');
  const configurable = booleanField(fields, 'configurable');
  const enumerable = booleanField(fields, 'enumerable');
  if (
    callables === undefined ||
    writable === undefined ||
    configurable === undefined ||
    enumerable === undefined
  )
    return undefined;
  let kind: AccessorDescriptor['kind'] = 'generic';
  if (accessor) kind = 'accessor';
  else if (data) kind = 'data';
  return {
    kind,
    ...callables,
    hasValue: fields.has('value'),
    value: dataValue,
    writable: writable.value,
    configurable: configurable.value,
  };
}

/** Undefined and omission are distinct from a direct getter and an empty setter. */
function callableFields(
  fields: Fields,
): Pick<AccessorDescriptor, 'hasGet' | 'getter' | 'hasSet' | 'setter'> | undefined {
  const get = fields.get('get');
  const set = fields.get('set');
  const writesGetter = get !== undefined && !sourceUndefined(get);
  const getter = writesGetter ? directGetter(get) : undefined;
  if (getter === undefined && writesGetter) return undefined;
  const writesSetter = set !== undefined && !sourceUndefined(set);
  if (writesSetter && !emptySetter(set)) return undefined;
  return { hasGet: fields.has('get'), getter, hasSet: fields.has('set'), setter: writesSetter };
}

/** Written descriptor methods are function values, while accessor syntax would run on conversion. */
function descriptorFields(
  literal: ObjectLiteralExpression,
): Map<string, Expression | Callable> | undefined {
  const fields = new Map<string, Expression | Callable>();
  for (const field of literal.properties) {
    if (isSpreadAssignment(field)) return undefined;
    const key = framedAccessorName(field.name);
    if (key === undefined || key === '__proto__') return undefined;
    if (isMethodDeclaration(field)) fields.set(key, field);
    else if (isPropertyAssignment(field) && framedAccessorQuietValue(field.initializer))
      fields.set(key, field.initializer);
    else if (
      isShorthandPropertyAssignment(field) &&
      isIdentifier(field.name) &&
      framedAccessorQuietValue(field.name)
    )
      fields.set(key, field.name);
    else return undefined;
  }
  return fields;
}

/** Primitive written keys cannot call a supplied key conversion. */
export function framedAccessorName(name: PropertyName | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (isComputedPropertyName(name) && !framedQuietPrimitive(name.expression)) return undefined;
  return writtenArrayKey(name);
}

/** Shorthand names require the AST's identifier guard before they are used as expressions. */
export function framedAccessorFieldValue(
  field: ObjectLiteralExpression['properties'][number],
): Expression | undefined {
  if (isPropertyAssignment(field)) return field.initializer;
  return isShorthandPropertyAssignment(field) && isIdentifier(field.name) ? field.name : undefined;
}

/** Literal creation and lexical binding reads do not invoke application code. */
export function framedAccessorQuietValue(node: Expression): boolean {
  const value = unwrapped(node);
  if (framedQuietPrimitive(value)) return true;
  if (isIdentifier(value)) return frameBindingOf(value)?.keys.length === 0;
  if (isArrowFunction(value) || isFunctionExpression(value)) return true;
  if (isArrayLiteralExpression(value))
    return value.elements.every((element) => framedAccessorQuietValue(element));
  if (isObjectLiteralExpression(value)) {
    return value.properties.every((field) => {
      if (isSpreadAssignment(field)) return false;
      const name = framedAccessorName(field.name);
      if (name === undefined || name === '__proto__') return false;
      if (isPropertyAssignment(field)) return framedAccessorQuietValue(field.initializer);
      return (
        isShorthandPropertyAssignment(field) &&
        isIdentifier(field.name) &&
        framedAccessorQuietValue(field.name)
      );
    });
  }
  return (
    isNewExpression(value) &&
    framedNativeConstructor(value.expression, STANDARD_ERRORS) &&
    (value.arguments ?? []).every(framedQuietPrimitive)
  );
}

/** A direct return has no callback, default parameter, suspension or preceding application work. */
function directGetter(node: Expression | Callable): Expression | undefined {
  const value = callable(node);
  if (value === undefined || value.parameters.length > 0) return undefined;
  const body = value.body;
  if (body === undefined) return undefined;
  if (!isBlock(body)) return framedAccessorQuietValue(body) ? body : undefined;
  const first = body.statements[0];
  return first !== undefined &&
    body.statements.length === 1 &&
    isReturnStatement(first) &&
    first.expression !== undefined &&
    framedAccessorQuietValue(first.expression)
    ? first.expression
    : undefined;
}

/** Only an empty setter proves that an assignment leaves the existing getter result unchanged. */
function emptySetter(node: Expression | Callable): boolean {
  const value = callable(node);
  return (
    value !== undefined &&
    value.parameters.every((parameter) => {
      return (
        isIdentifier(parameter.name) &&
        parameter.initializer === undefined &&
        parameter.dotDotDotToken === undefined
      );
    }) &&
    value.body !== undefined &&
    isBlock(value.body) &&
    value.body.statements.length === 0
  );
}

/** Native descriptor callables run synchronously; a method name itself is never a returned value. */
function callable(node: Expression | Callable): Callable | undefined {
  const value = isMethodDeclaration(node) ? node : unwrapped(node);
  return (isMethodDeclaration(value) || isArrowFunction(value) || isFunctionExpression(value)) &&
    (isArrowFunction(value) || value.asteriskToken === undefined) &&
    value.modifiers?.some((modifier) => modifier.kind === SyntaxKind.AsyncKeyword) !== true
    ? value
    : undefined;
}

/** Only the actual unshadowed undefined clears a descriptor field in this added proof. */
function sourceUndefined(node: Expression | Callable): boolean {
  if (isMethodDeclaration(node)) return false;
  const value = unwrapped(node);
  return (
    framedQuietPrimitive(value) &&
    isIdentifier(value) &&
    value.text === 'undefined' &&
    frameBindingOf(value) === undefined
  );
}

/** Omitted attributes remain omitted; written booleans and undefined have known native truthiness. */
function booleanField(
  fields: Fields,
  name: string,
): { readonly value: boolean | undefined } | undefined {
  const value = fields.get(name);
  if (value === undefined) return { value: undefined };
  if (sourceUndefined(value)) return { value: false };
  if (isMethodDeclaration(value)) return undefined;
  const source = unwrapped(value);
  if (source.kind === SyntaxKind.TrueKeyword) return { value: true };
  return source.kind === SyntaxKind.FalseKeyword ? { value: false } : undefined;
}
