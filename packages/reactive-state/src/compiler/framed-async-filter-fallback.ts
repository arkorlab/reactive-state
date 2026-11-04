import {
  type ArrowFunction,
  type Expression,
  isBlock,
  isElementAccessExpression,
  isIdentifier,
  isParameterDeclaration,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  type ParameterDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameBindingOf, frameMemberName } from './framed-bindings.ts';
import { concatQuietArguments } from './framed-concat-properties.ts';
import { immediateMember, immediateSelection, type QuietCopyCall } from './framed-copy-guards.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedOriginPrefix } from './framed-origin-prefix.ts';

/** Async falsy predicates keep parameter elements only across quiet immediate native reads. */

/** New parameter fallback cannot cross callback initialization, prior work or saved-result mutation. */
export function quietAsyncFilterFallback(
  copy: QuietCopyCall,
  predicate: ArrowFunction,
  stable: (receiver: Expression) => boolean,
): boolean {
  return (
    directMethod(copy, 'filter') &&
    immediateSelection(copy.call) &&
    quietParameterFallback(copy, predicate, stable)
  );
}

/** A direct find or findLast keeps possible parameter elements without claiming an exact endpoint. */
export function quietAsyncFindFallback(
  copy: QuietCopyCall,
  predicate: ArrowFunction,
  stable: (receiver: Expression) => boolean,
): boolean {
  return (
    (directMethod(copy, 'find') || directMethod(copy, 'findLast')) &&
    immediateMember(copy.call) &&
    quietParameterFallback(copy, predicate, stable)
  );
}

/** Full original operands and same-owner parameter wiring keep the existing fallback quiet. */
function quietParameterFallback(
  copy: QuietCopyCall,
  predicate: ArrowFunction,
  stable: (receiver: Expression) => boolean,
): boolean {
  if (
    copy.unknownArguments === true ||
    !plainParameters(predicate) ||
    !quietBody(predicate) ||
    !parameterReceiver(copy.receiver) ||
    !framedOriginPrefix(copy.call) ||
    !framedOriginCoowned(copy.receiver, copy.call)
  )
    return false;
  const args = framedArgumentPrefix(copy.call, copy.call.arguments, Infinity);
  const first = args.values[0];
  return (
    !args.unknown &&
    args.alternatives === undefined &&
    first !== undefined &&
    unwrapped(first) === predicate &&
    concatQuietArguments(args.values.slice(1), stable)
  );
}

/** The callback's simple parameters perform no defaults or destructuring before its async answer. */
function plainParameters(fn: { readonly parameters?: readonly ParameterDeclaration[] }): boolean {
  return (fn.parameters ?? []).every(
    (parameter) => isIdentifier(parameter.name) && parameter.initializer === undefined,
  );
}

/** Literal primitive returns and their logical negations perform no application work. */
function quietBody(predicate: ArrowFunction): boolean {
  if (isBlock(predicate.body)) return false;
  let value = unwrapped(predicate.body);
  while (isPrefixUnaryExpression(value) && value.operator === SyntaxKind.ExclamationToken)
    value = unwrapped(value.operand);
  return framedMapKey(value) !== undefined;
}

/** Only the direct native-name path reaches this fallback; borrowed and own calls keep their old path. */
function directMethod(copy: QuietCopyCall, method: string): boolean {
  const member = unwrapped(copy.call.expression);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return false;
  return (
    frameMemberName(member) === method &&
    unwrapped(member.expression) === unwrapped(copy.receiver) &&
    (!isElementAccessExpression(member) || framedMapKey(member.argumentExpression) !== undefined)
  );
}

/** Whole const aliases stop at a same-owner parameter; unknown member reads keep their old opacity. */
function parameterReceiver(expression: Expression): boolean {
  const seen = new Set<Expression>();
  let value = expression;
  while (!seen.has(value)) {
    seen.add(value);
    const step = receiverStep(unwrapped(value));
    if (step === undefined) return false;
    if (step.parameter) return true;
    if (step.next === undefined) return false;
    value = step.next;
  }
  return false;
}

interface ReceiverStep {
  readonly parameter: boolean;
  readonly next?: Expression;
}

/** Only whole constant wiring retains a parameter root without evaluating a supplied field. */
function receiverStep(value: Expression): ReceiverStep | undefined {
  const selected = isIdentifier(value) ? frameBindingOf(value) : undefined;
  if (selected?.keys.length !== 0 || !isIdentifier(selected.binding.name)) return undefined;
  const { binding } = selected;
  if (isParameterDeclaration(binding))
    return binding.initializer === undefined ? { parameter: true } : undefined;
  return isVariableDeclaration(binding) &&
    isVariableDeclarationList(binding.parent) &&
    /^const\b/u.test(binding.parent.getText(binding.getSourceFile())) &&
    binding.initializer !== undefined
    ? { parameter: false, next: binding.initializer }
    : undefined;
}
