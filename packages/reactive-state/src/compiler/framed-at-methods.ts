import {
  type Expression,
  type ExpressionWithTypeArguments,
  type Identifier,
  type ObjectLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isBlock,
  isClassDeclaration,
  isClassExpression,
  isClassStaticBlockDeclaration,
  isComputedPropertyName,
  isConditionalExpression,
  isConstructorDeclaration,
  isDecorator,
  isElementAccessExpression,
  isExpressionStatement,
  isExpressionWithTypeArguments,
  isHeritageClause,
  isIdentifier,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isReturnStatement,
  isSetAccessorDeclaration,
  isSpreadAssignment,
  isVariableDeclaration,
  isVariableStatement,
  type MethodDeclaration,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, answersLater, isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { frameDeclarationOf, frameMemberName } from './framed-bindings.ts';
import { iteratorQuietValues } from './framed-iterator-guards.ts';
import { framedCondition } from './framed-sources.ts';
import { framedWrittenTargets } from './framed-written-targets.ts';
import { constantValue } from './numbers.ts';
import { isTypeOnly } from './scope.ts';

/** Result-sensitive selectors inspect only source-proven synchronous own method bodies. */

type MethodValue = Expression | MethodDeclaration;

interface FunctionReading {
  readonly node: Node;
  readonly seen: ReadonlySet<Node>;
}

interface ReceiverReading {
  readonly node: Node;
  readonly nested: boolean;
  readonly own: boolean;
  /** Whether `this` is the receiver around the nearest class, where its decorators run. */
  readonly around: boolean;
}

/** Whether a method value names only source-written callables rather than a native implementation. */
export function framedOwnMethod(value: MethodValue): boolean {
  return writtenFunctions(value) !== undefined;
}

/**
 * Whether a source-written method may look a method up on its receiver as it runs, after the call's
 * arguments: its own `this`, or a closure's name for the receiver, put to any use but the value the
 * method returns. A nested function or class may run later, so a use inside one always counts.
 */
export function framedReceiverDispatch(
  value: MethodValue,
  receiver: (node: Identifier) => boolean,
): boolean {
  return writtenFunctions(value)?.some((fn) => receiverUsed(fn, receiver)) === true;
}

/**
 * An arrow has no `this` of its own; a nested function, accessor, constructor, class field or
 * static block binds a new one (`bindsThis`), but for its computed name, which runs outside it. A
 * class binds none: its heritage and its members' names read the enclosing `this`, and only its
 * members' bodies have their own. Every decorator in a class — of the class, a member or a
 * parameter, as TypeScript's legacy ones are — runs as the class is defined, around it.
 */
function receiverUsed(fn: Answering, receiver: (node: Identifier) => boolean): boolean {
  const self = !isArrowFunction(fn);
  const pending: ReceiverReading[] = [{ node: fn, nested: false, own: self, around: self }];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const { node, nested, own } = at;
    if (isTypeOnly(node)) continue;
    const used =
      (own && node.kind === SyntaxKind.ThisKeyword) || (isIdentifier(node) && receiver(node));
    if (used && (nested || !returnedBy(node, fn))) return true;
    pending.push(...childReadings(at, fn));
  }
  return false;
}

/**
 * How a node's children read `this`: inside a nested function or class, where a use always counts;
 * as their own where the node binds one, but for its computed name; and a decorator as the scope
 * around its class does.
 */
function childReadings(at: ReceiverReading, fn: Answering): readonly ReceiverReading[] {
  const { node, nested, own } = at;
  const inner =
    node !== fn &&
    (isAnswering(node) ||
      isSetAccessorDeclaration(node) ||
      isClassDeclaration(node) ||
      isClassExpression(node));
  const binds = node !== fn && bindsThis(node);
  const around = isClassDeclaration(node) || isClassExpression(node) ? own : at.around;
  return evaluatedChildren(node).map((child) => {
    const scoped = own && (!binds || isComputedPropertyName(child));
    return {
      node: child,
      nested: nested || inner,
      own: isDecorator(child) ? around : scoped,
      around,
    };
  });
}

