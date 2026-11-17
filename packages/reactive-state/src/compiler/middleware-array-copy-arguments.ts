import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isCallExpression,
  isElementAccessExpression,
  isExpression,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isSourceFile,
  isSpreadElement,
  isVariableDeclaration,
  isVoidExpression,
  type Node,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { memberPath } from './exported-values.ts';
import { argumentArrayReached } from './framed-array-selections.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { concatQuietArguments } from './framed-concat-properties.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedSourceValues } from './framed-sources.ts';

/** Shared argument quietness, spread expansion, and lexical owner helpers for native array copies. */

export interface MiddlewareCopyOrigin {
  readonly of: Expression;
  readonly keys: readonly string[];
  readonly tail: readonly string[];
  readonly slot?: string | undefined;
  readonly whole?: boolean | undefined;
  readonly wrapperLength?: number | undefined;
  readonly references: readonly Identifier[];
}

export interface MiddlewareSpreadCandidate {
  readonly value: Expression;
  readonly element: boolean;
}

interface SpreadTask {
  readonly expression: Expression;
  readonly direct: boolean;
}

const WRAPPER = { reflect: 3 } as const;

/** Native copy indexing stays exact only while arguments are quiet and the receiver is unexposed. */
export function middlewareStableCopy(
  call: CallExpression,
  receiver: Expression,
  given: readonly Expression[] | undefined,
): boolean {
  return middlewareCopyArgumentsQuiet(call, given) && middlewareStableSource(receiver);
}

/** Every evaluated argument and borrowed apply tail must stay quiet before copying starts. */
export function middlewareCopyArgumentsQuiet(
  call: CallExpression,
  given: readonly Expression[] | undefined,
): boolean {
  if (given === undefined) return false;
  const prefix = framedArgumentPrefix(call, given, Infinity);
  if (prefix.unknown || prefix.alternatives !== undefined) return false;
  return [...prefix.values, ...middlewareWrapperTail(call)].every((value) =>
    quietCopyArgument(value),
  );
}

/** Original whole-array stability is the same exposure proof used by the shared native copy readers. */
export function middlewareStableSource(
  expression: Expression,
  at: Expression = expression,
): boolean {
  let value = memberPath(expression).root;
  const aliases = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0 || aliases.has(selected.binding))
      return false;
    aliases.add(selected.binding);
    if (selected.binding.initializer === undefined) return false;
    value = memberPath(selected.binding.initializer).root;
  }
  return !argumentArrayReached(memberPath(at).root, aliases);
}

/** Ignored native wrapper tails remain evaluated before the copy reads its original segments. */
export function middlewareWrapperTail(call: CallExpression): readonly Expression[] {
  const member = unwrapped(call.expression);
  if (globalPathOf(member)?.join('.') === 'Reflect.apply')
    return call.arguments.slice(WRAPPER.reflect);
  return (isPropertyAccessExpression(member) || isElementAccessExpression(member)) &&
    frameMemberName(member) === 'apply'
    ? call.arguments.slice(2)
    : [];
}

/** Candidate inserted values come from arguments past the fixed prefix or unresolved spread tuples. */
export function middlewareInsertedOrigins(
  input: {
    readonly call: CallExpression;
    readonly given: readonly Expression[] | undefined;
    readonly applied?: Expression | undefined;
    readonly tail: readonly string[];
  },
  mode: 'splice' | 'with',
): readonly MiddlewareCopyOrigin[] {
  const { call, given, applied, tail } = input;
  if (given === undefined)
    return applied === undefined ? [] : candidateOrigins(middlewareSpreadCandidates(applied), tail);
  const prefix = framedArgumentPrefix(call, given, Infinity);
  if (!prefix.unknown && prefix.alternatives === undefined) {
    const values = mode === 'splice' ? prefix.values.slice(2) : prefix.values.slice(1, 2);
    return values.map((value) => middlewareElementOrigin(value, tail));
  }
  return mixedInsertedOrigins(call, given, tail, mode);
}

/** Unresolved spread expressions keep whole array containers and literal branch elements in order. */
export function middlewareSpreadCandidates(
  expression: Expression,
): readonly MiddlewareSpreadCandidate[] {
  const found: MiddlewareSpreadCandidate[] = [];
  const seen = new Set<Node>();
  const pending: SpreadTask[] = [{ expression, direct: false }];
  for (let task = pending.pop(); task !== undefined; task = pending.pop()) {
    if (task.direct) {
      found.push({ value: task.expression, element: true });
      continue;
    }
    const value = unwrapped(task.expression);
    if (seen.has(value)) continue;
    seen.add(value);
    if (isArrayLiteralExpression(value)) {
      pushArraySpreadTasks(pending, value.elements);
      continue;
    }
    const branches = framedSourceValues(value);
    if (branches !== undefined) {
      for (const branch of branches.toReversed())
        pending.push({ expression: branch, direct: false });
      continue;
    }
    found.push({ value, element: false });
  }
  return found;
}

