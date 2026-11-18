import {
  type ArrayBindingPattern,
  type BindingElement,
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isElementAccessExpression,
  isForOfStatement,
  isIdentifier,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  type Node,
  type ObjectBindingPattern,
  type ParameterDeclaration,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, isAnswering, parametersOf } from './answers.ts';
import { literalName } from './bounded.ts';
import { patternKey } from './code-globals.ts';
import { declarationOf } from './framed.ts';
import { readsOf } from './local-module-reads.ts';
import { constantValue } from './numbers.ts';
import { platformInitializer } from './platform-inputs.ts';
import { bindsTarget, peelPlatform, platformPathsOf, sourceFunction } from './platform-uses.ts';
import { isTypeOnly } from './scope.ts';

/** Assignment operators whose right-hand expression can populate the target binding or member. */
const VALUE_ASSIGNMENT_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** Array mutators whose arguments become elements of the receiver array. */
const ELEMENT_PUSH_METHODS: ReadonlySet<string> = new Set(['fill', 'push', 'unshift']);

/** Starting index of inserted element arguments in `array.splice(start, deleteCount, ...items)` and `Reflect.set`. */
const SPLICE_INSERT_START = 2;

/** A pending projection query checking whether `expr` followed by `keys` can yield an `Event`. */
export interface EventQuery {
  readonly expr: Expression;
  readonly keys: readonly (string | null)[];
}

/** Shared binding predicate and projection state while scanning write sites. */
interface BindingWriteContext {
  readonly isRead: (node: Node) => node is Identifier;
  readonly keys: readonly (string | null)[];
  readonly pending: EventQuery[];
}

/** Resolves a static string key from `expr[key]`, including constant identifiers. */
export function staticMemberKey(
  node: Expression & { readonly argumentExpression: Expression },
): string | undefined {
  const direct = literalName(node as never);
  if (direct !== undefined) {
    return direct;
  }
  const constant = constantValue(node.argumentExpression, (id) => platformInitializer(id, id));
  return constant === undefined ? undefined : String(constant);
}

/** Traces an identifier through variable declarations, destructuring bindings, or parameters. */
export function expandIdentifierQuery(
  id: Identifier,
  keys: readonly (string | null)[],
  pending: EventQuery[],
): void {
  const declared = declarationOf(id);
  if (declared !== undefined && isVariableDeclaration(declared)) {
    if (declared.initializer !== undefined) {
      pending.push({ expr: declared.initializer, keys });
    }
    if (isIdentifier(declared.name)) {
      pushIdentifierWriteSites(declared.name, keys, pending);
    }
    return;
  }
  const bound = findBindingIdentifier(id);
  if (bound === undefined) {
    return;
  }
  pushBoundIdentifierOrigins(bound, keys, pending);
  pushIdentifierWriteSites(bound, keys, pending);
}

/** Resolves the subject expression(s) feeding `pattern` from a declaration, outer element, or parameter. */
export function patternParentQueries(
  pattern: ObjectBindingPattern | ArrayBindingPattern,
  keys: readonly (string | null)[],
): readonly EventQuery[] {
  const holder = pattern.parent;
  if (isVariableDeclaration(holder)) {
    if (holder.initializer !== undefined) {
      return [{ expr: holder.initializer, keys }];
    }
    if (isForOfStatement(holder.parent.parent)) {
      return [{ expr: holder.parent.parent.expression, keys: [null, ...keys] }];
    }
    return [];
  }
  if (isBindingElement(holder)) {
    const own = holder.initializer === undefined ? [] : [{ expr: holder.initializer, keys }];
    const parent = holder.parent;
    const outer =
      isArrayBindingPattern(parent) || isObjectBindingPattern(parent)
        ? patternParentQueries(parent, bindingElementStep(holder, keys))
        : [];
    return [...own, ...outer];
  }
  if (isParameterDeclaration(holder)) {
    const found: EventQuery[] = [];
    pushParameterOrigins(holder, keys, found);
    return found;
  }
  return [];
}

/** Locates the pattern or parameter `Identifier` declaration that `read` resolves to. */
function findBindingIdentifier(read: Identifier): Identifier | undefined {
  for (let at: Node = read.parent; ; at = at.parent) {
    if (isAnswering(at)) {
      const paramHit = findNameInParameters(parametersOf(at), read.text);
      if (paramHit !== undefined) {
        return paramHit;
      }
    }
    const blockHit = findPatternBindingInNode(at, read.text);
    if (blockHit !== undefined) {
      return blockHit;
    }
    if (at === read.getSourceFile()) {
      return undefined;
    }
  }
}

