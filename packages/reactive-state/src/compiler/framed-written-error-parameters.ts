import {
  type Expression,
  type FunctionDeclaration,
  type Identifier,
  isArrowFunction,
  isBindingElement,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isConstructorDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isNewExpression,
  isParameterDeclaration,
  isParenthesizedExpression,
  isSetAccessorDeclaration,
  isSourceFile,
  isSpreadElement,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
  type ParameterDeclaration,
  type VariableStatement,
} from 'typescript/ast';

import { type Answering, isAnswering, overloadsOf, parametersOf } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { type FrameDeclaration, frameDeclarationOf } from './framed-bindings.ts';
import { framedQuietPrimitive, framedQuietSource } from './framed-native-evaluation.ts';
import { reassignedTarget } from './framed-written-error-uses.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/**
 * Factory call parameter quietness and lexical scope-parameter reachability for written `Error`
 * constructor arguments, including nested helpers, parameter defaults, and `arguments` bindings.
 */

interface ScopeParameterContext {
  readonly fn: Answering;
  readonly parameterSet: ReadonlySet<Node>;
  readonly pending: Node[];
  readonly seen: Set<Node>;
}

/** Checks that a variable statement declares `const` bindings. */
export function constantStatement(statement: VariableStatement): boolean {
  return /^\s*const\b/u.test(statement.declarationList.getText(statement.getSourceFile()));
}

/** Whether every call argument and reachable parameter default of `fn` is a quiet primitive. */
export function quietFactoryCall(fn: Answering, given: readonly Expression[]): boolean {
  if (given.some((arg) => isSpreadElement(arg) || !framedQuietPrimitive(arg))) return false;
  return parametersOf(fn).every((param, index) => quietFactoryParameter(param, given, index));
}

/** Verifies one factory parameter slot against supplied quiet arguments and default initializers. */
function quietFactoryParameter(
  param: ParameterDeclaration,
  given: readonly Expression[],
  index: number,
): boolean {
  if (suppliedQuietParameter(param, given, index)) return true;
  if (!isIdentifier(param.name)) return false;
  return param.initializer === undefined || framedQuietPrimitive(param.initializer);
}

/** Whether positional `param` receives a non-`undefined` quiet primitive with no prior spread. */
export function suppliedQuietParameter(
  param: ParameterDeclaration,
  args: readonly Expression[],
  index: number,
): boolean {
  if (param.dotDotDotToken !== undefined || !isIdentifier(param.name)) return false;
  const arg = args[index];
  if (arg === undefined) return false;
  if (args.slice(0, index + 1).some((each) => isSpreadElement(each))) return false;
  return nonUndefinedQuietPrimitive(arg);
}

/** Quiet primitives other than `undefined` cannot trigger a JavaScript parameter default. */
function nonUndefinedQuietPrimitive(expression: Expression): boolean {
  if (!framedQuietPrimitive(expression)) return false;
  const source = framedQuietSource(expression);
  return source !== undefined && globalPathOf(source)?.join('.') !== 'undefined';
}

/** Checks whether `construction` inside `fn` reads `fn`'s parameters or own `arguments` object. */
export function readsScopeParameter(construction: Expression, fn: Answering): boolean {
  if (!isCallExpression(construction) && !isNewExpression(construction)) return false;
  const context: ScopeParameterContext = {
    fn,
    parameterSet: new Set<Node>(parametersOf(fn)),
    pending: [construction],
    seen: new Set<Node>(),
  };
  for (
    let current = context.pending.pop();
    current !== undefined;
    current = context.pending.pop()
  ) {
    if (isTypeOnly(current)) continue;
    if (isScopeReadIdentifier(current) && inspectScopeIdentifier(current, context)) {
      return true;
    }
    current.forEachChild((child) => {
      context.pending.push(child);
    });
  }
  return false;
}

/** Filters AST nodes down to non-declaring identifier reads. */
function isScopeReadIdentifier(node: Node): node is Identifier {
  return isIdentifier(node) && readsBinding(node) && !isBindingDeclarationName(node);
}

/** Excludes identifiers standing as the declared binding name of their parent declaration. */
function isBindingDeclarationName(node: Identifier): boolean {
  const { parent } = node;
  if (
    isVariableDeclaration(parent) ||
    isParameterDeclaration(parent) ||
    isBindingElement(parent) ||
    isFunctionDeclaration(parent) ||
    isFunctionExpression(parent) ||
    isClassDeclaration(parent) ||
    isClassExpression(parent)
  ) {
    return parent.name === node;
  }
  return false;
}

/** Matches direct parameters, `fn`'s own `arguments`, and local declarations inside `fn`. */
function inspectScopeIdentifier(identifier: Identifier, context: ScopeParameterContext): boolean {
  const declared = frameDeclarationOf(identifier);
  if (declared === undefined) {
    return identifier.text === 'arguments' && ownsArgumentsBinding(identifier, context.fn);
  }
  if (context.parameterSet.has(declared)) return true;
  if (!declaredWithinScope(declared, context.fn)) return false;
  queueScopeDeclaration(identifier, declared, context);
  return false;
}

/** Queues local helper bodies, unsupplied helper parameters, and binding declarations inside `fn`. */
function queueScopeDeclaration(
  identifier: Identifier,
  declared: FrameDeclaration,
  context: ScopeParameterContext,
): void {
  const callable = selectiveCallable(declared);
  if (callable !== undefined) {
    queueCallableInvocation(identifier, callable, context);
    return;
  }
  if (isFunctionDeclaration(declared)) {
    for (const each of overloadsOf(declared)) {
      if (each.body !== undefined) queueOnce(each, context);
    }
    return;
  }
  if (!isParameterDeclaration(declared)) {
    queueOnce(declared, context);
  }
}

