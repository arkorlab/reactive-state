import {
  type BindingName,
  type ClassLikeDeclaration,
  type ConstructorDeclaration,
  type Expression,
  isBindingElement,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isClassStaticBlockDeclaration,
  isComputedPropertyName,
  isConstructorDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isPropertyDeclaration,
  isSetAccessorDeclaration,
  isSpreadElement,
  isTaggedTemplateExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, isAnswering } from './answers.ts';
import { allWrittenTargets, localArrayCall, localWrite } from './argument-local-arrays.ts';
import {
  type CalleeLookup,
  classifyNativeInvocation,
  type NativeInvocation,
  tagArguments,
} from './argument-native-calls.ts';
import { BUILT_INS, PLATFORM_ALIKE } from './built-ins.ts';
import { globalPathOf } from './code-globals.ts';
import { writtenBy } from './written.ts';

interface Execution {
  readonly root: Node;
  readonly fn: Node | undefined;
  readonly trail: ReadonlySet<Node>;
  readonly calleeOf: CalleeLookup;
}
type Callable = Answering | ConstructorDeclaration;
const DEFINED: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ArrayLiteralExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.ClassExpression,
  SyntaxKind.FalseKeyword,
  SyntaxKind.FunctionExpression,
  SyntaxKind.NewExpression,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.ObjectLiteralExpression,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.TemplateExpression,
  SyntaxKind.TrueKeyword,
]);

/** Executing an argument can invalidate values another argument selected before the callee runs. */
export function argumentChanges(argument: Expression, calleeOf: CalleeLookup): boolean {
  const pending: Execution[] = [{ root: argument, fn: undefined, trail: new Set(), calleeOf }];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (current.trail.has(current.root)) {
      return true;
    }
    const context = current;
    const trail = new Set([...current.trail, current.root]);
    const status = { changed: false };
    const visit = (node: Node): void => {
      if (status.changed) {
        return;
      }
      if (isClassDeclaration(node) || isClassExpression(node)) {
        definedClass(node, visit);
        return;
      }
      status.changed = allWrittenTargets(node).some(
        (target) => !localWrite(target, node, context.fn),
      );
      if (!status.changed && invoked(node)) {
        const written = writtenBy(node);
        const local = written !== undefined && localArrayCall(node, written, context.fn);
        status.changed = !local && !queueInvocation(node, { ...context, trail }, pending);
      }
      if (!status.changed && !isAnswering(node) && !isConstructorDeclaration(node)) {
        node.forEachChild(visit);
      }
    };
    visit(current.root);
    if (status.changed) {
      return true;
    }
  }
  return false;
}

/** Calls, constructions and tags execute source code; a function merely passed as a value does not. */
function invoked(node: Node): node is NativeInvocation {
  return isCallExpression(node) || isNewExpression(node) || isTaggedTemplateExpression(node);
}

/** Source invocation roots and native call handling. */
function queueInvocation(
  node: NativeInvocation,
  current: Execution,
  pending: Execution[],
): boolean {
  const callee = current.calleeOf(isTaggedTemplateExpression(node) ? node.tag : node.expression);
  if (callee === undefined) {
    return false;
  }
  const path = globalPathOf(callee);
  if (path !== undefined && (BUILT_INS.has(path[0] ?? '') || PLATFORM_ALIKE.has(path[0] ?? ''))) {
    return queueNative(node, path, current, pending);
  }
  return queueSource(node, callee, current, pending);
}

/** Known globals with no synchronous hook, or whose callback body can be queued directly. */
function queueNative(
  node: NativeInvocation,
  path: readonly string[],
  current: Execution,
  pending: Execution[],
): boolean {
  const decision = classifyNativeInvocation(node, path, current.calleeOf);
  if (decision.kind === 'rejected') {
    return false;
  }
  if (decision.kind === 'callback') {
    queueDefaults(decision.fn, [], current, pending);
    if (!generator(decision.fn)) {
      pending.push({ ...current, root: decision.body, fn: decision.fn });
    }
  }
  return true;
}

/** A known source function's immediate defaults, body and instance fields. */
function queueSource(
  node: NativeInvocation,
  callee: Node,
  current: Execution,
  pending: Execution[],
): boolean {
  const fn = isNewExpression(node) ? sourceConstructor(callee) : callee;
  if (isNewExpression(node) && (isClassDeclaration(callee) || isClassExpression(callee))) {
    queueFields(callee, current, pending);
    if (fn === undefined) {
      return callee.heritageClauses === undefined;
    }
  }
  if (fn === undefined || (!isAnswering(fn) && !isConstructorDeclaration(fn))) {
    return false;
  }
  const given = isTaggedTemplateExpression(node) ? tagArguments(node) : (node.arguments ?? []);
  queueDefaults(fn, given, current, pending);
  // A generator's call only acquires its iterator, but what consumes it within the argument
  // (`Array.from(gen())`, `[...gen()]`, `new Set(gen())`) runs the body: it is walked as any body.
  if (fn.body !== undefined) {
    pending.push({ ...current, root: fn.body, fn });
  }
  return fn.body !== undefined;
}