/** Finds a matching binding identifier inside `parameters`. */
function findNameInParameters(
  parameters: readonly ParameterDeclaration[],
  text: string,
): Identifier | undefined {
  for (const parameter of parameters) {
    const hit = findIdentifierInBindingName(parameter.name, text);
    if (hit !== undefined) {
      return hit;
    }
  }
  return undefined;
}

/** Finds a destructured or loop-header variable binding identifier declared directly on `node`. */
function findPatternBindingInNode(node: Node, text: string): Identifier | undefined {
  if (isForOfStatement(node) && !isIdentifier(node.initializer)) {
    return findIdentifierInNode(node.initializer, text);
  }
  if (
    !('statements' in node) ||
    !Array.isArray((node as { readonly statements?: unknown }).statements)
  ) {
    return undefined;
  }
  for (const statement of (node as { readonly statements: readonly Node[] }).statements) {
    const hit = findIdentifierInStatement(statement, text);
    if (hit !== undefined) {
      return hit;
    }
  }
  return undefined;
}

/** Searches variable declarations in `statement` for a destructured binding matching `text`. */
function findIdentifierInStatement(statement: Node, text: string): Identifier | undefined {
  if (!isVariableStatement(statement)) {
    return undefined;
  }
  for (const decl of statement.declarationList.declarations) {
    if (!isIdentifier(decl.name)) {
      const hit = findIdentifierInBindingName(decl.name, text);
      if (hit !== undefined) {
        return hit;
      }
    }
  }
  return undefined;
}

/** Recursively searches a `BindingName` for an identifier matching `text`. */
function findIdentifierInBindingName(name: Node | undefined, text: string): Identifier | undefined {
  if (name === undefined) {
    return undefined;
  }
  if (isIdentifier(name)) {
    return name.text === text ? name : undefined;
  }
  if (isObjectBindingPattern(name) || isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (isBindingElement(element)) {
        const hit = findIdentifierInBindingName(element.name, text);
        if (hit !== undefined) {
          return hit;
        }
      }
    }
  }
  return undefined;
}

/** Finds a `VariableDeclaration` binding matching `text` in a `for..of` initializer. */
function findIdentifierInNode(initializer: Node, text: string): Identifier | undefined {
  if (!isVariableDeclarationList(initializer)) {
    return undefined;
  }
  for (const decl of initializer.declarations) {
    const hit = findIdentifierInBindingName(decl.name, text);
    if (hit !== undefined) {
      return hit;
    }
  }
  return undefined;
}

/** Pushes initializers, pattern subjects, loop iterables, or call-site arguments for `bound`. */
function pushBoundIdentifierOrigins(
  bound: Identifier,
  keys: readonly (string | null)[],
  pending: EventQuery[],
): void {
  const parent = bound.parent;
  if (isParameterDeclaration(parent)) {
    pushParameterOrigins(parent, keys, pending);
    return;
  }
  if (isVariableDeclaration(parent) && isForOfStatement(parent.parent.parent)) {
    pending.push({ expr: parent.parent.parent.expression, keys: [null, ...keys] });
    return;
  }
  if (!isBindingElement(parent)) {
    return;
  }
  if (parent.initializer !== undefined) {
    pending.push({ expr: parent.initializer, keys });
  }
  const nextKeys = bindingElementStep(parent, keys);
  const outer = parent.parent;
  if (isArrayBindingPattern(outer) || isObjectBindingPattern(outer)) {
    pending.push(...patternParentQueries(outer, nextKeys));
  }
}

/** Prepends the projection step for `element` within its enclosing object or array binding pattern. */
function bindingElementStep(
  element: BindingElement,
  keys: readonly (string | null)[],
): readonly (string | null)[] {
  const pattern = element.parent;
  if (isObjectBindingPattern(pattern)) {
    return element.dotDotDotToken === undefined ? [patternKey(element) ?? null, ...keys] : keys;
  }
  if (!isArrayBindingPattern(pattern)) {
    return [];
  }
  const index = pattern.elements.indexOf(element);
  const hasPriorSpread = pattern.elements
    .slice(0, index)
    .some((each) => isBindingElement(each) && each.dotDotDotToken !== undefined);
  if (element.dotDotDotToken !== undefined) {
    return keys.length > 0 ? [null, ...keys.slice(1)] : [];
  }
  return [hasPriorSpread ? null : String(index), ...keys];
}

