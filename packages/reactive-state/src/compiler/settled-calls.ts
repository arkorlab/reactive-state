import {
  type BinaryExpression,
  type CallExpression,
  type ClassLikeDeclaration,
  type ConstructorDeclaration,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isClassStaticBlockDeclaration,
  isConditionalExpression,
  isConstructorDeclaration,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isSetAccessorDeclaration,
  isSpreadElement,
  isVariableDeclaration,
  isVoidExpression,
  type NewExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, isAnswering, overloadsOf } from './answers.ts';
import { globalPathOf } from './code-globals.ts';
import { declarationOf, initializerOf } from './framed.ts';
import { metadataInvocation } from './input-callees.ts';
import { readsOf } from './local-module-reads.ts';
import { constantValue } from './numbers.ts';
import { platformInitializer } from './platform-inputs.ts';
import { peelPlatform, platformPathsOf, sourceFunction } from './platform-uses.ts';
import { isTypeOnly } from './scope.ts';
import {
  methodsAtExpressionPath,
  receiverMemberPath,
  resolveLocalClass,
} from './settled-receivers.ts';
import { receiverWrite } from './this-aliases.ts';
import { writtenBy } from './written.ts';

/** Callable or constructor declaration carrying parameters and an executable body. */
export type LocalInvocable = Answering | ConstructorDeclaration;

/** Normalized call argument entry tracking whether the argument was unpacked as a spread. */
export interface CallArgumentSlot {
  readonly expr: Expression;
  readonly spread: boolean;
}

/** Resolved local callable targets, normalized argument slots, and optional explicit `this` receiver. */
export interface ResolvedInvocation {
  readonly args: readonly CallArgumentSlot[];
  readonly callees: readonly LocalInvocable[];
  readonly thisArg?: Expression | undefined;
}

/** Binary operators that forward one of their operand expressions. */
const VALUE_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/** Array mutator methods whose arguments populate elements of the receiver array. */
const ARRAY_ELEMENT_MUTATORS: ReadonlySet<string> = new Set(['fill', 'push', 'unshift']);

/** Starting index of inserted elements in `array.splice(start, deleteCount, ...items)`. */
const SPLICE_ITEMS_START = 2;

/** Resolves direct, constructed, `.call`, `.apply`, `.bind`, or `Reflect.apply` invocations. */
export function resolveInvocation(
  node: CallExpression | NewExpression,
): ResolvedInvocation | undefined {
  if (isNewExpression(node)) {
    const cls = resolveLocalClass(node.expression);
    const ctor = cls === undefined ? undefined : declaredConstructorOf(cls);
    return ctor === undefined
      ? undefined
      : { args: unpackTupleSpreads(node.arguments ?? []), callees: [ctor] };
  }
  const meta = metadataInvocation(node);
  if (meta !== undefined && isAnswering(meta.callee)) {
    const callees = executableOverloads(meta.callee);
    return callees.length === 0
      ? undefined
      : { args: meta.given.map((expr) => ({ expr, spread: false })), callees };
  }
  const direct = sourceFunction(node.expression);
  if (direct !== undefined) {
    const callees = executableOverloads(direct);
    return callees.length === 0 ? undefined : { args: unpackTupleSpreads(node.arguments), callees };
  }
  if (platformPathsOf(node.expression).includes('Reflect.apply')) {
    return resolveReflectApply(node);
  }
  return resolveBorrowedOrBoundCall(node);
}

/** Whether executing `callee` writes through `this` (or a local constant alias of `this`). */
export function calleeMutatesThis(callee: LocalInvocable): boolean {
  let mutated = false;
  const visit = (node: Node): void => {
    if (mutated || isTypeOnly(node) || (node !== callee && bindsOwnThis(node))) {
      return;
    }
    const written = writtenBy(node);
    if (written !== undefined && receiverWrite(written, node)) {
      mutated = true;
      return;
    }
    node.forEachChild(visit);
  };
  visit(callee);
  return mutated;
}

/** Whether `node` introduces its own `this` binding distinct from an enclosing function. */
function bindsOwnThis(node: Node): boolean {
  return (
    isFunctionDeclaration(node) ||
    isFunctionExpression(node) ||
    isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node) ||
    isConstructorDeclaration(node) ||
    isClassStaticBlockDeclaration(node)
  );
}

/** Resolves `Reflect.apply(target, thisArg, argumentsList)` against local callable declarations. */
function resolveReflectApply(call: CallExpression): ResolvedInvocation | undefined {
  const [targetSlot, thisSlot, argsSlot] = unpackTupleSpreads(call.arguments);
  if (targetSlot === undefined || targetSlot.spread) {
    return undefined;
  }
  const callees = callableTargetsOf(targetSlot.expr);
  if (callees.length === 0) {
    return undefined;
  }
  const thisArg = thisSlot === undefined || thisSlot.spread ? undefined : thisSlot.expr;
  const args = argsSlot?.spread === true ? [argsSlot] : unpackApplySlots(argsSlot?.expr);
  return { args, callees, thisArg };
}

