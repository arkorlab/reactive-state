import {
  type CallExpression,
  type ElementAccessExpression,
  type Expression,
  type Identifier,
  isArrowFunction,
  isCallExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isRegularExpressionLiteral,
  isSpreadElement,
  isVariableDeclaration,
  type NewExpression,
  type Node,
  type PropertyAccessExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameMemberName } from './framed-bindings.ts';
import { readsOf } from './local-module-reads.ts';
import { handedTo, isConstList } from './local-write-paths.ts';
import { constantValue } from './numbers.ts';
import {
  constBindingOf,
  isMutationTarget,
  memberOrSymbolKey,
  mutatesMatchIntrinsics,
  ownerScopeOf,
  resolveLocalConst,
  topWrapped,
} from './retained-match-intrinsics.ts';
import { isNullishOrString } from './retained-match-receivers.ts';

/**
 * Distinguishes native global `RegExp` matches (`'aba'.match(/a/g)`, `re[Symbol.match]('aba')`),
 * which return `string[] | null` without extra match properties, from non-global, string-pattern,
 * dynamic-flag, custom-receiver, or mutated matches that return decorated or arbitrary results.
 */

export { symbolMethodName } from './retained-match-intrinsics.ts';

interface RegExpObligation {
  readonly expr: Expression;
  readonly visiting: ReadonlySet<Identifier>;
}

const VALID_REGEXP_FLAGS: ReadonlySet<string> = new Set(['d', 'g', 'i', 'm', 's', 'u', 'v', 'y']);

const SAFE_REGEXP_METHODS: ReadonlySet<string> = new Set([
  'exec',
  'Symbol.match',
  'Symbol.matchAll',
  'Symbol.replace',
  'Symbol.search',
  'Symbol.split',
  'test',
  'toString',
  'valueOf',
]);

const SAFE_STRING_PATTERN_METHODS: ReadonlySet<string> = new Set([
  'match',
  'matchAll',
  'replace',
  'replaceAll',
  'search',
  'split',
]);

/** Checks whether a member access `parent` on `re` is a non-mutating read or safe method call. */
function isSafeRegExpMember(parent: PropertyAccessExpression | ElementAccessExpression): boolean {
  const key = memberOrSymbolKey(parent);
  const memberTop = topWrapped(parent);
  if (key === undefined || isMutationTarget(memberTop)) return false;
  if (isCallExpression(memberTop.parent) && memberTop.parent.expression === memberTop) {
    return SAFE_REGEXP_METHODS.has(key);
  }
  return handedTo(memberTop) === undefined;
}

/** Validates trailing arguments of a native `String.prototype` pattern method receiving `re`. */
function isSafeStringMethodArgs(method: string, args: readonly Expression[]): boolean {
  if (args.slice(1).some((each) => isSpreadElement(each))) return false;
  if (method === 'replace' || method === 'replaceAll') {
    if (args.length > 2) return false;
    const replacer = args[1];
    if (replacer === undefined || isNullishOrString(replacer)) return true;
    const inner = unwrapped(replacer);
    return isArrowFunction(inner) || isFunctionExpression(inner);
  }
  if (method === 'split') {
    const limit = args[1];
    return (
      args.length <= 2 &&
      (limit === undefined ||
        globalPathOf(unwrapped(limit))?.join('.') === 'undefined' ||
        typeof constantValue(limit, resolveLocalConst) === 'number')
    );
  }
  return args.length === 1;
}

/** Checks whether passing `top` as an argument to `call` preserves `re` unmutated. */
function isSafeRegExpArgument(top: Expression, call: CallExpression | NewExpression): boolean {
  const given = call.arguments ?? [];
  if (isSpreadElement(top.parent) || given[0] !== top) return false;
  const callee = unwrapped(call.expression);
  if (globalPathOf(callee)?.join('.') === 'RegExp') {
    const flagsArg = given[1];
    return (
      given.length <= 2 &&
      (flagsArg === undefined ||
        (!isSpreadElement(flagsArg) &&
          (globalPathOf(unwrapped(flagsArg))?.join('.') === 'undefined' ||
            isNullishOrString(flagsArg))))
    );
  }
  if (!isCallExpression(call)) return false;
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) return false;
  const method = frameMemberName(callee);
  return (
    method !== undefined &&
    SAFE_STRING_PATTERN_METHODS.has(method) &&
    isNullishOrString(callee.expression) &&
    isSafeStringMethodArgs(method, given)
  );
}

/** Whether `declared` (`const re = …`) can be mutated or escape anywhere in its owner scope. */
function isRegExpMutated(declared: Identifier, checked: ReadonlySet<Identifier>): boolean {
  if (checked.has(declared)) return false;
  const nextChecked = new Set([...checked, declared]);
  const owner = ownerScopeOf(declared);
  const isRead = readsOf(declared, owner);
  const state = { mutated: false };
  const visit = (node: Node): void => {
    if (state.mutated) return;
    if (isRead(node) && !isSafeRegExpRead(node, nextChecked)) {
      state.mutated = true;
      return;
    }
    node.forEachChild(visit);
  };
  owner.forEachChild(visit);
  return state.mutated;
}

