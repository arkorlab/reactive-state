import {
  type ArrayLiteralExpression,
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isCallExpression,
  isElementAccessExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isSpreadElement,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedQuietPrimitive } from './framed-native-evaluation.ts';
import {
  MIDDLEWARE_ARRAY_SELECTORS,
  type middlewareArrayCopiedOrigins,
  middlewareArraySource,
  middlewareCopyAt,
  middlewareLiteralMember,
  middlewareReplacedNativeSelection,
} from './middleware-array-elements.ts';
import type { middlewareArrayIteratorOrigin } from './middleware-array-iterators.ts';
import {
  middlewareReplacedReceiverSelector,
  middlewareStableSelectorCall,
} from './middleware-array-selector-guards.ts';

/** Resolves `.at(...)` reads on inner arrays projected through shallow-copied outer collections. */

export type CopiedCollectionOrigin =
  | ReturnType<typeof middlewareArrayCopiedOrigins>[number]
  | NonNullable<ReturnType<typeof middlewareArrayIteratorOrigin>>;

export interface EnumeratedSelection {
  readonly keys: readonly string[];
  readonly of: Expression;
  readonly quiet: boolean;
  readonly tail?: readonly string[] | undefined;
  readonly whole?: boolean | undefined;
}

export interface NestedCopyAtHandlers {
  readonly projectCall: (
    call: CallExpression,
    keys: readonly string[],
  ) => { readonly keys: readonly string[]; readonly of: Expression } | undefined;
  readonly resolveEnumeration: (target: Expression) => EnumeratedSelection | undefined;
  readonly resolveOrigins?: ((target: Expression) => readonly CopiedCollectionOrigin[]) | undefined;
}

interface UnwrappedNestedAt {
  readonly afterKeys: readonly string[];
  readonly borrowed: boolean;
  readonly call: CallExpression;
  readonly index: number;
  readonly receiver: Expression;
}

interface WholeOriginTarget {
  readonly keys: readonly string[];
  readonly of: Expression;
  readonly tail?: readonly string[] | undefined;
}

/** Projects `copy[i].at(k)` onto the inner literal array or invalidates stale negative offsets on mutation. */
export function nestedCopiedAtEnumeration(
  expression: Expression,
  handlers: NestedCopyAtHandlers,
): EnumeratedSelection | undefined {
  const parsed = unwrapNestedAt(expression);
  if (parsed === undefined) return undefined;
  const inner = handlers.resolveEnumeration(parsed.receiver);
  if (inner === undefined) return undefined;
  if (inner.whole === true) {
    return replacedWholeAt(parsed, inner, handlers.resolveEnumeration)
      ? undefined
      : { keys: inner.keys, of: inner.of, quiet: false, whole: true };
  }
  const innerArray = literalArrayAtKeys(inner.of, inner.keys, handlers.resolveEnumeration);
  if (innerArray === undefined) return undefined;
  if (replacedInnerAt(parsed, innerArray, handlers.resolveEnumeration)) return undefined;
  if (!stableInnerArray(parsed, handlers)) {
    return { keys: inner.keys, of: inner.of, quiet: false, whole: true };
  }
  const position = parsed.index < 0 ? innerArray.elements.length + parsed.index : parsed.index;
  if (position < 0 || position >= innerArray.elements.length) return undefined;
  return {
    keys: [...inner.keys, String(position), ...parsed.afterKeys],
    of: inner.of,
    quiet: false,
  };
}

/** Projects `copy[i].at(k)` across retained collection copy origins (`with`, `map`, `concat`, `toSpliced`). */
export function nestedCopiedAtOrigins(
  expression: Expression,
  handlers: NestedCopyAtHandlers,
): readonly CopiedCollectionOrigin[] {
  const parsed = unwrapNestedAt(expression);
  if (parsed === undefined || handlers.resolveOrigins === undefined) return [];
  const origins = handlers.resolveOrigins(parsed.receiver);
  if (origins.length === 0) return [];
  const projected: CopiedCollectionOrigin[] = [];
  for (const origin of origins) {
    const next = projectNestedOrigin(parsed, origin, handlers);
    if (next !== undefined) projected.push(next);
  }
  return projected;
}

/** Projects or conservatively retains one `CopiedCollectionOrigin` across an inner `.at(...)` read. */
function projectNestedOrigin(
  parsed: UnwrappedNestedAt,
  origin: CopiedCollectionOrigin,
  handlers: NestedCopyAtHandlers,
): CopiedCollectionOrigin | undefined {
  if (origin.whole === true) {
    return replacedWholeAt(parsed, origin, handlers.resolveEnumeration)
      ? undefined
      : { ...origin, whole: true };
  }
  const innerArray = literalArrayAtKeys(origin.of, origin.keys, handlers.resolveEnumeration);
  if (
    innerArray !== undefined &&
    replacedInnerAt(parsed, innerArray, handlers.resolveEnumeration)
  ) {
    return undefined;
  }
  if (innerArray === undefined || !stableInnerArray(parsed, handlers)) {
    return { ...origin, whole: true };
  }
  const position = parsed.index < 0 ? innerArray.elements.length + parsed.index : parsed.index;
  if (position < 0 || position >= innerArray.elements.length) return undefined;
  const step = String(position);
  return {
    ...origin,
    keys: [...origin.keys, step, ...parsed.afterKeys],
    tail: [...origin.tail, step, ...parsed.afterKeys],
  };
}