/** Resolves `<fn>.call(...)`, `<fn>.apply(...)`, and `<fn>.bind(...)(...)` invocations. */
function resolveBorrowedOrBoundCall(call: CallExpression): ResolvedInvocation | undefined {
  const bound = resolveBoundInvocation(call);
  if (bound !== undefined) {
    return bound;
  }
  const callee = peelPlatform(call.expression);
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) {
    return undefined;
  }
  const key = isPropertyAccessExpression(callee)
    ? callee.name.text
    : staticElementKey(callee.argumentExpression);
  if (key !== 'call' && key !== 'apply') {
    return undefined;
  }
  const callees = callableTargetsOf(callee.expression);
  if (callees.length === 0) {
    return undefined;
  }
  const slots = unpackTupleSpreads(call.arguments);
  const [firstSlot, secondSlot] = slots;
  if (firstSlot?.spread === true) {
    return { args: slots, callees, thisArg: firstSlot.expr };
  }
  if (key === 'call') {
    return { args: slots.slice(1), callees, thisArg: firstSlot?.expr };
  }
  const args = secondSlot?.spread === true ? [secondSlot] : unpackApplySlots(secondSlot?.expr);
  return { args, callees, thisArg: firstSlot?.expr };
}

/** Resolves `<fn>.bind(thisArg, ...boundArgs)(...callArgs)` (inline or through an immutable alias). */
function resolveBoundInvocation(call: CallExpression): ResolvedInvocation | undefined {
  let expr = peelPlatform(call.expression);
  const seen = new Set<Expression>();
  while (isIdentifier(expr) && !seen.has(expr)) {
    seen.add(expr);
    const init = initializerOf(expr);
    if (init === undefined) {
      break;
    }
    expr = peelPlatform(init);
  }
  if (!isCallExpression(expr)) {
    return undefined;
  }
  const bindCallee = peelPlatform(expr.expression);
  if (!isPropertyAccessExpression(bindCallee) && !isElementAccessExpression(bindCallee)) {
    return undefined;
  }
  const key = isPropertyAccessExpression(bindCallee)
    ? bindCallee.name.text
    : staticElementKey(bindCallee.argumentExpression);
  if (key !== 'bind') {
    return undefined;
  }
  const callees = callableTargetsOf(bindCallee.expression);
  if (callees.length === 0) {
    return undefined;
  }
  const boundSlots = unpackTupleSpreads(expr.arguments);
  const [firstSlot] = boundSlots;
  const prefix = firstSlot?.spread === true ? boundSlots : boundSlots.slice(1);
  return {
    args: [...prefix, ...unpackTupleSpreads(call.arguments)],
    callees,
    thisArg: firstSlot?.expr,
  };
}

/** Resolves local source functions or receiver methods referenced by `target`. */
function callableTargetsOf(target: Expression): readonly LocalInvocable[] {
  const fn = sourceFunction(target);
  if (fn !== undefined) {
    return executableOverloads(fn);
  }
  const clean = peelPlatform(target);
  if (!isPropertyAccessExpression(clean) && !isElementAccessExpression(clean)) {
    return [];
  }
  const key = isPropertyAccessExpression(clean)
    ? clean.name.text
    : staticElementKey(clean.argumentExpression);
  const path = key === undefined ? undefined : receiverMemberPath(clean.expression);
  if (key === undefined || path === undefined) {
    return [];
  }
  const found: LocalInvocable[] = [];
  for (const map of methodsAtExpressionPath(path.root, path.steps)) {
    const candidates = map.get(key);
    if (candidates === undefined) {
      continue;
    }
    for (const method of candidates) {
      if (isAnswering(method)) {
        found.push(...executableOverloads(method));
      }
    }
  }
  return found;
}

/** Filters overload declarations of `fn` down to implementations carrying a body. */
function executableOverloads(fn: Answering): readonly LocalInvocable[] {
  return overloadsOf(fn).filter((each) => each.body !== undefined);
}

/** Finds a constructor with an implementation body on `declared`, if any. */
function declaredConstructorOf(declared: ClassLikeDeclaration): ConstructorDeclaration | undefined {
  for (const member of declared.members) {
    if (isConstructorDeclaration(member) && member.body !== undefined) {
      return member;
    }
  }
  return undefined;
}

/** Expands inline array-literal spreads in `rawArgs` into `CallArgumentSlot` entries. */
function unpackTupleSpreads(rawArgs: readonly Expression[]): readonly CallArgumentSlot[] {
  const slots: CallArgumentSlot[] = [];
  for (const arg of rawArgs) {
    if (!isSpreadElement(arg)) {
      slots.push({ expr: arg, spread: false });
      continue;
    }
    const inner = peelPlatform(arg.expression);
    if (isArrayLiteralExpression(inner)) {
      slots.push(...unpackTupleSpreads(inner.elements));
    } else {
      slots.push({ expr: arg.expression, spread: true });
    }
  }
  return slots;
}