/**
 * What has a `this` of its own: a function but an arrow, an accessor, a constructor, a class's
 * field or its static block.
 */
function bindsThis(node: Node): boolean {
  return (
    (isAnswering(node) && !isArrowFunction(node)) ||
    isSetAccessorDeclaration(node) ||
    isConstructorDeclaration(node) ||
    isPropertyDeclaration(node) ||
    isClassStaticBlockDeclaration(node)
  );
}

/**
 * A node's children as they run: a class's `extends` entry and an instantiation expression, which
 * TypeScript counts among the type nodes, by the expression they evaluate (`evaluatedEntry`).
 */
function evaluatedChildren(node: Node): readonly Node[] {
  const children: Node[] = [];
  node.forEachChild((child) => {
    children.push(
      isExpressionWithTypeArguments(child) && evaluatedEntry(child) ? child.expression : child,
    );
  });
  return children;
}

/**
 * Whether an entry TypeScript writes as an ExpressionWithTypeArguments runs its expression: an
 * instantiation expression, `f<T>`, and a class's `extends` entry do; an `implements` entry and an
 * interface's base run nothing, whichever node an AST writes them as, and stay types.
 */
function evaluatedEntry(entry: ExpressionWithTypeArguments): boolean {
  const clause = entry.parent;
  if (!isHeritageClause(clause)) return true;
  return clause.token === SyntaxKind.ExtendsKeyword && !isInterfaceDeclaration(clause.parent);
}

/** A value the method itself returns: a return statement's, or an arrow's expression body. */
function returnedBy(node: Node, fn: Answering): boolean {
  const { parent } = useOf(node);
  return isReturnStatement(parent) || (parent === fn && isArrowFunction(fn));
}

/** A source-written at override's direct result, without treating it as the native selector. */
export function framedAtMethod(
  value: MethodValue | undefined,
  error: (value: Expression) => boolean,
): boolean | undefined {
  if (value === undefined) return undefined;
  const functions = writtenFunctions(value);
  if (functions === undefined) return undefined;
  let unknown = false;
  for (const fn of functions) {
    const result = methodResult(fn, error);
    if (result === true) return true;
    if (result === undefined) unknown = true;
  }
  return unknown ? undefined : false;
}

/** A synchronous expression body or direct return, with no arbitrary control-flow inference. */
function methodResult(fn: Answering, error: (value: Expression) => boolean): boolean | undefined {
  if (answersLater(fn) || fn.body === undefined) return undefined;
  if (!isBlock(fn.body)) return returnedError(fn.body, error);
  for (const statement of fn.body.statements) {
    if (isReturnStatement(statement))
      return statement.expression !== undefined && returnedError(statement.expression, error);
    if (
      (isVariableStatement(statement) &&
        /^const\s/u.test(statement.declarationList.getText(statement.getSourceFile()))) ||
      quietStatement(statement)
    )
      continue;
    return undefined;
  }
  return false;
}

/**
 * An expression statement that runs no application code: a quiet value, or a quiet value written
 * to a name, whose later read the return's own reading follows.
 */
function quietStatement(statement: Node): boolean {
  if (!isExpressionStatement(statement)) return false;
  const value = unwrapped(statement.expression);
  const written =
    isBinaryExpression(value) &&
    value.operatorToken.kind === SyntaxKind.EqualsToken &&
    isIdentifier(unwrapped(value.left));
  return iteratorQuietValues([written ? value.right : value]);
}

/** A proven own callable keeps its original lexical declaration through const aliases. */
function writtenFunctions(value: MethodValue): readonly Answering[] | undefined {
  const node = isMethodDeclaration(value) ? value : unwrapped(value);
  const pending: FunctionReading[] = [{ node, seen: new Set<Node>() }];
  const found = new Set<Answering>();
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (at.seen.has(at.node)) return undefined;
    if (isAnswering(at.node)) {
      found.add(at.node);
      continue;
    }
    const next = nextFunctions(at.node);
    if (next === undefined) return undefined;
    const seen = new Set([...at.seen, at.node]);
    pending.push(...next.map((each) => ({ node: each, seen })));
  }
  return [...found];
}