/** Collects default and call-site argument origins for `parameter` across its source file. */
function pushParameterOrigins(
  parameter: ParameterDeclaration,
  keys: readonly (string | null)[],
  pending: EventQuery[],
): void {
  if (parameter.initializer !== undefined) {
    pending.push({ expr: parameter.initializer, keys });
  }
  const fn = parameter.parent;
  if (!isAnswering(fn)) {
    return;
  }
  const paramIndex = parametersOf(fn).indexOf(parameter);
  if (paramIndex === -1) {
    return;
  }
  for (const call of callsToFunction(fn, parameter.getSourceFile())) {
    pushCallArgumentForParameter(call, { keys, paramIndex, parameter }, pending);
  }
}

/** Finds all direct call expressions in `sourceFile` invoking `fn`. */
function callsToFunction(fn: Answering, sourceFile: SourceFile): readonly CallExpression[] {
  const calls: CallExpression[] = [];
  const visit = (node: Node): void => {
    if (isTypeOnly(node)) {
      return;
    }
    if (isCallExpression(node) && sourceFunction(node.expression) === fn) {
      calls.push(node);
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return calls;
}

/** Pushes argument origins matching `spec.parameter` at `spec.paramIndex` from `call`. */
function pushCallArgumentForParameter(
  call: CallExpression,
  spec: {
    readonly keys: readonly (string | null)[];
    readonly paramIndex: number;
    readonly parameter: ParameterDeclaration;
  },
  pending: EventQuery[],
): void {
  const { keys, paramIndex, parameter } = spec;
  let fixedBefore = 0;
  let seenSpread = false;
  for (const arg of call.arguments) {
    if (isSpreadElement(arg)) {
      seenSpread = true;
      const spreadKeys =
        parameter.dotDotDotToken === undefined ? [null, ...keys] : [null, ...keys.slice(1)];
      pending.push({ expr: arg.expression, keys: spreadKeys });
      continue;
    }
    if (parameter.dotDotDotToken !== undefined) {
      if ((seenSpread || fixedBefore >= paramIndex) && keys.length > 0) {
        pending.push({ expr: arg, keys: keys.slice(1) });
      }
    } else if (
      (!seenSpread && fixedBefore === paramIndex) ||
      (seenSpread && fixedBefore <= paramIndex)
    ) {
      pending.push({ expr: arg, keys });
    }
    fixedBefore += 1;
  }
}

/** Scans `declName`'s source file for assignments and mutating calls on `declName`. */
function pushIdentifierWriteSites(
  declName: Identifier,
  keys: readonly (string | null)[],
  pending: EventQuery[],
): void {
  const sourceFile = declName.getSourceFile();
  const ctx: BindingWriteContext = { isRead: readsOf(declName, sourceFile), keys, pending };
  const visit = (node: Node): void => {
    if (isTypeOnly(node)) {
      return;
    }
    if (isBinaryExpression(node) && VALUE_ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)) {
      inspectAssignmentToBinding(node.left, node.right, ctx);
    } else if (isCallExpression(node) && keys.length > 0) {
      inspectMutatingCallOnBinding(node, ctx);
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
}

/** Checks direct, member, and destructuring `=` writes for contributions to `ctx`. */
function inspectAssignmentToBinding(
  left: Expression,
  right: Expression,
  ctx: BindingWriteContext,
): void {
  const { isRead, keys, pending } = ctx;
  const target = peelPlatform(left);
  if (isIdentifier(target) && isRead(target)) {
    pending.push({ expr: right, keys });
    return;
  }
  if (
    keys.length > 0 &&
    (isPropertyAccessExpression(target) || isElementAccessExpression(target))
  ) {
    const base = peelPlatform(target.expression);
    const writtenKey = isPropertyAccessExpression(target)
      ? target.name.text
      : staticMemberKey(target);
    const matches = keys[0] === null || writtenKey === undefined || writtenKey === keys[0];
    if (matches && isIdentifier(base) && isRead(base)) {
      pending.push({ expr: right, keys: keys.slice(1) });
    }
    return;
  }
  if (bindsTarget(target, isRead, false)) {
    pushDestructuringWriteQueries(target, right, ctx);
  }
}

/** Projects `right` down to each destructured write site targeting `ctx.isRead`. */
function pushDestructuringWriteQueries(
  pattern: Expression,
  right: Expression,
  ctx: BindingWriteContext,
): void {
  const { isRead, keys, pending } = ctx;
  const clean = peelPlatform(pattern);
  if (isIdentifier(clean) && isRead(clean)) {
    pending.push({ expr: right, keys });
    return;
  }
  if (isBinaryExpression(clean) && clean.operatorToken.kind === SyntaxKind.EqualsToken) {
    pushDestructuringWriteQueries(clean.left, right, ctx);
    pushDestructuringWriteQueries(clean.left, clean.right, ctx);
    return;
  }
  if (isObjectLiteralExpression(clean)) {
    pushObjectDestructuringWrite(clean, right, ctx);
  } else if (isArrayLiteralExpression(clean)) {
    for (const [index, el] of clean.elements.entries()) {
      const next = isSpreadElement(el) ? restElementKeys(keys) : [String(index), ...keys];
      pushDestructuringWriteQueries(isSpreadElement(el) ? el.expression : el, right, {
        ...ctx,
        keys: next,
      });
    }
  }
}

/** Computes element projection keys through an array rest target. */
function restElementKeys(keys: readonly (string | null)[]): readonly (string | null)[] {
  return keys.length > 0 ? [null, ...keys.slice(1)] : [];
}

/** Projects `right` through an object assignment pattern toward `ctx.isRead`. */
function pushObjectDestructuringWrite(
  clean: Expression & { readonly properties: readonly Node[] },
  right: Expression,
  ctx: BindingWriteContext,
): void {
  const { isRead, keys, pending } = ctx;
  for (const prop of clean.properties) {
    if (isShorthandPropertyAssignment(prop) && isRead(prop.name)) {
      pending.push({ expr: right, keys: [prop.name.text, ...keys] });
      if (prop.objectAssignmentInitializer !== undefined) {
        pending.push({ expr: prop.objectAssignmentInitializer, keys });
      }
    } else if (isPropertyAssignment(prop)) {
      pushDestructuringWriteQueries(prop.initializer, right, {
        ...ctx,
        keys: [patternKey(prop) ?? null, ...keys],
      });
    } else if (isSpreadAssignment(prop)) {
      pushDestructuringWriteQueries(prop.expression, right, ctx);
    }
  }
}

/** Checks array/object mutator calls (`push`, `unshift`, `splice`, `fill`, `Object.assign`, `Reflect.set`). */
function inspectMutatingCallOnBinding(call: CallExpression, ctx: BindingWriteContext): void {
  if (pushStaticHelperMutation(call, ctx)) {
    return;
  }
  const callee = peelPlatform(call.expression);
  if (!isPropertyAccessExpression(callee)) {
    return;
  }
  const receiver = peelPlatform(callee.expression);
  if (!isIdentifier(receiver) || !ctx.isRead(receiver)) {
    return;
  }
  const method = callee.name.text;
  const rest = ctx.keys.slice(1);
  for (const arg of insertedMutatorArgs(call, method)) {
    ctx.pending.push({
      expr: isSpreadElement(arg) ? arg.expression : arg,
      keys: isSpreadElement(arg) ? [null, ...rest] : rest,
    });
  }
}

/** Returns element arguments inserted into an array by `method`. */
function insertedMutatorArgs(call: CallExpression, method: string): readonly Expression[] {
  if (ELEMENT_PUSH_METHODS.has(method)) {
    return call.arguments;
  }
  return method === 'splice' ? call.arguments.slice(SPLICE_INSERT_START) : [];
}

/** Handles `Object.assign(target, ...)` and `Reflect.set(target, key, value)` writes. */
function pushStaticHelperMutation(call: CallExpression, ctx: BindingWriteContext): boolean {
  const paths = platformPathsOf(call.expression);
  const first = call.arguments[0];
  const target = first === undefined || isSpreadElement(first) ? undefined : peelPlatform(first);
  if (target === undefined || !isIdentifier(target) || !ctx.isRead(target)) {
    return false;
  }
  if (paths.includes('Object.assign')) {
    for (const src of call.arguments.slice(1)) {
      if (!isSpreadElement(src)) {
        ctx.pending.push({ expr: src, keys: ctx.keys });
      }
    }
    return true;
  }
  const valueArg = call.arguments[SPLICE_INSERT_START];
  if (valueArg !== undefined && !isSpreadElement(valueArg) && paths.includes('Reflect.set')) {
    ctx.pending.push({ expr: valueArg, keys: ctx.keys.slice(1) });
    return true;
  }
  return false;
}
