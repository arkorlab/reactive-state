import {
  type Expression,
  type Identifier,
  isBindingElement,
  isCallExpression,
  isComputedPropertyName,
  isConditionalExpression,
  isElementAccessExpression,
  isIdentifier,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { framedKeyNames, framedMemberNames } from './framed-keys.ts';
import { framedCondition } from './framed-sources.ts';

/** Known symbol-valued keys cannot select an error's string-named frames or words. */

const SYMBOL_KEYS: ReadonlySet<string> = new Set([
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

/** A symbol selection has no string member names; other finite and opaque keys keep their meaning. */
export function framedPropertyNames(key: Expression): readonly string[] | undefined {
  return symbolKey(key) ? [] : framedKeyNames(key);
}

/** An element or computed binding key retains its symbol identity before the unknown-key fallback. */
export function framedObservedNames(node: Node): readonly string[] | undefined {
  if (isElementAccessExpression(node)) return framedPropertyNames(node.argumentExpression);
  if (
    isBindingElement(node) &&
    node.propertyName !== undefined &&
    isComputedPropertyName(node.propertyName)
  )
    return framedPropertyNames(node.propertyName.expression);
  return framedMemberNames(node);
}

/** Native symbol expressions and whole const aliases, without classifying shadowed implementations. */
function symbolKey(key: Expression): boolean {
  const pending: Expression[] = [key];
  const seen = new Set<Node>();
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const value = unwrapped(node);
    if (seen.has(value)) return false;
    seen.add(value);
    if (nativeSymbol(value)) continue;
    const next = symbolAlternatives(value);
    if (next === undefined) return false;
    pending.push(...next);
  }
  return true;
}

/** Only source-unshadowed native symbol makers and well-known keys establish primitive identity. */
function nativeSymbol(value: Expression): boolean {
  if (SYMBOL_KEYS.has(globalPathOf(value)?.join('.') ?? '')) return true;
  if (!isCallExpression(value)) return false;
  const path = globalPathOf(unwrapped(value.expression))?.join('.');
  return path === 'Symbol' || path === 'Symbol.for';
}

/** Every possible branch must retain symbol identity; constant aliases keep the same primitive. */
function symbolAlternatives(value: Expression): readonly Expression[] | undefined {
  if (isConditionalExpression(value)) {
    const condition = framedCondition(value.condition);
    return condition === undefined
      ? [value.whenTrue, value.whenFalse]
      : [condition ? value.whenTrue : value.whenFalse];
  }
  const next = isIdentifier(value) ? constantInitializer(value) : undefined;
  return next === undefined ? undefined : [next];
}

/** Const value aliases preserve an immutable primitive symbol, with cycles left opaque. */
function constantInitializer(name: Identifier): Expression | undefined {
  const declared = frameDeclarationOf(name);
  if (declared === undefined || !isVariableDeclaration(declared) || !isIdentifier(declared.name))
    return undefined;
  const statement = declared.parent.parent;
  return isVariableStatement(statement) &&
    /^const\s/u.test(statement.declarationList.getText(statement.getSourceFile()))
    ? declared.initializer
    : undefined;
}
