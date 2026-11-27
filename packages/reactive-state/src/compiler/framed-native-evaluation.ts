import {
  type Expression,
  type GetAccessorDeclaration,
  isArrayLiteralExpression,
  isComputedPropertyName,
  isGetAccessorDeclaration,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPrefixUnaryExpression,
  isPropertyAssignment,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  type ObjectLiteralExpression,
  type PropertyName,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { argumentArrayExposed } from './framed-array-selections.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { framedNativeErrorInput } from './framed-native-error-inputs.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** Added native text consumers retain prior opacity when argument evaluation can run application work. */

const CONVERSION_MEMBERS = new Set(['__proto__', 'toString', 'valueOf']);

/**
 * Whole unchanged constant aliases retain their written initializer without executing a call. A
 * reader whose proof an exposure drops passes `reached` false, to count only a loop body's uses.
 */
export function framedQuietSource(
  expression: Expression,
  reached: boolean | 'loops' = 'loops',
): Expression | undefined {
  const source = quietAliasSource(expression);
  return source === undefined ||
    argumentArrayExposed(expression, source.bindings, undefined, reached)
    ? undefined
    : source.value;
}

/** Binding reads keep only constant initializer evaluation, with no general invocation result inference. */
/** A whole constant alias chain's written initializer, whatever may have used the chain since. */
export function framedWrittenSource(expression: Expression): Expression | undefined {
  return quietAliasSource(expression)?.value;
}

function quietAliasSource(
  expression: Expression,
): { readonly value: Expression; readonly bindings: ReadonlySet<FrameBinding> } | undefined {
  let value = unwrapped(expression);
  const bindings = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (
      selected === undefined ||
      !isVariableDeclaration(selected.binding) ||
      !isVariableDeclarationList(selected.binding.parent)
    )
      break;
    const { binding } = selected;
    if (
      selected.keys.length > 0 ||
      bindings.has(binding) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return undefined;
    bindings.add(binding);
    value = unwrapped(binding.initializer);
  }
  return { value, bindings };
}

/** Literal primitives and their unchanged whole aliases perform no application conversion. */
export function framedQuietPrimitive(expression: Expression): boolean {
  const value = framedQuietSource(expression);
  if (value === undefined) return false;
  if (isPrefixUnaryExpression(value))
    return (
      (value.operator === SyntaxKind.MinusToken || value.operator === SyntaxKind.PlusToken) &&
      isNumericLiteral(unwrapped(value.operand))
    );
  return (
    isNumericLiteral(value) ||
    isStringLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value) ||
    [SyntaxKind.FalseKeyword, SyntaxKind.NullKeyword, SyntaxKind.TrueKeyword].includes(
      value.kind,
    ) ||
    globalPathOf(value)?.join('.') === 'undefined'
  );
}

/** A single direct getter return adds no prefix, callback or general callable inference. */
export function framedQuietGetter(getter: GetAccessorDeclaration): Expression | undefined {
  const statements = getter.body?.statements;
  const first = statements?.[0];
  return first !== undefined && statements?.length === 1 && isReturnStatement(first)
    ? first.expression
    : undefined;
}

/** Fresh literal data has no callable conversion hooks or unresolved spread iteration. */
export function framedQuietData(expression: Expression): boolean {
  return quietValues([expression], new Set(), true);
}

/** Literal array text reaches Error words only without earlier opaque element conversions. */
export function framedQuietArrayWords(
  expression: Expression,
  error: (value: Expression) => boolean,
  consumer: Expression,
): boolean {
  const pending = [expression];
  const seen = new Set<Expression>();
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const value = framedQuietSource(at, false);
    if (value === undefined) return false;
    if (seen.has(value)) continue;
    seen.add(value);
    if (quietArrayWord(value, error, consumer)) continue;
    if (isArrayLiteralExpression(value)) pending.push(...value.elements);
    else if (isSpreadElement(value)) pending.push(value.expression);
    else return false;
  }
  return true;
}

