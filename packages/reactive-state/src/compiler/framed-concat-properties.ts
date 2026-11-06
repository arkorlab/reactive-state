import {
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isComputedPropertyName,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPrefixUnaryExpression,
  isPropertyAssignment,
  isRegularExpressionLiteral,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isSourceFile,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVoidExpression,
  type Node,
  type ObjectLiteralExpression,
  type PropertyName,
  type SpreadAssignment,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameBindingOf, frameTypeOf, type FrameBinding } from './framed-bindings.ts';
import { framedObjectSources } from './framed-object-members.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** Written concat array-like fields retain their original nodes and native symbol identity. */

const SPREADABLE = new Set(['Symbol.isConcatSpreadable']);
const UNDEFINED = new Set(['undefined']);
const PRIMITIVE_LENGTHS = new Set([
  SyntaxKind.BooleanKeyword,
  SyntaxKind.NumberKeyword,
  SyntaxKind.StringKeyword,
]);
const NATIVE_SYMBOLS = new Set([
  'Symbol.asyncDispose',
  'Symbol.asyncIterator',
  'Symbol.dispose',
  'Symbol.hasInstance',
  'Symbol.isConcatSpreadable',
  'Symbol.iterator',
  'Symbol.match',
  'Symbol.matchAll',
  'Symbol.replace',
  'Symbol.search',
  'Symbol.species',
  'Symbol.split',
  'Symbol.toPrimitive',
  'Symbol.toStringTag',
  'Symbol.unscopables',
]);

export type ConcatStable = (value: Expression) => boolean;

type ConcatField = Exclude<ObjectLiteralExpression['properties'][number], SpreadAssignment>;

/** Quiet argument creation cannot rewrite an earlier source before native concat starts reading it. */
export function concatQuietArguments(values: readonly Expression[], stable: ConcatStable): boolean {
  const pending = [...values];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const children = quietArgumentsOf(unwrapped(next), stable);
    if (children === undefined) return false;
    pending.push(...children);
  }
  return true;
}

/** Literal construction visits only evaluated data expressions and known computed primitive keys. */
function quietArgumentsOf(
  value: Expression,
  stable: ConcatStable,
): readonly Expression[] | undefined {
  if (quietValue(value)) return [];
  if (isVoidExpression(value)) return [value.expression];
  if (isArrayLiteralExpression(value)) {
    const elements: Expression[] = [];
    for (const element of value.elements) {
      if (isOmittedExpression(element)) continue;
      if (isSpreadElement(element)) return undefined;
      elements.push(element);
    }
    return elements;
  }
  return isObjectLiteralExpression(value) ? quietObjectValues(value, stable) : undefined;
}

/** A literal object's ordinary data creation invokes neither accessors nor application conversions. */
function quietObjectValues(
  value: ObjectLiteralExpression,
  stable: ConcatStable,
): readonly Expression[] | undefined {
  const values: Expression[] = [];
  for (const field of value.properties) {
    if (isSpreadAssignment(field)) return undefined;
    if (
      isComputedPropertyName(field.name) &&
      !concatSymbol(field.name) &&
      concatKey(field.name, stable) === undefined
    )
      return undefined;
    const data = concatData(field);
    if (data !== undefined) values.push(data);
  }
  return values;
}

/** A direct primitive or binding read performs no application call, property get or iterator step. */
function quietValue(value: Expression): boolean {
  return (
    isIdentifier(value) ||
    isNumericLiteral(value) ||
    isStringLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value) ||
    value.kind === SyntaxKind.FalseKeyword ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.NullKeyword ||
    literalNumber(value) !== undefined
  );
}

/** Whole constant aliases keep only initializers whose earlier uses preserve the source proof. */
export function concatSource(expression: Expression, stable: ConcatStable): Expression | undefined {
  let value = unwrapped(expression);
  const seen = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0 || seen.has(selected.binding))
      return undefined;
    const { binding } = selected;
    if (
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return undefined;
    seen.add(binding);
    value = unwrapped(binding.initializer);
  }
  return stable(expression) ? value : undefined;
}

