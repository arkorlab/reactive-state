import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrowFunction,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isConditionalExpression,
  isExpressionStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isNonNullExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isTypeAssertion,
  isVoidExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { declarationOf, type Declared, initializerOf } from './framed.ts';
import { instanceMethods, keyOf, memberMethods, ownsThis } from './held-class-methods.ts';
import { answersOf } from './kept.ts';
import { receiverOf, receiverWrite } from './this-aliases.ts';

/**
 * The methods of what a name a module holds once is, where the code writes them, of which a call
 * writes through `this` into what the module keeps between calls (`settled.ts`): `counter.bump()` of
 * `const counter = { n: 0, bump() { return ++this.n; } }`.
 */

/** The logical operators whose result may be either operand: `&&`, `||`, `??`. */
const EITHER: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/**
 * The candidate method bodies `this` is what `name` holds of, by their names, where the code writes
 * them: of the object it is declared of, `const counter = { bump() { … } }`; of a class it is made
 * of there, `new Counter()`; of every object or instance a function of the module answers across
 * its return paths and branches (`answeredMethods`); of a class it is, its own, `static`.
 */
export function methodsOf(name: Identifier): ReadonlyMap<string, readonly Node[]> {
  const methods = new Map<string, Node[]>();
  collectMethods(name, methods, new Set());
  return methods;
}

/** Collects every candidate method map reachable through aliases, branches and factory calls. */
function collectMethods(node: Expression, methods: Map<string, Node[]>, seen: Set<Node>): void {
  const value = unwrapped(node);
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  if (isIdentifier(value)) {
    collectIdentifierMethods(value, methods, seen);
    return;
  }
  if (isConditionalExpression(value)) {
    collectMethods(value.whenTrue, methods, seen);
    collectMethods(value.whenFalse, methods, seen);
    return;
  }
  if (isBinaryExpression(value) && EITHER.has(value.operatorToken.kind)) {
    collectMethods(value.left, methods, seen);
    collectMethods(value.right, methods, seen);
    return;
  }
  if (isCallExpression(value)) {
    answeredMethods(value, methods, seen);
    return;
  }
  const made = instanceMethods(value);
  if (made !== undefined) {
    appendMethods(methods, made);
  } else if (isClassExpression(value)) {
    appendMethods(methods, memberMethods(value, true));
  }
}

/** Follows a declared class or lexical initializer alias when collecting candidate methods. */
function collectIdentifierMethods(
  name: Identifier,
  methods: Map<string, Node[]>,
  seen: Set<Node>,
): void {
  const declared = declarationOf(name);
  if (declared !== undefined && isClassDeclaration(declared)) {
    appendMethods(methods, memberMethods(declared, true));
    return;
  }
  const initializer = initializerOf(name);
  if (initializer !== undefined) {
    collectMethods(initializer, methods, seen);
  }
}

/** Appends one candidate receiver's surviving methods without overwriting earlier branches. */
function appendMethods(target: Map<string, Node[]>, source: ReadonlyMap<string, Node>): void {
  for (const [key, method] of source) {
    const existing = target.get(key);
    if (existing === undefined) {
      target.set(key, [method]);
    } else {
      existing.push(method);
    }
  }
}

/**
 * Collects the methods of each value `call` may answer when calling a function of the module by
 * its name across every return path of that function.
 */
function answeredMethods(
  call: CallExpression,
  methods: Map<string, Node[]>,
  seen: Set<Node>,
): void {
  const callee = unwrapped(call.expression);
  const fn = isIdentifier(callee) ? functionOf(declarationOf(callee)) : undefined;
  if (fn === undefined || seen.has(fn)) {
    return;
  }
  seen.add(fn);
  for (const answer of answersOf(fn)) {
    collectMethods(answer, methods, seen);
  }
}

/** The function `declared` is: one declared so, or a variable's of an arrow or a function. */
function functionOf(declared: Declared | undefined): Node | undefined {
  if (declared === undefined || isClassDeclaration(declared)) {
    return undefined;
  }
  if (isFunctionDeclaration(declared)) {
    return declared;
  }
  const value = declared.initializer === undefined ? undefined : unwrapped(declared.initializer);
  return value !== undefined && (isArrowFunction(value) || isFunctionExpression(value))
    ? value
    : undefined;
}

/**
 * Whether any candidate body of method `name` in `methods`, called, writes through `this` — what
 * `writtenBy` says a node writes into, of `this` — or calls another of them, `this.add(1)`, that
 * does; the functions in it of a `this` of their own passed over.
 */
export function writesThis(
  methods: ReadonlyMap<string, readonly Node[]>,
  name: string,
  writtenBy: (node: Node) => Node | undefined,
  context: { readonly seen: Set<string>; readonly call: CallExpression | undefined },
): boolean {
  const { seen } = context;
  const candidates = methods.get(name);
  if (candidates === undefined || seen.has(name)) {
    return false;
  }
  seen.add(name);
  return candidates.some((method) => candidateWritesThis(method, methods, writtenBy, context));
}

/** Whether a single candidate method body `method` writes through `this` for `context`. */
function candidateWritesThis(
  method: Node,
  methods: ReadonlyMap<string, readonly Node[]>,
  writtenBy: (node: Node) => Node | undefined,
  context: { readonly seen: Set<string>; readonly call: CallExpression | undefined },
): boolean {
  const { seen, call } = context;
  const deferred = deferredBody(method, call);
  let found = false;
  const visit = (node: Node): void => {
    if (found || node === deferred || (node !== method && ownsThis(node))) {
      return;
    }
    const written = writtenBy(node);
    const invocation = isCallExpression(node) ? node : undefined;
    const called =
      invocation === undefined ? undefined : thisCalled(unwrapped(invocation.expression));
    found =
      (written !== undefined && receiverWrite(written, node)) ||
      (called !== undefined && writesThis(methods, called, writtenBy, { seen, call: invocation }));
    if (!found) {
      node.forEachChild(visit);
    }
  };
  visit(method);
  return found;
}

/** Calling a generator acquires an iterator; its body starts only when that iterator is resumed. */
function deferredBody(node: Node, call: CallExpression | undefined): Node | undefined {
  if (call === undefined || !discardedCall(call)) {
    return undefined;
  }
  if (
    (isMethodDeclaration(node) || isFunctionDeclaration(node) || isFunctionExpression(node)) &&
    node.asteriskToken !== undefined
  ) {
    return node.body;
  }
  return undefined;
}

/** A directly discarded iterator result cannot be resumed by its caller. */
function discardedCall(call: CallExpression): boolean {
  let value: Expression = call;
  for (;;) {
    const { parent } = value;
    if (
      isParenthesizedExpression(parent) ||
      isAsExpression(parent) ||
      isNonNullExpression(parent) ||
      isSatisfiesExpression(parent) ||
      isTypeAssertion(parent)
    ) {
      value = parent;
      continue;
    }
    return (
      isExpressionStatement(parent) ||
      isVoidExpression(parent) ||
      (isBinaryExpression(parent) &&
        parent.operatorToken.kind === SyntaxKind.CommaToken &&
        parent.left === value)
    );
  }
}

/** The name of the method of `this` that `callee` reads, `this.add`; none of another. */
function thisCalled(callee: Node): string | undefined {
  return isPropertyAccessExpression(callee) && receiverOf(callee.expression, true)
    ? keyOf(callee.name)
    : undefined;
}