/** A primitive or an already engine-sensitive Error adds no preceding opaque element conversion. */
function quietArrayWord(
  value: Expression,
  error: (value: Expression) => boolean,
  consumer: Expression,
): boolean {
  return (
    framedQuietPrimitive(value) ||
    (isIdentifier(value) &&
      framedNativeErrorInput(value, consumer, undefined, false) &&
      error(value))
  );
}

/** Every written input is evaluated, including arguments that the native consumer later ignores. */
export function framedQuietInputs(
  args: readonly Expression[],
  natives: ReadonlySet<string>,
): boolean {
  return quietValues(args, natives, false);
}

/** A bounded work list reads syntax and unchanged bindings, never a runtime constant evaluator. */
function quietValues(
  args: readonly Expression[],
  natives: ReadonlySet<string>,
  data: boolean,
): boolean {
  const pending = [...args];
  const seen = new Set<Expression>();
  for (let expression = pending.pop(); expression !== undefined; expression = pending.pop()) {
    const value = data ? framedQuietSource(expression) : quietAliasSource(expression)?.value;
    if (value === undefined) return false;
    if (seen.has(value)) continue;
    seen.add(value);
    if (!quietValue(value, pending, natives, data)) return false;
  }
  return true;
}

/** Each supported literal form adds only its source-written evaluation operands. */
function quietValue(
  value: Expression,
  pending: Expression[],
  natives: ReadonlySet<string>,
  data: boolean,
): boolean {
  if (framedQuietPrimitive(value) || isOmittedExpression(value)) return true;
  if (!data && quietNativeValue(value, natives)) return true;
  if (isArrayLiteralExpression(value)) {
    pending.push(...value.elements);
    return true;
  }
  if (isObjectLiteralExpression(value)) return quietFields(value, pending);
  if (!isSpreadElement(value)) return false;
  const source = framedQuietSource(value.expression, false);
  if (source === undefined || !isArrayLiteralExpression(source)) return false;
  pending.push(source);
  return true;
}

/** Native wrapper targets and fresh native receiver construction retain only quiet written inputs. */
function quietNativeValue(value: Expression, natives: ReadonlySet<string>): boolean {
  if (isIdentifier(value) || framedNativeConstructor(value, natives)) return true;
  return (
    isNewExpression(value) &&
    framedNativeConstructor(value.expression, natives) &&
    (value.arguments ?? []).every((argument) => framedQuietData(argument))
  );
}

/** Literal fields retain direct source-return getters; callable conversions stay opaque. */
function quietFields(value: ObjectLiteralExpression, pending: Expression[]): boolean {
  return value.properties.every((property) => quietField(property, pending));
}

/** One field contributes only an initializer or a direct getter result. */
function quietField(
  property: ObjectLiteralExpression['properties'][number],
  pending: Expression[],
): boolean {
  if (isSpreadAssignment(property)) {
    const source = framedQuietSource(property.expression, false);
    if (source === undefined || !isObjectLiteralExpression(source)) return false;
    pending.push(source);
  } else if (isPropertyAssignment(property) && quietName(property.name))
    pending.push(property.initializer);
  else if (
    isShorthandPropertyAssignment(property) &&
    isIdentifier(property.name) &&
    quietName(property.name)
  )
    pending.push(property.name);
  else if (isGetAccessorDeclaration(property) && quietName(property.name)) {
    const result = framedQuietGetter(property);
    if (result === undefined) return false;
    pending.push(result);
  } else return false;
  return true;
}

/** Literal names cannot execute a computed key or replace an object's inherited conversion hooks. */
function quietName(name: PropertyName | undefined): boolean {
  if (name === undefined) return false;
  const value = isComputedPropertyName(name) ? unwrapped(name.expression) : name;
  return (
    ((!isComputedPropertyName(name) && isIdentifier(value)) ||
      isStringLiteral(value) ||
      isNoSubstitutionTemplateLiteral(value) ||
      isNumericLiteral(value)) &&
    !CONVERSION_MEMBERS.has(value.text)
  );
}