/** Whether a single reference `read` to a `const` `RegExp` binding is read-only. */
function isSafeRegExpRead(read: Identifier, checked: ReadonlySet<Identifier>): boolean {
  const top = topWrapped(read);
  if (isMutationTarget(top)) return false;
  const { parent } = top;
  if (isVariableDeclaration(parent) && parent.initializer === top) {
    return (
      isConstList(parent.parent) &&
      isIdentifier(parent.name) &&
      !isRegExpMutated(parent.name, checked)
    );
  }
  if (
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === top
  ) {
    return isSafeRegExpMember(parent);
  }
  const call = handedTo(top);
  return call !== undefined && isSafeRegExpArgument(top, call);
}

/** Validates ECMAScript `RegExp` flags (`g` present, unique valid flag letters, not both `u` & `v`). */
function hasValidGlobalFlags(flags: string): boolean {
  if (!flags.includes('g') || (flags.includes('u') && flags.includes('v'))) return false;
  const seen = new Set<string>();
  for (const ch of flags) {
    if (!VALID_REGEXP_FLAGS.has(ch) || seen.has(ch)) return false;
    seen.add(ch);
  }
  return true;
}

/** Evaluates `RegExp(pattern, flags)` / `new RegExp(pattern, flags)`, pushing sub-obligations. */
function checkConstructedRegExp(
  expr: CallExpression | NewExpression,
  visiting: ReadonlySet<Identifier>,
  stack: RegExpObligation[],
): boolean {
  if (globalPathOf(unwrapped(expr.expression))?.join('.') !== 'RegExp') return false;
  const given = expr.arguments ?? [];
  const first = given[0];
  const second = given[1];
  if (
    first === undefined ||
    isSpreadElement(first) ||
    (second !== undefined && isSpreadElement(second))
  ) {
    return false;
  }
  const secondInner = second === undefined ? undefined : unwrapped(second);
  if (
    secondInner === undefined ||
    (isIdentifier(secondInner) && globalPathOf(secondInner)?.join('.') === 'undefined')
  ) {
    stack.push({ expr: first, visiting });
    return true;
  }
  if (isObjectLiteralExpression(unwrapped(first))) return false;
  const foldedFlags = constantValue(secondInner, resolveLocalConst);
  return typeof foldedFlags === 'string' && hasValidGlobalFlags(foldedFlags);
}

/** Evaluates a single `RegExp` obligation item on `stack`. */
function stepGlobalRegExp(item: RegExpObligation, stack: RegExpObligation[]): boolean {
  const value = unwrapped(item.expr);
  if (isConditionalExpression(value)) {
    stack.push(
      { expr: value.whenTrue, visiting: item.visiting },
      { expr: value.whenFalse, visiting: item.visiting },
    );
    return true;
  }
  if (isRegularExpressionLiteral(value)) {
    const slash = value.text.lastIndexOf('/');
    return slash > 0 && value.text.slice(slash + 1).includes('g');
  }
  if (isCallExpression(value) || isNewExpression(value)) {
    return checkConstructedRegExp(value, item.visiting, stack);
  }
  if (isIdentifier(value) && globalPathOf(value) === undefined) {
    const bound = constBindingOf(value);
    if (
      bound === undefined ||
      item.visiting.has(bound.id) ||
      isRegExpMutated(bound.id, new Set())
    ) {
      return false;
    }
    stack.push({ expr: bound.initializer, visiting: new Set([...item.visiting, bound.id]) });
    return true;
  }
  return false;
}

/** Proves `root` evaluates to an unmutated native `RegExp` carrying the `'g'` flag. */
function isGlobalRegExp(root: Expression): boolean {
  const stack: RegExpObligation[] = [{ expr: root, visiting: new Set() }];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    if (!stepGlobalRegExp(item, stack)) return false;
  }
  return true;
}

/** Whether `call` (`str.match(re)` or `re[Symbol.match](str)`) returns a plain `string[] | null`. */
export function isGlobalMatch(
  call: CallExpression,
  callee: PropertyAccessExpression | ElementAccessExpression,
  name: string,
): boolean {
  if (mutatesMatchIntrinsics(call.getSourceFile())) return false;
  if (name === 'Symbol.match') {
    const first = call.arguments[0];
    const safeArg =
      call.arguments.length <= 1 &&
      (first === undefined || (!isSpreadElement(first) && isNullishOrString(first)));
    return safeArg && isGlobalRegExp(callee.expression);
  }
  if (!isNullishOrString(callee.expression)) return false;
  const first = call.arguments[0];
  if (first === undefined || isSpreadElement(first)) return false;
  return isGlobalRegExp(first);
}