/** The ordered literal fields of an array-like receiver, including quiet whole literal spreads. */
export function concatFields(
  root: ObjectLiteralExpression,
  stable: ConcatStable,
): readonly (ConcatField | undefined)[] {
  const fields: (ConcatField | undefined)[] = [];
  const pending = root.properties.toReversed().map((property) => {
    return {
      property,
      seen: new Set<Expression>([root]),
    };
  });
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (!isSpreadAssignment(at.property)) {
      fields.push(at.property);
      continue;
    }
    const value = concatSource(at.property.expression, stable);
    if (value === undefined || !isObjectLiteralExpression(value) || at.seen.has(value)) {
      fields.push(undefined);
      continue;
    }
    const seen = new Set(at.seen).add(value);
    pending.push(...value.properties.toReversed().map((property) => ({ property, seen })));
  }
  return fields;
}

/** Only quiet source creation and native-read getters preserve a carried slot before copying. */
export function concatQuietSource(root: ObjectLiteralExpression, stable: ConcatStable): boolean {
  for (const field of concatFields(root, stable)) {
    if (field === undefined || !quietField(field, root, stable)) return false;
  }
  return true;
}

/** Source data creation and getters invoked by native concat or literal spread stay bounded. */
function quietField(
  field: ConcatField,
  root: ObjectLiteralExpression,
  stable: ConcatStable,
): boolean {
  const key = concatKey(field.name, stable);
  if (key === undefined && isComputedPropertyName(field.name) && !concatSymbol(field.name))
    return false;
  const data = concatData(field);
  if (data === undefined && concatSpreadSymbol(field.name) && !isGetAccessorDeclaration(field))
    return false;
  if (data !== undefined && !concatQuietArguments([data], stable)) return false;
  if (
    isGetAccessorDeclaration(field) &&
    (field.parent !== root || nativeGetter(field.name, key)) &&
    concatGetterData(field, stable) === undefined
  )
    return false;
  return key !== 'length' || quietLength(concatMetadata(field, stable), stable);
}

/** Native concat reads only its hook, length and canonical numeric own slots on this literal. */
function nativeGetter(name: PropertyName | undefined, key: string | undefined): boolean {
  if (key === 'length' || concatSpreadSymbol(name)) return true;
  if (key === undefined) return false;
  const number = Number(key);
  return Number.isSafeInteger(number) && number >= 0 && String(number) === key;
}

/** Primitive length contracts cannot run an application's conversion while native concat copies. */
function quietLength(value: Expression | undefined, stable: ConcatStable): boolean {
  if (value === undefined) return false;
  if (concatLength(value, stable) !== undefined) return true;
  const selected = frameTypeOf(value);
  if (selected === undefined || selected.keys.length > 0) return false;
  return PRIMITIVE_LENGTHS.has(selected.type.kind);
}

/** A getter supplies only a single quiet synchronous return, preserving the old opaque boundary. */
function concatGetterData(field: ConcatField, stable: ConcatStable): Expression | undefined {
  if (!isGetAccessorDeclaration(field) || field.body?.statements.length !== 1) return undefined;
  const statement = field.body.statements[0];
  if (
    statement === undefined ||
    !isReturnStatement(statement) ||
    statement.expression === undefined
  )
    return undefined;
  return concatQuietArguments([statement.expression], stable) ? statement.expression : undefined;
}

/** Quiet getter metadata and literal data retain their original source expression. */
export function concatMetadata(field: ConcatField, stable: ConcatStable): Expression | undefined {
  return concatData(field) ?? concatGetterData(field, stable);
}

/** A native concat symbol is a symbol key, never an unresolved numeric or string member key. */
export function concatSymbol(name: PropertyName | undefined): boolean {
  return (
    name !== undefined &&
    isComputedPropertyName(name) &&
    framedNativeConstructor(name.expression, NATIVE_SYMBOLS)
  );
}

/** Only the source-known native spreadability symbol supplies this native hook. */
export function concatSpreadSymbol(name: PropertyName | undefined): boolean {
  return (
    name !== undefined &&
    isComputedPropertyName(name) &&
    framedNativeConstructor(name.expression, SPREADABLE)
  );
}

/** Syntax-guaranteed primitive property names exclude native symbols and unresolved conversions. */
export function concatKey(
  name: PropertyName | undefined,
  stable: ConcatStable,
): string | undefined {
  if (name === undefined) return undefined;
  if (isIdentifier(name) || isStringLiteral(name) || isNoSubstitutionTemplateLiteral(name))
    return name.text;
  if (isNumericLiteral(name)) return String(Number(name.text.replaceAll('_', '')));
  const value = isComputedPropertyName(name) ? concatSource(name.expression, stable) : undefined;
  if (value === undefined) return undefined;
  if (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value)) return value.text;
  const number = literalNumber(value);
  return number === undefined ? undefined : String(number);
}