/** Queues a helper's body and any parameter whose default or pattern can execute at `identifier`. */
function queueCallableInvocation(
  identifier: Identifier,
  callable: Answering,
  context: ScopeParameterContext,
): void {
  if (callable.body !== undefined) {
    queueOnce(callable.body, context);
  }
  const args = directCallArguments(identifier);
  for (const [index, param] of parametersOf(callable).entries()) {
    if (args !== undefined && suppliedQuietParameter(param, args, index)) continue;
    queueOnce(param, context);
  }
}

/** Pushes `node` onto the pending worklist at most once per parameter reachability check. */
function queueOnce(node: Node, context: ScopeParameterContext): void {
  if (context.seen.has(node)) return;
  context.seen.add(node);
  context.pending.push(node);
}

/** Resolves unchanged local function declarations and unnamed `const` function/arrow bindings. */
const SINGLE_BODY_DECLARATIONS = new WeakMap<FunctionDeclaration, FunctionDeclaration | null>();
const UNCHANGED_DECLARATIONS = new WeakMap<FunctionDeclaration, boolean>();
const REASSIGNED_DECLARATIONS = new WeakMap<Node, ReadonlySet<Node>>();

/** Resolves an overloaded or plain function declaration to its sole unmutated body declaration. */
export function singleUnchangedFunctionBody(
  declared: FunctionDeclaration,
): FunctionDeclaration | undefined {
  const cached = SINGLE_BODY_DECLARATIONS.get(declared);
  if (cached !== undefined) return cached ?? undefined;
  const family = overloadsOf(declared);
  const bodies = family.filter(
    (each): each is FunctionDeclaration => isFunctionDeclaration(each) && each.body !== undefined,
  );
  const only = bodies.length === 1 ? bodies[0] : undefined;
  const reassigned =
    only === undefined ? undefined : reassignedDeclarationsIn(only.getSourceFile());
  const resolved =
    only !== undefined && reassigned !== undefined && family.every((each) => !reassigned.has(each))
      ? only
      : null;
  SINGLE_BODY_DECLARATIONS.set(declared, resolved);
  return resolved ?? undefined;
}

function selectiveCallable(declared: FrameDeclaration): Answering | undefined {
  if (isFunctionDeclaration(declared)) {
    return singleUnchangedFunctionBody(declared);
  }
  if (!isVariableDeclaration(declared) || !isIdentifier(declared.name)) return undefined;
  if (declared.initializer === undefined) return undefined;
  const statement = declared.parent.parent;
  if (!isVariableStatement(statement) || !constantStatement(statement)) return undefined;
  if (reassignedDeclarationsIn(declared.getSourceFile()).has(declared)) {
    return undefined;
  }
  const init = unwrapped(declared.initializer);
  if (isArrowFunction(init)) return init;
  return isFunctionExpression(init) && init.name === undefined ? init : undefined;
}

/** Returns call arguments when `identifier` is the direct callee of a plain `CallExpression`. */
function directCallArguments(identifier: Identifier): readonly Expression[] | undefined {
  let top: Node = identifier;
  while (isParenthesizedExpression(top.parent)) {
    top = top.parent;
  }
  return isCallExpression(top.parent) && top.parent.expression === top
    ? top.parent.arguments
    : undefined;
}

/** Whether `node` is lexically nested inside `scope`. */
function declaredWithinScope(node: Node, scope: Node): boolean {
  for (let at: Node = node.parent; !isSourceFile(at); at = at.parent) {
    if (at === scope) return true;
  }
  return false;
}

/** Whether an unbound `arguments` identifier refers to `fn`'s own non-arrow `arguments` object. */
function ownsArgumentsBinding(identifier: Identifier, fn: Answering): boolean {
  if (isArrowFunction(fn)) return false;
  for (let at: Node = identifier.parent; !isSourceFile(at); at = at.parent) {
    if (isArrowFunction(at)) continue;
    if (
      isAnswering(at) ||
      isConstructorDeclaration(at) ||
      isGetAccessorDeclaration(at) ||
      isSetAccessorDeclaration(at)
    ) {
      return at === fn;
    }
  }
  return false;
}

/** Rejects duplicate function bodies in the same scope and lexical reassignments. */
export function unchangedFunctionDeclaration(declared: FunctionDeclaration): boolean {
  const cached = UNCHANGED_DECLARATIONS.get(declared);
  if (cached !== undefined) return cached;
  const result = computeUnchangedFunctionDeclaration(declared);
  UNCHANGED_DECLARATIONS.set(declared, result);
  return result;
}

function computeUnchangedFunctionDeclaration(declared: FunctionDeclaration): boolean {
  if (declared.body === undefined || declared.name === undefined) return false;
  const family = overloadsOf(declared);
  if (family.some((each) => each !== declared && each.body !== undefined)) {
    return false;
  }
  const reassigned = reassignedDeclarationsIn(declared.getSourceFile());
  return family.every((each) => !reassigned.has(each));
}

/** Indexes all declarations targeted by identifier writes across `sourceFile` once per file. */
function reassignedDeclarationsIn(sourceFile: Node): ReadonlySet<Node> {
  const cached = REASSIGNED_DECLARATIONS.get(sourceFile);
  if (cached !== undefined) return cached;
  const reassigned = new Set<Node>();
  const pending: Node[] = [sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isIdentifier(node) && reassignedTarget(node)) {
      const resolved = frameDeclarationOf(node);
      if (resolved !== undefined) reassigned.add(resolved);
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  REASSIGNED_DECLARATIONS.set(sourceFile, reassigned);
  return reassigned;
}
