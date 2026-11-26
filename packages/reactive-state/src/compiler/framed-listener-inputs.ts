import {
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isFunctionExpression,
  isIdentifier,
  isVariableDeclaration,
  isVariableDeclarationList,
  SyntaxKind,
  isSpreadElement,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { framedQuietInputs, framedQuietSource } from './framed-native-evaluation.ts';

/** Listener function creation is quiet without executing its deferred body. */

export const LISTENER_METHODS = new Set([
  'EventTarget.prototype.addEventListener',
  'EventTarget.prototype.removeEventListener',
]);
export const LISTENER_NATIVES = new Set([
  'EventTarget',
  'EventTarget.prototype',
  ...LISTENER_METHODS,
  'EventTarget.prototype.addEventListener.apply',
  'EventTarget.prototype.addEventListener.call',
  'EventTarget.prototype.removeEventListener.apply',
  'EventTarget.prototype.removeEventListener.call',
  'Reflect.apply',
]);

/** Finite native borrowing lists may contain literal listener functions as well as ordinary quiet inputs. */
export function quietListenerInputs(args: readonly Expression[]): boolean {
  const pending = [...args];
  const seen = new Set<Expression>();
  for (let value = pending.pop(); value !== undefined; value = pending.pop()) {
    if (isIdentifier(unwrapped(value)) || framedQuietInputs([value], LISTENER_NATIVES)) continue;
    const source = framedQuietSource(isSpreadElement(value) ? value.expression : value, false);
    if (source === undefined || seen.has(source)) return false;
    seen.add(source);
    if (isArrayLiteralExpression(source)) pending.push(...source.elements);
    else if (!isArrowFunction(source) && !isFunctionExpression(source)) return false;
  }
  return true;
}

/** Earlier native registrations may carry only a closed literal callback or an omitted/null callback. */
export function quietListenerCallback(expression: Expression | undefined): boolean {
  if (expression === undefined) return true;
  let value = unwrapped(expression);
  const seen = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    if (globalPathOf(value)?.join('.') === 'undefined') return true;
    const source = frameBindingOf(value);
    if (source === undefined || source.keys.length > 0 || seen.has(source.binding)) return false;
    const { binding } = source;
    if (
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return false;
    seen.add(binding);
    value = unwrapped(binding.initializer);
  }
  return (
    isArrowFunction(value) || isFunctionExpression(value) || value.kind === SyntaxKind.NullKeyword
  );
}