/** Peels quiet trailing member accesses off an outer native `.at(index)` call. */
function unwrapNestedAt(expression: Expression): UnwrappedNestedAt | undefined {
  const afterKeys: string[] = [];
  let current = unwrapped(expression);
  while (isPropertyAccessExpression(current) || isElementAccessExpression(current)) {
    if (isElementAccessExpression(current) && !framedQuietPrimitive(current.argumentExpression)) {
      return undefined;
    }
    const key = frameMemberName(current);
    if (key === undefined) return undefined;
    afterKeys.unshift(key);
    current = unwrapped(current.expression);
  }
  if (!isCallExpression(current)) return undefined;
  const selected = middlewareCopyAt(current);
  if (selected === undefined) return undefined;
  return {
    afterKeys,
    borrowed: selected.borrowed,
    call: current,
    index: Number(selected.key),
    receiver: selected.of,
  };
}

/** Resolves `(root, keys)` to a spread-free `ArrayLiteralExpression` when statically known. */
function literalArrayAtKeys(
  root: Expression,
  keys: readonly string[],
  resolveEnumeration: (target: Expression) => EnumeratedSelection | undefined,
): ArrayLiteralExpression | undefined {
  let current: Expression | undefined = resolveSource(root, resolveEnumeration);
  for (const key of keys) {
    if (current === undefined) return undefined;
    const member = middlewareLiteralMember(current, key);
    current = member === undefined ? undefined : resolveSource(member, resolveEnumeration);
  }
  if (
    current === undefined ||
    !isArrayLiteralExpression(current) ||
    current.elements.some((element) => isSpreadElement(element))
  ) {
    return undefined;
  }
  return current;
}

/** Resolves direct or exact shallow-copied literal containers for receiver alias matching. */
function resolveSource(
  expression: Expression,
  resolveEnumeration: (target: Expression) => EnumeratedSelection | undefined,
): Expression | undefined {
  const direct = middlewareArraySource(expression);
  if (direct !== undefined) return direct;
  const enumerated = resolveEnumeration(expression);
  if (enumerated === undefined || enumerated.whole === true) return undefined;
  let current = middlewareArraySource(enumerated.of);
  for (const key of enumerated.keys) {
    if (current === undefined) return undefined;
    const member = middlewareLiteralMember(current, key);
    current = member === undefined ? undefined : middlewareArraySource(member);
  }
  return current;
}

/** Rejects non-borrowed `.at` calls when either the copied slot or inner array owns an `.at` override. */
function replacedInnerAt(
  parsed: UnwrappedNestedAt,
  innerArray: ArrayLiteralExpression,
  resolveEnumeration: (target: Expression) => EnumeratedSelection | undefined,
): boolean {
  if (parsed.borrowed) return false;
  const context = {
    memberOf: middlewareLiteralMember,
    sourceOf: (target: Expression) => resolveSource(target, resolveEnumeration),
  };
  return (
    middlewareReplacedReceiverSelector(parsed.call, parsed.receiver, 'at', context) ||
    middlewareReplacedReceiverSelector(parsed.call, innerArray, 'at', context)
  );
}

/** Rejects non-borrowed `.at` calls on whole-collection fallbacks when any candidate element overrides `.at`. */
function replacedWholeAt(
  parsed: UnwrappedNestedAt,
  target: WholeOriginTarget,
  resolveEnumeration: (value: Expression) => EnumeratedSelection | undefined,
): boolean {
  if (parsed.borrowed) return false;
  const context = {
    memberOf: middlewareLiteralMember,
    sourceOf: (value: Expression) => resolveSource(value, resolveEnumeration),
  };
  if (middlewareReplacedReceiverSelector(parsed.call, parsed.receiver, 'at', context)) return true;
  if (target.tail === undefined) return false;
  const outerArray = literalArrayAtKeys(target.of, target.keys, resolveEnumeration);
  if (outerArray === undefined) return false;
  for (const element of outerArray.elements) {
    if (isOmittedExpression(element) || isSpreadElement(element)) continue;
    const candidate =
      literalArrayAtKeys(element, target.tail, resolveEnumeration) ??
      (target.tail.length === 0 ? element : undefined);
    if (
      candidate !== undefined &&
      middlewareReplacedReceiverSelector(parsed.call, candidate, 'at', context)
    ) {
      return true;
    }
  }
  return false;
}

/** Verifies neither the copied slot expression nor the shared inner literal array can change length. */
function stableInnerArray(parsed: UnwrappedNestedAt, handlers: NestedCopyAtHandlers): boolean {
  return middlewareStableSelectorCall(parsed.call, parsed.receiver, {
    memberOf: middlewareLiteralMember,
    projectCall: handlers.projectCall,
    replacedGlobal: middlewareReplacedNativeSelection,
    selectors: MIDDLEWARE_ARRAY_SELECTORS,
    sourceOf: (target: Expression) => resolveSource(target, handlers.resolveEnumeration),
  });
}
