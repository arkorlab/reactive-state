import {
  type CallExpression,
  type Expression,
  type Identifier,
  isComputedPropertyName,
  isCallExpression,
  isExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isSpreadElement,
  isShorthandPropertyAssignment,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
  type PropertyName,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf, useOf } from './code-globals.ts';
import { arrayError } from './framed-arrays.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { framedAppliedArguments, framedArgumentPrefix, framedKeyNames } from './framed-keys.ts';
import { framedRawArraylike, rawArraylikeWords } from './framed-raw-arraylike.ts';
import { framedConsumedArguments } from './framed-text-arguments.ts';
import { constantValue } from './numbers.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** Native String.raw converts its raw segments and only the substitutions its segment count consumes. */

interface RawWords {
  readonly error: (value: Expression) => boolean;
  readonly typed: (value: Expression) => boolean;
}

/** A written native call, with unknown source lists retaining possible converted entries. */
export function framedNativeRaw(
  call: CallExpression,
  args: readonly Expression[],
  words: RawWords,
): boolean {
  const prefix = framedArgumentPrefix(call, args, Infinity);
  const template = prefix.values[0];
  const raw = template === undefined ? undefined : rawProperty(template);
  const segments = raw === undefined ? undefined : framedAppliedArguments(call, raw);
  const own = raw === undefined ? undefined : framedRawArraylike(raw, call);
  const count = own?.count ?? rawCount(raw, segments, call);
  if (count === 0) return false;
  if (raw !== undefined && arrayError(raw, words, call)) return true;
  if (own !== undefined && rawArraylikeWords(own, prefix, call, words)) return true;
  const consumed = count === undefined ? prefix.values.slice(1) : prefix.values.slice(1, count);
  if (consumed.some((value) => convertedWords(value, words, call))) return true;
  return (
    prefix.unknown &&
    (count === undefined || prefix.values.length < count) &&
    (count === undefined ? args : framedConsumedArguments(call, args, count)).some((value) =>
      convertedWords(value, words, call),
    )
  );
}

/** A borrowed apply list reuses the existing immutable tuple and write proof. */
export function framedNativeRawApply(
  call: CallExpression,
  applied: Expression,
  words: RawWords,
): boolean {
  const args = framedAppliedArguments(call, applied);
  return args === undefined ? arrayError(applied, words, call) : framedNativeRaw(call, args, words);
}

/** Primitive text has its own count; finite literal arrays retain all known spread positions. */
function rawCount(
  raw: Expression | undefined,
  segments: readonly Expression[] | undefined,
  call: CallExpression,
): number | undefined {
  if (raw === undefined) return undefined;
  const text = constantValue(raw);
  if (typeof text === 'string') return text.length;
  if (segments === undefined) return undefined;
  const prefix = framedArgumentPrefix(call, segments, Infinity);
  return prefix.unknown ? undefined : prefix.values.length;
}

/** Direct errors and arrays whose native conversion includes errors expose their words. */
function convertedWords(value: Expression, words: RawWords, call: CallExpression): boolean {
  if (isSpreadElement(value)) return arrayError(value.expression, words, call);
  return words.error(value) || arrayError(value, words, call);
}

/** A fully written raw property, with single-use immutable holder aliases followed in place. */
function rawProperty(node: Expression): Expression | undefined {
  const object = templateValue(node);
  if (!isObjectLiteralExpression(object)) return undefined;
  let result: Expression | undefined;
  for (const property of object.properties) {
    if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
      if (property.name.text === 'raw') result = property.name;
      continue;
    }
    if (!isPropertyAssignment(property)) return undefined;
    const key = propertyKey(property.name);
    if (key === undefined) return undefined;
    if (key === 'raw') result = property.initializer;
  }
  return result;
}

/** Stable holder aliases have no other source use that could replace their raw property. */
function templateValue(node: Expression): Expression {
  let value = unwrapped(node);
  const seen = new Set<Node>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const declaration = frameDeclarationOf(value);
    if (
      declaration === undefined ||
      !isVariableDeclaration(declaration) ||
      !isIdentifier(declaration.name)
    )
      break;
    const statement = declaration.parent.parent;
    if (
      !isVariableStatement(statement) ||
      !/^const\s/u.test(statement.declarationList.getText(statement.getSourceFile())) ||
      declaration.initializer === undefined ||
      exposedHolder(value, declaration)
    )
      break;
    value = unwrapped(declaration.initializer);
  }
  return value;
}

/** No lexical use other than this initializer or call can alter the holder before conversion. */
function exposedHolder(read: Identifier, declaration: VariableDeclaration): boolean {
  const pending: Node[] = [read.getSourceFile()];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (isTypeOnly(at)) continue;
    if (
      at !== read &&
      at !== declaration.name &&
      isIdentifier(at) &&
      readsBinding(at) &&
      at.text === read.text &&
      frameDeclarationOf(at) === declaration &&
      !nativeRawTemplateRead(at)
    )
      return true;
    at.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Another direct native raw read does not write or expose its source-known template holder. */
function nativeRawTemplateRead(node: Identifier): boolean {
  const { at, parent } = useOf(node);
  if (!isCallExpression(parent)) return false;
  const first: Node | undefined = parent.arguments[0];
  return first === at && globalPathOf(unwrapped(parent.expression))?.join('.') === 'String.raw';
}

/** A single written key keeps property-name syntax separate from general expressions. */
function propertyKey(name: PropertyName): string | undefined {
  if (isIdentifier(name)) return name.text;
  const key = isComputedPropertyName(name) ? name.expression : name;
  if (!isExpression(key)) return undefined;
  const keys = framedKeyNames(key);
  return keys?.length === 1 ? keys[0] : undefined;
}