/** Literal primitive conversions determine a native length without executing application methods. */
export function concatLength(
  value: Expression | undefined,
  stable: ConcatStable,
): number | undefined {
  if (value !== undefined && framedNativeConstructor(value, UNDEFINED)) return 0;
  const source = value === undefined ? undefined : concatSource(value, stable);
  if (source === undefined) return undefined;
  if (isVoidExpression(source) && concatQuietArguments([source.expression], stable)) return 0;
  let number = literalNumber(source);
  if (isStringLiteral(source) || isNoSubstitutionTemplateLiteral(source))
    number = Number(source.text);
  if (source.kind === SyntaxKind.NullKeyword || source.kind === SyntaxKind.FalseKeyword) number = 0;
  if (source.kind === SyntaxKind.TrueKeyword) number = 1;
  if (number === undefined) return undefined;
  if (Number.isNaN(number) || number <= 0) return 0;
  return Math.min(Math.trunc(number), Number.MAX_SAFE_INTEGER);
}

/** A primitive numeric literal and its direct sign cannot invoke an application conversion. */
function literalNumber(value: Expression): number | undefined {
  if (isNumericLiteral(value)) return Number(value.text.replaceAll('_', ''));
  if (!isPrefixUnaryExpression(value) || !isNumericLiteral(unwrapped(value.operand)))
    return undefined;
  const number = Number(unwrapped(value.operand).getText().replaceAll('_', ''));
  if (value.operator === SyntaxKind.PlusToken) return number;
  return value.operator === SyntaxKind.MinusToken ? -number : undefined;
}

/** Only guaranteed literal truthiness narrows an array-like hook's possible native behavior. */
export function concatTruth(
  value: Expression | undefined,
  stable: ConcatStable,
): boolean | undefined {
  if (value !== undefined && framedNativeConstructor(value, UNDEFINED)) return false;
  const source = value === undefined ? undefined : concatSource(value, stable);
  if (source === undefined) return undefined;
  if (isVoidExpression(source) && concatQuietArguments([source.expression], stable)) return false;
  if (source.kind === SyntaxKind.TrueKeyword) return true;
  if (source.kind === SyntaxKind.FalseKeyword || source.kind === SyntaxKind.NullKeyword)
    return false;
  if (isStringLiteral(source) || isNoSubstitutionTemplateLiteral(source))
    return source.text.length > 0;
  const number = literalNumber(source);
  if (number !== undefined) return Boolean(number);
  return isObjectLiteralExpression(source) ||
    isArrayLiteralExpression(source) ||
    isNewExpression(source) ||
    isArrowFunction(source) ||
    isFunctionExpression(source) ||
    isRegularExpressionLiteral(source)
    ? true
    : undefined;
}

/** A data field supplies its original initializer; accessors retain an unknown metadata value. */
function concatData(field: ObjectLiteralExpression['properties'][number]): Expression | undefined {
  if (isPropertyAssignment(field)) return field.initializer;
  return isShorthandPropertyAssignment(field) && isIdentifier(field.name) ? field.name : undefined;
}

/** Numeric source selections retain getter returns and alias spread fields while excluding symbols. */
export function concatValues(
  root: ObjectLiteralExpression,
  key: string,
  stable: ConcatStable,
): readonly { readonly value: Expression; readonly keys: readonly string[] }[] {
  const found: { value: Expression; keys: readonly string[] }[] = [];
  const pending = [
    { value: root as Expression, keys: [key] as readonly string[], seen: new Set<Expression>() },
  ];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (at.seen.has(at.value) || (at.value !== root && symbolValue(at.value))) continue;
    const seen = new Set(at.seen).add(at.value);
    const source = at.keys.length === 0 ? at.value : (concatSource(at.value, stable) ?? at.value);
    const selected = framedObjectSources(source, at.keys);
    if (selected === undefined) found.push({ value: at.value, keys: at.keys });
    else pending.push(...selected.map((each) => ({ ...each, seen })));
  }
  return found;
}

/**
 * Original symbol data and getter returns cannot be numeric slot values merely because a key is
 * opaque. The copied literal itself is no field's value, whatever function or getter holds it.
 */
function symbolValue(value: Expression): boolean {
  for (let node: Node = value; !isSourceFile(node); node = node.parent) {
    const parent = node.parent;
    if (isPropertyAssignment(parent) || isGetAccessorDeclaration(parent))
      return concatSymbol(parent.name);
    if (isObjectLiteralExpression(parent)) return false;
  }
  return false;
}