/** Instance fields are evaluated for an actual construction rather than class definition. */
function queueFields(callee: ClassLikeDeclaration, current: Execution, pending: Execution[]): void {
  for (const member of callee.members) {
    if (isPropertyDeclaration(member) && member.initializer !== undefined && !isStatic(member)) {
      pending.push({ ...current, root: member.initializer, fn: callee });
    }
  }
}

/** Omitted, undefined, spread-shifted or unproven actual values may execute a parameter default. */
function queueDefaults(
  fn: Callable,
  given: readonly Expression[],
  current: Execution,
  pending: Execution[],
): void {
  let index = 0;
  let shifted = false;
  for (const parameter of fn.parameters) {
    if (isIdentifier(parameter.name) && parameter.name.text === 'this') {
      continue;
    }
    const actual = given[index];
    shifted ||= actual !== undefined && isSpreadElement(actual);
    if (
      parameter.initializer !== undefined &&
      (shifted || mayBeUndefined(actual, current.calleeOf))
    ) {
      pending.push({ ...current, root: parameter.initializer, fn });
    }
    if (!isIdentifier(parameter.name)) {
      queuePattern(parameter.name, fn, current, pending);
    }
    index += 1;
  }
}

/** Binding-element defaults and computed keys inside a destructured parameter pattern. */
function queuePattern(
  root: BindingName,
  fn: Callable,
  current: Execution,
  pending: Execution[],
): void {
  const stack: BindingName[] = [root];
  for (let name = stack.pop(); name !== undefined; name = stack.pop()) {
    if (isIdentifier(name)) {
      continue;
    }
    for (const element of name.elements) {
      const nested = queuePatternElement(element, fn, current, pending);
      if (nested !== undefined) {
        stack.push(nested);
      }
    }
  }
}

/** Queues one binding element's computed key and default, returning any nested binding pattern. */
function queuePatternElement(
  element: Node,
  fn: Callable,
  current: Execution,
  pending: Execution[],
): BindingName | undefined {
  if (!isBindingElement(element)) {
    return undefined;
  }
  if (element.propertyName !== undefined && isComputedPropertyName(element.propertyName)) {
    pending.push({ ...current, root: element.propertyName.expression, fn });
  }
  if (element.initializer !== undefined) {
    pending.push({ ...current, root: element.initializer, fn });
  }
  return element.name === undefined || isIdentifier(element.name) ? undefined : element.name;
}

/** A source-proven present value skips a default; other actuals retain its possible effects. */
function mayBeUndefined(value: Expression | undefined, calleeOf: CalleeLookup): boolean {
  const held = value === undefined ? undefined : calleeOf(value);
  return (
    held === undefined ||
    (!DEFINED.has(held.kind) && !isAnswering(held) && !isClassDeclaration(held))
  );
}

/** A source constructor or an ordinary function called with new. */
function sourceConstructor(node: Node): Node | undefined {
  return isClassDeclaration(node) || isClassExpression(node)
    ? node.members.find((member) => isConstructorDeclaration(member) && member.body !== undefined)
    : node;
}

/** A native's generator callback is called, not consumed: its parameters run, its body does not. */
function generator(node: Node): boolean {
  return (
    (isFunctionDeclaration(node) || isFunctionExpression(node) || isMethodDeclaration(node)) &&
    node.asteriskToken !== undefined
  );
}

/** Class definition evaluates names and static members while deferring instance bodies. */
function definedClass(node: ClassLikeDeclaration, visit: (node: Node) => void): void {
  evaluatedBases(node, visit);
  for (const member of node.members) {
    const named =
      isPropertyDeclaration(member) ||
      isMethodDeclaration(member) ||
      isGetAccessorDeclaration(member) ||
      isSetAccessorDeclaration(member);
    if (named && isComputedPropertyName(member.name)) {
      visit(member.name.expression);
    }
    if (isPropertyDeclaration(member) && member.initializer !== undefined && isStatic(member)) {
      visit(member.initializer);
    } else if (isClassStaticBlockDeclaration(member)) {
      visit(member.body);
    }
  }
}

/** Defining an extends expression executes its source but no type-only heritage. */
function evaluatedBases(node: ClassLikeDeclaration, visit: (node: Node) => void): void {
  const clauses = node.heritageClauses;
  if (clauses === undefined) {
    return;
  }
  for (const clause of clauses) {
    if (clause.token === SyntaxKind.ExtendsKeyword) {
      for (const base of clause.types) {
        if ('expression' in base) {
          visit(base.expression);
        }
      }
    }
  }
}

/** A property initialized once at class definition, rather than for each instance. */
function isStatic(node: Node & { readonly modifiers?: readonly Node[] }): boolean {
  return node.modifiers?.some((modifier) => modifier.kind === SyntaxKind.StaticKeyword) === true;
}