/** Unpacks an `apply` arguments list expression into positional or conservative spread slots. */
function unpackApplySlots(argsExpr: Expression | undefined): readonly CallArgumentSlot[] {
  if (argsExpr === undefined) {
    return [];
  }
  const clean = peelPlatform(argsExpr);
  if (
    clean.kind === SyntaxKind.NullKeyword ||
    isVoidExpression(clean) ||
    globalPathOf(clean)?.join('.') === 'undefined'
  ) {
    return [];
  }
  if (isArrayLiteralExpression(clean)) {
    return unpackTupleSpreads(clean.elements);
  }
  return collectDynamicApplyExpressions(clean).map((expr) => ({ expr, spread: true }));
}

/** Collects candidate argument expressions reachable from a non-literal `apply` argument list. */
function collectDynamicApplyExpressions(start: Expression): readonly Expression[] {
  const results: Expression[] = [start];
  const pending: Expression[] = [start];
  const seen = new Set<Node>();
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const clean = peelPlatform(current);
    if (seen.has(clean)) {
      continue;
    }
    seen.add(clean);
    results.push(clean);
    enqueueDynamicApplyChildren(clean, pending);
  }
  return results;
}

/** Enqueues branch, array element, and local variable write sources for `clean`. */
function enqueueDynamicApplyChildren(clean: Expression, pending: Expression[]): void {
  if (isConditionalExpression(clean)) {
    pending.push(clean.whenTrue, clean.whenFalse);
    return;
  }
  if (isBinaryExpression(clean)) {
    enqueueBinaryApplyChildren(clean, pending);
    return;
  }
  if (isArrayLiteralExpression(clean)) {
    for (const el of clean.elements) {
      if (!isOmittedExpression(el)) {
        pending.push(isSpreadElement(el) ? el.expression : el);
      }
    }
    return;
  }
  if (isIdentifier(clean)) {
    enqueueVariableArraySources(clean, pending);
  }
}

/** Enqueues operand sources of comma or short-circuiting binary expressions. */
function enqueueBinaryApplyChildren(clean: BinaryExpression, pending: Expression[]): void {
  if (clean.operatorToken.kind === SyntaxKind.CommaToken) {
    pending.push(clean.right);
  } else if (VALUE_OPERATORS.has(clean.operatorToken.kind)) {
    pending.push(clean.left, clean.right);
  }
}

/** Enqueues initializer, element assignment, and array mutator sources written to `id`. */
function enqueueVariableArraySources(id: Identifier, pending: Expression[]): void {
  const declared = declarationOf(id);
  if (declared === undefined || !isVariableDeclaration(declared) || !isIdentifier(declared.name)) {
    return;
  }
  if (declared.initializer !== undefined) {
    pending.push(declared.initializer);
  }
  const sourceFile = declared.getSourceFile();
  const isRead = readsOf(declared.name, sourceFile);
  const visit = (node: Node): void => {
    if (isTypeOnly(node)) {
      return;
    }
    if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken) {
      const target = peelPlatform(node.left);
      if (
        (isIdentifier(target) && isRead(target)) ||
        (isElementAccessExpression(target) &&
          isIdentifier(peelPlatform(target.expression)) &&
          isRead(peelPlatform(target.expression)))
      ) {
        pending.push(node.right);
      }
    } else if (isCallExpression(node)) {
      enqueueMutatorSourcesOnArray(node, isRead, pending);
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
}

/** Enqueues arguments pushed, unshifted, filled, or spliced into an array read by `isRead`. */
function enqueueMutatorSourcesOnArray(
  call: CallExpression,
  isRead: (node: Node) => node is Identifier,
  pending: Expression[],
): void {
  const callee = peelPlatform(call.expression);
  if (!isPropertyAccessExpression(callee)) {
    return;
  }
  const receiver = peelPlatform(callee.expression);
  if (!isIdentifier(receiver) || !isRead(receiver)) {
    return;
  }
  for (const item of mutatorInsertedArguments(call, callee.name.text)) {
    pending.push(isSpreadElement(item) ? item.expression : item);
  }
}

/** Returns arguments inserted as elements into an array by `method`. */
function mutatorInsertedArguments(call: CallExpression, method: string): readonly Expression[] {
  if (ARRAY_ELEMENT_MUTATORS.has(method)) {
    return call.arguments;
  }
  return method === 'splice' ? call.arguments.slice(SPLICE_ITEMS_START) : [];
}

/** Evaluates a constant string or number key expression. */
function staticElementKey(expr: Expression): string | undefined {
  const value = constantValue(expr, (id) => platformInitializer(id, id));
  return value === undefined ? undefined : String(value);
}