/** Written constant branch conditions select only the implementation that can be returned. */
function nextFunctions(value: Node): readonly Node[] | undefined {
  if (isConditionalExpression(value)) {
    const condition = framedCondition(value.condition);
    return condition === undefined
      ? [value.whenTrue, value.whenFalse]
      : [condition ? value.whenTrue : value.whenFalse];
  }
  const next = nextFunction(value);
  return next === undefined ? undefined : [next];
}

/** A lexical declaration or literal member contributes one next source-written callable. */
function nextFunction(value: Node): Node | undefined {
  if (isIdentifier(value)) {
    const declared = frameDeclarationOf(value);
    if (declared !== undefined && isAnswering(declared))
      return writtenElsewhere(declared) ? undefined : declared;
    const initializer = constantInitializer(value);
    return initializer === undefined ? undefined : unwrapped(initializer);
  }
  if (!isPropertyAccessExpression(value) && !isElementAccessExpression(value)) return undefined;
  const member = writtenMember(value);
  if (member === undefined || isMethodDeclaration(member)) return member;
  return unwrapped(member);
}

/**
 * Whether the file writes the name of a function declaration, by an assignment or a pattern whose
 * value or key the compile cannot read as well: the name may hold what was written instead.
 */
function writtenElsewhere(declared: Node): boolean {
  const pending: Node[] = [declared.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    for (const target of framedWrittenTargets(node)) {
      const name = unwrapped(target);
      const found: Node | undefined = isIdentifier(name) ? frameDeclarationOf(name) : undefined;
      if (found === declared) return true;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** A fixed plain data literal stays data behind an assertion; opaque receivers retain assertions. */
function returnedError(value: Expression, error: (value: Expression) => boolean): boolean {
  const actual = unwrapped(value);
  const plain =
    isObjectLiteralExpression(actual) &&
    actual.properties.every((property) => {
      if (!isPropertyAssignment(property)) return false;
      const key = writtenArrayKey(property.name);
      if (key === undefined || key === '__proto__') return false;
      const field = unwrapped(property.initializer);
      return (
        constantValue(field) !== undefined ||
        field.kind === SyntaxKind.NullKeyword ||
        field.kind === SyntaxKind.TrueKeyword ||
        field.kind === SyntaxKind.FalseKeyword
      );
    });
  return error(plain ? actual : value);
}

/** A literal method selection, after the existing own-function proof checked prior effects. */
function writtenMember(member: Expression): MethodValue | undefined {
  const keys: string[] = [];
  let value = unwrapped(member);
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const key = frameMemberName(value);
    if (key === undefined) return undefined;
    keys.unshift(key);
    value = unwrapped(value.expression);
  }
  const seen = new Set<Node>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const initializer = constantInitializer(value);
    if (initializer === undefined) return undefined;
    value = unwrapped(initializer);
  }
  let selected: Expression | MethodDeclaration = value;
  for (const key of keys) {
    if (!isObjectLiteralExpression(selected)) return undefined;
    const field = literalMember(selected, key);
    if (field === undefined) return undefined;
    selected = field;
  }
  return selected;
}

/** Later spreads or opaque fields cannot establish the value of an earlier selected entry. */
function literalMember(value: ObjectLiteralExpression, key: string): MethodValue | undefined {
  for (const property of value.properties.toReversed()) {
    if (isSpreadAssignment(property)) return undefined;
    const name = writtenArrayKey(property.name);
    if (name === undefined) return undefined;
    if (name !== key) continue;
    if (isMethodDeclaration(property)) return property;
    return isPropertyAssignment(property) ? property.initializer : undefined;
  }
  return undefined;
}

/** Only whole immutable declarations preserve a callable alias or its literal holder. */
function constantInitializer(name: Identifier): Expression | undefined {
  const declared = frameDeclarationOf(name);
  if (declared === undefined || !isVariableDeclaration(declared)) return undefined;
  const statement = declared.parent.parent;
  return isVariableStatement(statement) &&
    /^const\s/u.test(statement.declarationList.getText(statement.getSourceFile()))
    ? declared.initializer
    : undefined;
}