/** An inserted argument supplies the selected element directly under the remaining member tail. */
export function middlewareElementOrigin(
  of: Expression,
  tail: readonly string[],
): MiddlewareCopyOrigin {
  return { of, keys: tail, tail, references: middlewareLiteralOwners(of) };
}

/** An array container with an unknown selected slot retains its whole collection identity. */
export function middlewareWholeOrigin(
  expression: Expression,
  tail: readonly string[],
): MiddlewareCopyOrigin {
  const of = unwrapped(expression);
  return { of, keys: [], tail, whole: true, references: middlewareLiteralOwners(of) };
}

/** Original literal descendants retain their lexical collection owner, stopping at call or callable boundaries. */
export function middlewareLiteralOwners(value: Expression): readonly Identifier[] {
  let within: Node = value;
  for (let node: Node = value.parent; !isSourceFile(node); within = node, node = node.parent) {
    if (isAnswering(node) || isCallExpression(node) || isNewExpression(node)) return [];
    if (isVariableDeclaration(node) && isExpression(within) && node.initializer === within)
      return isIdentifier(node.name) ? [node.name] : [];
  }
  return [];
}

/** Closure creation, holes and quiet primitive or literal data run no pre-copy mutations. */
function quietCopyArgument(expression: Expression): boolean {
  const pending: Expression[] = [expression];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const value = unwrapped(next);
    if (
      isArrowFunction(value) ||
      isFunctionExpression(value) ||
      isOmittedExpression(value) ||
      concatQuietArguments([value], middlewareStableSource)
    )
      continue;
    const children = copyLiteralValues(value);
    if (children === undefined) return false;
    pending.push(...children);
  }
  return true;
}

/** Void operands and spread-free literal arrays expose nested closures to the quiet check. */
function copyLiteralValues(value: Expression): readonly Expression[] | undefined {
  if (isVoidExpression(value)) return [value.expression];
  if (!isArrayLiteralExpression(value)) return undefined;
  if (value.elements.some((element) => isSpreadElement(element))) return undefined;
  return value.elements;
}

/** Arguments after an unresolved spread may land in the inserted range regardless of written index. */
function mixedInsertedOrigins(
  call: CallExpression,
  given: readonly Expression[],
  tail: readonly string[],
  mode: 'splice' | 'with',
): readonly MiddlewareCopyOrigin[] {
  const origins: MiddlewareCopyOrigin[] = [];
  const state = { position: 0, afterSpread: false };
  for (const argument of given) {
    if (!isSpreadElement(argument)) {
      appendPositionalOrigins(origins, [argument], state, { mode, tail });
      continue;
    }
    const expanded = framedArgumentPrefix(call, [argument], Infinity);
    if (!expanded.unknown && expanded.alternatives === undefined) {
      appendPositionalOrigins(origins, expanded.values, state, { mode, tail });
      continue;
    }
    state.afterSpread = true;
    origins.push(...candidateOrigins(middlewareSpreadCandidates(argument.expression), tail));
  }
  return origins;
}

/** Only argument slots in the target parameter range, or shifted past an opaque spread, insert items. */
function appendPositionalOrigins(
  origins: MiddlewareCopyOrigin[],
  values: readonly Expression[],
  state: { position: number; afterSpread: boolean },
  options: { readonly mode: 'splice' | 'with'; readonly tail: readonly string[] },
): void {
  for (const value of values) {
    const matches = options.mode === 'splice' ? state.position >= 2 : state.position === 1;
    if (matches || state.afterSpread) origins.push(middlewareElementOrigin(value, options.tail));
    state.position += 1;
  }
}

/** Spread candidates map direct literal elements under the member tail and containers as whole arrays. */
function candidateOrigins(
  candidates: readonly MiddlewareSpreadCandidate[],
  tail: readonly string[],
): readonly MiddlewareCopyOrigin[] {
  return candidates.map((candidate) => {
    return candidate.element
      ? middlewareElementOrigin(candidate.value, tail)
      : middlewareWholeOrigin(candidate.value, tail);
  });
}

/** Literal spread arrays contribute each non-hole element and queue nested spreads in source order. */
function pushArraySpreadTasks(pending: SpreadTask[], elements: readonly Expression[]): void {
  for (const element of elements.toReversed()) {
    if (isOmittedExpression(element)) continue;
    if (isSpreadElement(element)) pending.push({ expression: element.expression, direct: false });
    else pending.push({ expression: element, direct: true });
  }
}
