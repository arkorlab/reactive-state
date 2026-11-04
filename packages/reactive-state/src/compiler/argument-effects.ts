import {
  type ClassLikeDeclaration,
  type CallExpression,
  type ConstructorDeclaration,
  type Expression,
  isArrayLiteralExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isClassStaticBlockDeclaration,
  isComputedPropertyName,
  isConstructorDeclaration,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isNumericLiteral,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isSetAccessorDeclaration,
  isStringLiteral,
  isTaggedTemplateExpression,
  isTemplateExpression,
  isVariableDeclaration,
  type NewExpression,
  type Node,
  type ParameterDeclaration,
  type TaggedTemplateExpression,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { BUILT_INS, PLATFORM_ALIKE } from './built-ins.ts';
import { globalPathOf } from './code-globals.ts';
import { declarationOf } from './framed.ts';
import { rootOf } from './kept.ts';
import { writtenBy } from './written.ts';

interface Execution {
  readonly root: Node;
  readonly fn: Node | undefined;
  readonly trail: ReadonlySet<Node>;
  readonly calleeOf: CalleeOf;
}
type CalleeOf = (node: Expression) => Node | undefined;
type Invocation = CallExpression | NewExpression | TaggedTemplateExpression;
type Callable = Answering | ConstructorDeclaration;
const LOCAL_ARRAY_CALLS = new Set(['pop', 'push', 'shift', 'unshift']);
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
export function argumentChanges(argument: Expression, calleeOf: CalleeOf): boolean {
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
      const written = writtenBy(node);
      status.changed = written !== undefined && !localWrite(written, node, context.fn);
      if (!status.changed && invoked(node)) {
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
function invoked(node: Node): node is Invocation {
  return isCallExpression(node) || isNewExpression(node) || isTaggedTemplateExpression(node);
}

/** Source invocation roots, preserving generator suspension and native call handling. */
function queueInvocation(node: Invocation, current: Execution, pending: Execution[]): boolean {
  const callee = current.calleeOf(isTaggedTemplateExpression(node) ? node.tag : node.expression);
  if (callee === undefined) {
    return false;
  }
  const path = globalPathOf(callee);
  if (path !== undefined && (BUILT_INS.has(path[0] ?? '') || PLATFORM_ALIKE.has(path[0] ?? ''))) {
    return true;
  }
  return queueSource(node, callee, current, pending);
}

/** A known source function's immediate defaults, body and instance fields. */
function queueSource(
  node: Invocation,
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
  if (!generator(fn) && fn.body !== undefined) {
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

/** Omitted, undefined or unproven actual values may execute a parameter default. */
function queueDefaults(
  fn: Callable,
  given: readonly Expression[],
  current: Execution,
  pending: Execution[],
): void {
  let index = 0;
  const parameters = (fn.parameters as readonly ParameterDeclaration[] | undefined) ?? [];
  for (const parameter of parameters) {
    if (isIdentifier(parameter.name) && parameter.name.text === 'this') {
      continue;
    }
    if (parameter.initializer !== undefined && mayBeUndefined(given[index], current.calleeOf)) {
      pending.push({ ...current, root: parameter.initializer, fn });
    }
    index += 1;
  }
}

/** A source-proven present value skips a default; other actuals retain its possible effects. */
function mayBeUndefined(value: Expression | undefined, calleeOf: CalleeOf): boolean {
  const held = value === undefined ? undefined : calleeOf(value);
  return (
    held === undefined ||
    (!DEFINED.has(held.kind) && !isAnswering(held) && !isClassDeclaration(held))
  );
}

/** Native tag strings are present before any substitutions. */
function tagArguments(node: Node): readonly Expression[] {
  if (!isTaggedTemplateExpression(node)) {
    return [];
  }
  const substitutions = isTemplateExpression(node.template)
    ? node.template.templateSpans.map((span) => span.expression)
    : [];
  return [node.template, ...substitutions];
}

/** A source constructor or an ordinary function called with new. */
function sourceConstructor(node: Node): Node | undefined {
  return isClassDeclaration(node) || isClassExpression(node)
    ? node.members.find((member) => isConstructorDeclaration(member) && member.body !== undefined)
    : node;
}

/** Generator parameters execute now, but acquiring the iterator does not execute its body. */
function generator(node: Node): boolean {
  return (
    (isFunctionDeclaration(node) || isFunctionExpression(node) || isMethodDeclaration(node)) &&
    node.asteriskToken !== undefined
  );
}

/** Rebinding a local or changing a fresh local array does not reach an earlier argument. */
function localWrite(target: Node, operation: Node, fn: Node | undefined): boolean {
  const root = rootOf(target);
  if (fn === undefined || root === undefined) {
    return false;
  }
  const declared = declarationOf(root);
  if (declared === undefined || !within(declared, fn)) {
    return false;
  }
  if (isIdentifier(target) && !isCallExpression(operation)) {
    return true;
  }
  return (
    isVariableDeclaration(declared) &&
    declared.initializer !== undefined &&
    isArrayLiteralExpression(unwrapped(declared.initializer))
  );
}

/** Array insertion/removal has no callback; assignments of own methods invalidate that proof. */
function localArrayCall(node: Node, target: Node, fn: Node | undefined): boolean {
  if (fn === undefined || !isCallExpression(node) || !localWrite(target, node, fn)) {
    return false;
  }
  const member = unwrapped(node.expression);
  if (!isPropertyAccessExpression(member) || !LOCAL_ARRAY_CALLS.has(member.name.text)) {
    return false;
  }
  const root = rootOf(target);
  const declared = root === undefined ? undefined : declarationOf(root);
  const status = { changed: false };
  const visit = (each: Node): void => {
    status.changed ||= replacesArrayMethod(each, declared);
    if (!status.changed) {
      each.forEachChild(visit);
    }
  };
  visit(fn);
  return !status.changed;
}

/** Named own writes and calls on another receiver can replace an array's native methods. */
function replacesArrayMethod(node: Node, declared: Node | undefined): boolean {
  const written = writtenBy(node);
  const root = written === undefined ? undefined : rootOf(written);
  if (written === undefined || root === undefined || declarationOf(root) !== declared) {
    return false;
  }
  if (isCallExpression(node)) {
    const member = unwrapped(node.expression);
    const receiver = isPropertyAccessExpression(member) ? rootOf(member.expression) : undefined;
    return receiver === undefined || declarationOf(receiver) !== declared;
  }
  if (isPropertyAccessExpression(written)) {
    return written.name.text !== 'length';
  }
  if (isElementAccessExpression(written)) {
    const key = unwrapped(written.argumentExpression);
    return !(
      (isNumericLiteral(key) || isStringLiteral(key)) &&
      Number.isSafeInteger(Number(key.text)) &&
      Number(key.text) >= 0
    );
  }
  return false;
}

/** A declaration owned by this invocation rather than captured from a caller. */
function within(node: Node, owner: Node): boolean {
  for (let at: Node = node; !isSourceFileNode(at); at = at.parent) {
    if (at === owner) {
      return true;
    }
  }
  return false;
}

/** SourceFile is the outer boundary of lexical ownership. */
function isSourceFileNode(node: Node): boolean {
  return node.kind === SyntaxKind.SourceFile;
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
