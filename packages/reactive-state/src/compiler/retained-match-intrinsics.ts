import {
  type ArrayLiteralExpression,
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isIdentifier,
  isNewExpression,
  isOmittedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  type NewExpression,
  type Node,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { readsOf } from './local-module-reads.ts';
import { ASSIGNING, COMPUTING, isPatternTarget, UPDATING } from './local-write-paths.ts';
import {
  constBindingOf,
  GLOBAL_THIS,
  intrinsicPathsOf,
  isMatchIntrinsic,
  isMatchIntrinsicPath,
  isMutationTarget,
  MATCH_CONSTRUCTORS,
  MATCH_PROTOTYPES,
  ownerScopeOf,
  topWrapped,
} from './retained-match-paths.ts';

/**
 * Per-file `String` / `RegExp` intrinsic mutation and escape checks (including spread tuple
 * argument expansion and read-only `Object.*` / `Reflect.*` inspector exemptions).
 */

const INTRINSIC_MUTATED = new WeakMap<SourceFile, boolean>();
const MUTATING_PROTOTYPE_METHODS: ReadonlySet<string> = new Set([
  '__defineGetter__',
  '__defineSetter__',
  'compile',
]);
const MUTATING_OBJECT_GLOBALS: ReadonlySet<string> = new Set([
  'Object.assign',
  'Object.defineProperties',
  'Object.defineProperty',
  'Object.setPrototypeOf',
  'Reflect.defineProperty',
  'Reflect.deleteProperty',
  'Reflect.set',
  'Reflect.setPrototypeOf',
]);
const READONLY_INTRINSIC_INSPECTORS: ReadonlySet<string> = new Set([
  'Object.entries',
  'Object.getOwnPropertyDescriptor',
  'Object.getOwnPropertyDescriptors',
  'Object.getOwnPropertyNames',
  'Object.getOwnPropertySymbols',
  'Object.getPrototypeOf',
  'Object.hasOwn',
  'Object.is',
  'Object.isExtensible',
  'Object.isFrozen',
  'Object.isSealed',
  'Object.keys',
  'Object.values',
  'Reflect.get',
  'Reflect.getOwnPropertyDescriptor',
  'Reflect.getPrototypeOf',
  'Reflect.has',
  'Reflect.isExtensible',
  'Reflect.ownKeys',
]);
const SAFE_CONSTRUCTOR_CALLBACK_METHODS: ReadonlySet<string> = new Set([
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
  'forEach',
  'map',
  'some',
]);

/** Whether a single read `node` of a `const` array binding keeps its elements unmutated. */
function isReadonlyArrayUse(node: Identifier): boolean {
  const top = topWrapped(node);
  if (isMutationTarget(top)) return false;
  const { parent } = top;
  if (isSpreadElement(parent) || parent.kind === SyntaxKind.VoidExpression) return true;
  if (
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === top
  ) {
    const memberTop = topWrapped(parent);
    const memberParent = memberTop.parent;
    return (
      !isMutationTarget(memberTop) &&
      !(isCallExpression(memberParent) && memberParent.expression === memberTop)
    );
  }
  return false;
}

/** Whether `const id = [...]` has no element mutations or mutating method calls in scope. */
function isUnmutatedArrayBinding(id: Identifier): boolean {
  const owner = ownerScopeOf(id);
  const isRead = readsOf(id, owner);
  const state = { safe: true };
  const visit = (node: Node): void => {
    if (!state.safe) return;
    if (isRead(node) && !isReadonlyArrayUse(node)) {
      state.safe = false;
      return;
    }
    node.forEachChild(visit);
  };
  owner.forEachChild(visit);
  return state.safe;
}

/** Resolves `expr` to an `ArrayLiteralExpression` directly or via a `const` binding. */
function resolveSpreadArray(
  expr: Expression,
  seen: ReadonlySet<Identifier>,
  requireUnmutated: boolean,
): ArrayLiteralExpression | undefined {
  const visited = new Set(seen);
  let current = unwrapped(expr);
  for (;;) {
    if (isArrayLiteralExpression(current)) return current;
    if (!isIdentifier(current) || visited.has(current)) return undefined;
    const bound = constBindingOf(current);
    if (bound === undefined || (requireUnmutated && !isUnmutatedArrayBinding(bound.id))) {
      return undefined;
    }
    visited.add(bound.id);
    current = unwrapped(bound.initializer);
  }
}

/** Expands `args` into exact positional arguments when all spreads are closed unmutated tuples. */
function expandPositionalArgs(
  args: readonly Expression[],
  seen: ReadonlySet<Identifier>,
): readonly (Expression | undefined)[] | undefined {
  const out: (Expression | undefined)[] = [];
  for (const arg of args) {
    if (isOmittedExpression(arg)) {
      out.push(undefined);
    } else if (isSpreadElement(arg)) {
      const array = resolveSpreadArray(arg.expression, seen, true);
      if (array === undefined) return undefined;
      const inner = expandPositionalArgs(array.elements, seen);
      if (inner === undefined) return undefined;
      out.push(...inner);
    } else {
      out.push(arg);
    }
  }
  return out;
}

/** Unpacks `arg` (and nested/const array literal elements) into candidate expressions. */
function argumentCandidates(
  arg: Expression,
  seen: ReadonlySet<Identifier> = new Set(),
): readonly Expression[] {
  const raw = unwrapped(isSpreadElement(arg) ? arg.expression : arg);
  const array = resolveSpreadArray(raw, seen, false);
  if (array === undefined) return [raw];
  const nextSeen = isIdentifier(raw) ? new Set([...seen, raw]) : seen;
  const elements: Expression[] = [raw];
  for (const element of array.elements) {
    if (!isOmittedExpression(element)) elements.push(...argumentCandidates(element, nextSeen));
  }
  return elements;
}

/** Whether passing `String` at `argIndex` to `call` is a read-only mapper callback. */
function isSafeConstructorCallback(
  call: CallExpression | NewExpression,
  argIndex: number,
  paths: readonly string[],
): boolean {
  if (argIndex < 0 || !isCallExpression(call) || paths.some((path) => path !== 'String')) {
    return false;
  }
  const callee = unwrapped(call.expression);
  if (globalPathOf(callee)?.join('.') === 'Array.from') return argIndex === 1;
  return (
    argIndex === 0 &&
    isPropertyAccessExpression(callee) &&
    SAFE_CONSTRUCTOR_CALLBACK_METHODS.has(callee.name.text)
  );
}

/** Whether `candidate` exposes `globalThis`, `RegExp`, `String`, or their `.prototype` to `call`. */
function exposesHolderToCall(
  call: CallExpression | NewExpression,
  argIndex: number,
  candidate: Expression,
): boolean {
  const paths = intrinsicPathsOf(candidate, new Set());
  const exposesHolder = paths.some(
    (path) => path === GLOBAL_THIS || MATCH_PROTOTYPES.has(path) || MATCH_CONSTRUCTORS.has(path),
  );
  return exposesHolder && !isSafeConstructorCallback(call, argIndex, paths);
}

/** Candidate expressions that could land in the first (mutated target) slot of `given`. */
function firstSlotCandidates(
  given: readonly Expression[],
  expanded: readonly (Expression | undefined)[] | undefined,
): readonly Expression[] {
  if (expanded !== undefined) {
    return expanded[0] === undefined ? [] : argumentCandidates(expanded[0]);
  }
  const candidates: Expression[] = [];
  for (const arg of given) {
    candidates.push(...argumentCandidates(arg));
    if (!isSpreadElement(arg)) break;
  }
  return candidates;
}

/** Whether a `READONLY_INTRINSIC_INSPECTORS` call can leak a match intrinsic (only `Reflect.get`). */
function isLeakyInspectorCall(
  call: CallExpression,
  calleePath: string,
  expanded: readonly (Expression | undefined)[] | undefined,
): boolean {
  if (calleePath !== 'Reflect.get') return false;
  if (expanded === undefined) return true;
  const receiver = expanded[2];
  return (
    receiver !== undefined &&
    argumentCandidates(receiver).some((each) => exposesHolderToCall(call, 2, each))
  );
}

/** Whether any argument handed to an unknown `call` exposes a match intrinsic holder. */
function exposesAnyCallArgument(
  call: CallExpression | NewExpression,
  given: readonly Expression[],
  expanded: readonly (Expression | undefined)[] | undefined,
): boolean {
  if (expanded !== undefined) {
    return expanded.some((arg, index) => {
      return (
        arg !== undefined &&
        argumentCandidates(arg).some((each) => exposesHolderToCall(call, index, each))
      );
    });
  }
  let sawSpread = false;
  for (const [index, arg] of given.entries()) {
    if (isSpreadElement(arg)) sawSpread = true;
    const slot = sawSpread ? -1 : index;
    if (argumentCandidates(arg).some((each) => exposesHolderToCall(call, slot, each))) return true;
  }
  return false;
}

/** Whether `call` mutates or leaks a match intrinsic via its callee or arguments. */
function isIntrinsicMutatingCall(call: CallExpression | NewExpression): boolean {
  const callee = unwrapped(call.expression);
  const calleePath = globalPathOf(callee)?.join('.');
  const given = call.arguments ?? [];
  const expanded = expandPositionalArgs(given, new Set());
  if (
    calleePath !== undefined &&
    MUTATING_OBJECT_GLOBALS.has(calleePath) &&
    firstSlotCandidates(given, expanded).some((candidate) => isMatchIntrinsic(candidate))
  ) {
    return true;
  }
  if (
    isCallExpression(call) &&
    intrinsicPathsOf(callee, new Set()).some((path) => {
      const tail = path.split('.').at(-1) ?? '';
      return isMatchIntrinsicPath(path) && MUTATING_PROTOTYPE_METHODS.has(tail);
    })
  ) {
    return true;
  }
  if (
    calleePath !== undefined &&
    READONLY_INTRINSIC_INSPECTORS.has(calleePath) &&
    isCallExpression(call)
  ) {
    return isLeakyInspectorCall(call, calleePath, expanded);
  }
  return exposesAnyCallArgument(call, given, expanded);
}

/** Whether `node` directly mutates or hands off `RegExp` / `String` or their prototypes. */
function isIntrinsicMutationNode(node: Node): boolean {
  if (isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    return (ASSIGNING.has(kind) || COMPUTING.has(kind)) && isMatchIntrinsic(node.left);
  }
  if (isDeleteExpression(node)) return isMatchIntrinsic(node.expression);
  if (
    (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)) &&
    UPDATING.has(node.operator)
  ) {
    return isMatchIntrinsic(node.operand);
  }
  if (
    (isPropertyAccessExpression(node) || isElementAccessExpression(node)) &&
    isPatternTarget(node)
  ) {
    return isMatchIntrinsic(node);
  }
  return (isCallExpression(node) || isNewExpression(node)) && isIntrinsicMutatingCall(node);
}

/** Cached per-`SourceFile` check that neither `RegExp` nor `String` prototypes are mutated. */
export function mutatesMatchIntrinsics(file: SourceFile): boolean {
  const cached = INTRINSIC_MUTATED.get(file);
  if (cached !== undefined) return cached;
  const state = { mutated: false };
  const visit = (node: Node): void => {
    if (state.mutated) return;
    if (isIntrinsicMutationNode(node)) {
      state.mutated = true;
      return;
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  INTRINSIC_MUTATED.set(file, state.mutated);
  return state.mutated;
}
