import {
  type BinaryExpression,
  type CallExpression,
  type Expression,
  type Identifier,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isConditionalExpression,
  isFunctionDeclaration,
  isIdentifier,
  isIfStatement,
  isInterfaceDeclaration,
  isNewExpression,
  isReturnStatement,
  isSpreadElement,
  isTypeAliasDeclaration,
  isVariableDeclaration,
  isVariableStatement,
  isVoidExpression,
  type Node,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, answersLater, isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import {
  framedConstructionTargets,
  framedSubclassConstructor,
  framedSubclassOwnWords,
} from './framed-constructors.ts';
import { framedNativeErrorCreation } from './framed-receivers.ts';
import { framedCondition, framedNativeConstructor } from './framed-sources.ts';
import { framedValueShape } from './framed-values.ts';
import {
  factoryMentionsThis,
  framedWrittenFactoryCall,
  sideEffectFreeExpression,
  sideEffectFreeVariableStatement,
} from './framed-written-error-calls.ts';
import {
  constantStatement,
  quietFactoryCall,
  readsScopeParameter,
  singleUnchangedFunctionBody,
} from './framed-written-error-parameters.ts';
import { nonInterceptingWrappedTarget } from './framed-written-error-wrappers.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';
import { constantValue } from './numbers.ts';

/**
 * Universal proof that every reachable branch and local factory return feeding an annotated
 * `Error` binding constructs a fresh, unmutated error whose words are written by the source.
 */

const ERRORS: ReadonlySet<string> = new Set([...STANDARD_ERRORS, 'AggregateError', 'DOMException']);

export type WrittenErrorCheck = (value: Expression, made: boolean) => boolean;

export interface ResolvedErrorVariable {
  readonly initializer: Expression;
  readonly nextReturnScope: Answering | undefined;
}

interface ProofContext {
  readonly check: WrittenErrorCheck;
  readonly resolveVariable: (
    read: Identifier,
    returnScope: Answering | undefined,
  ) => ResolvedErrorVariable | undefined;
}

interface ProofState extends ProofContext {
  readonly active: Set<string>;
  readonly activeFactories: Set<Answering>;
  readonly ids: Map<Node, number>;
  readonly memo: Map<string, boolean>;
}

interface FactoryFrame {
  readonly returnScope: Answering | undefined;
  readonly unquietScopes: readonly Answering[];
}

interface StatementFlow {
  readonly mayFallThrough: boolean;
  readonly returns: readonly Expression[];
}

const TOP_FRAME: FactoryFrame = { returnScope: undefined, unquietScopes: [] };

/** Requires every reachable expression of `initializer` to construct a local known-word `Error`. */
export function provenWrittenErrorInitializer(
  initializer: Expression,
  context: ProofContext,
): boolean {
  const state: ProofState = {
    ...context,
    active: new Set(),
    activeFactories: new Set(),
    ids: new Map(),
    memo: new Map(),
  };
  return evaluateWrittenError(initializer, state, TOP_FRAME);
}

/** Memoizes proof results per node and active factory scope while rejecting cycles. */
function evaluateWrittenError(node: Expression, state: ProofState, frame: FactoryFrame): boolean {
  const key = stateKey(node, frame, state.ids);
  const cached = state.memo.get(key);
  if (cached !== undefined) return cached;
  if (state.active.has(key)) return false;
  state.active.add(key);
  const proven = computeWrittenError(node, state, frame);
  state.active.delete(key);
  state.memo.set(key, proven);
  return proven;
}

/** Assigns monotonic numeric IDs to AST nodes and active unquiet scopes for exact memoization. */
function stateKey(node: Node, frame: FactoryFrame, ids: Map<Node, number>): string {
  const nodeId = assignedId(node, ids);
  const scopeId = frame.returnScope === undefined ? 0 : assignedId(frame.returnScope, ids);
  const unquietIds = frame.unquietScopes.map((scope) => assignedId(scope, ids)).join(',');
  return `${nodeId}:${scopeId}:${unquietIds}`;
}

/** Looks up or allocates a dense positive integer ID for `node`. */
function assignedId(node: Node, ids: Map<Node, number>): number {
  const existing = ids.get(node);
  if (existing !== undefined) return existing;
  const created = ids.size + 1;
  ids.set(node, created);
  return created;
}

/** Evaluates branches, unmutated lexical bindings, local constructions, and local factories. */
function computeWrittenError(node: Expression, state: ProofState, frame: FactoryFrame): boolean {
  const { value } = framedValueShape(node);
  const inFactory = frame.returnScope !== undefined || frame.unquietScopes.length > 0;
  const branches = reachableValueBranches(value, inFactory);
  if (branches !== undefined) {
    return (
      branches.length > 0 && branches.every((each) => evaluateWrittenError(each, state, frame))
    );
  }
  if (isIdentifier(value)) {
    const resolved = state.resolveVariable(value, frame.returnScope);
    if (resolved === undefined) return false;
    const nextFrame: FactoryFrame = {
      returnScope: resolved.nextReturnScope,
      unquietScopes: frame.unquietScopes,
    };
    return evaluateWrittenError(resolved.initializer, state, nextFrame);
  }
  if (directLocalErrorConstruction(value)) {
    return validConstructedLeaf(node, value, state, frame);
  }
  const inner = nonInterceptingWrappedTarget(value);
  if (inner !== undefined) {
    return (
      !state.check(node, false) &&
      state.check(node, true) &&
      evaluateWrittenError(inner, state, frame)
    );
  }
  return isCallExpression(value) && evaluateFactoryCall(value, state, frame);
}

/** Conditional, comma, and logical expressions yield their reachable value branches. */
function reachableValueBranches(
  value: Expression,
  inFactory: boolean,
): readonly Expression[] | undefined {
  if (isConditionalExpression(value)) {
    if (inFactory && !sideEffectFreeExpression(value.condition)) return undefined;
    const branch = framedCondition(value.condition);
    if (branch === undefined) return [value.whenTrue, value.whenFalse];
    return [branch ? value.whenTrue : value.whenFalse];
  }
  return isBinaryExpression(value) ? binaryValueBranches(value, inFactory) : undefined;
}

/** Comma and short-circuiting binary operators retain every runtime-reachable operand. */
function binaryValueBranches(
  node: BinaryExpression,
  inFactory: boolean,
): readonly Expression[] | undefined {
  const kind = node.operatorToken.kind;
  if (kind === SyntaxKind.CommaToken) {
    return !inFactory || sideEffectFreeExpression(node.left) ? [node.right] : undefined;
  }
  if (kind === SyntaxKind.BarBarToken) {
    const branch = framedCondition(node.left);
    if (branch === undefined) return [node.left, node.right];
    return [branch ? node.left : node.right];
  }
  if (kind === SyntaxKind.AmpersandAmpersandToken) {
    const branch = framedCondition(node.left);
    if (branch === true) return [node.right];
    return branch === false ? [node.left] : [node.left, node.right];
  }
  return kind === SyntaxKind.QuestionQuestionToken
    ? nullishBranches(node.left, node.right)
    : undefined;
}

/** Selects the fallback for literal nullish left operands and keeps known non-nullish values. */
function nullishBranches(left: Expression, right: Expression): readonly Expression[] {
  const inner = unwrapped(left);
  if (
    inner.kind === SyntaxKind.NullKeyword ||
    isVoidExpression(inner) ||
    globalPathOf(inner)?.join('.') === 'undefined'
  ) {
    return [right];
  }
  if (
    inner.kind === SyntaxKind.TrueKeyword ||
    inner.kind === SyntaxKind.FalseKeyword ||
    isNewExpression(inner) ||
    constantValue(inner) !== undefined
  ) {
    return [left];
  }
  return [left, right];
}

/** Native Error creations and local own-word Error subclasses construct fresh local errors. */
function directLocalErrorConstruction(value: Expression): boolean {
  if (framedNativeErrorCreation(value, ERRORS, false)) return true;
  const targets = framedConstructionTargets(value);
  return (
    targets !== undefined &&
    targets.length > 0 &&
    targets.every((target) => {
      return (
        framedNativeConstructor(target, ERRORS) ||
        (framedSubclassConstructor(target, ERRORS) && framedSubclassOwnWords(target, ERRORS))
      );
    })
  );
}

/** Verifies local-word checks and guards against unproven enclosing factory parameter reads. */
function validConstructedLeaf(
  node: Expression,
  value: Expression,
  state: ProofState,
  frame: FactoryFrame,
): boolean {
  if (frame.unquietScopes.some((scope) => readsScopeParameter(value, scope))) {
    return false;
  }
  return !state.check(node, false) && state.check(node, true);
}

/** Requires a resolved synchronous local factory to return proven local Errors on every path. */
function evaluateFactoryCall(
  call: CallExpression,
  state: ProofState,
  frame: FactoryFrame,
): boolean {
  const invocation = framedWrittenFactoryCall(call, (callee) => localFactory(callee));
  if (invocation === undefined) return false;
  const { extra, fn, given, receiver } = invocation;
  if (
    fn.body === undefined ||
    answersLater(fn) ||
    state.activeFactories.has(fn) ||
    factoryMentionsThis(fn)
  ) {
    return false;
  }
  const inputs = receiver === undefined ? [...given, ...extra] : [receiver, ...given, ...extra];
  if (inputs.some((arg) => isSpreadElement(arg) || state.check(arg, false))) return false;
  if (extra.some((arg) => !sideEffectFreeExpression(arg))) return false;
  const returns = completeFactoryReturns(fn);
  if (returns === undefined || returns.length === 0) return false;
  const unquietScopes = quietFactoryCall(fn, given)
    ? frame.unquietScopes
    : appendUnquietScope(frame.unquietScopes, fn);
  const nextFrame: FactoryFrame = { returnScope: fn, unquietScopes };
  state.activeFactories.add(fn);
  try {
    return returns.every((ret) => evaluateWrittenError(ret, state, nextFrame));
  } finally {
    state.activeFactories.delete(fn);
  }
}

/** Retains enclosing unquiet factory scopes while adding `fn` once when its call is unquiet. */
function appendUnquietScope(scopes: readonly Answering[], fn: Answering): readonly Answering[] {
  return scopes.includes(fn) ? scopes : [...scopes, fn];
}

/** Resolves inline functions, unchanged function declarations, and whole `const` aliases. */
function localFactory(callee: Expression): Answering | undefined {
  const seen = new Set<Node>();
  let current = framedValueShape(callee).value;
  while (!seen.has(current)) {
    seen.add(current);
    if (isAnswering(current)) return current;
    if (!isIdentifier(current)) return undefined;
    const declared = frameDeclarationOf(current);
    if (declared === undefined) return undefined;
    if (isFunctionDeclaration(declared)) {
      return singleUnchangedFunctionBody(declared);
    }
    if (!isVariableDeclaration(declared) || declared.initializer === undefined) return undefined;
    const statement = declared.parent.parent;
    if (!isVariableStatement(statement) || !constantStatement(statement)) return undefined;
    current = framedValueShape(declared.initializer).value;
  }
  return undefined;
}

/** Collects every return expression of `fn` only when no control-flow path can fall through. */
function completeFactoryReturns(fn: Answering): readonly Expression[] | undefined {
  if (fn.body === undefined) return undefined;
  if (!isBlock(fn.body)) return [fn.body];
  const flow = blockFlow(fn.body.statements);
  return flow === undefined || flow.mayFallThrough ? undefined : flow.returns;
}

/** Evaluates sequential statements in a block until every remaining path has returned. */
function blockFlow(statements: readonly Statement[]): StatementFlow | undefined {
  const returns: Expression[] = [];
  for (const statement of statements) {
    const step = statementFlow(statement);
    if (step === undefined) return undefined;
    returns.push(...step.returns);
    if (!step.mayFallThrough) return { mayFallThrough: false, returns };
  }
  return { mayFallThrough: true, returns };
}

/** Single-statement control flow across returns, blocks, `if` branches, and pure declarations. */
function statementFlow(statement: Statement): StatementFlow | undefined {
  if (isReturnStatement(statement)) {
    return statement.expression === undefined
      ? undefined
      : { mayFallThrough: false, returns: [statement.expression] };
  }
  if (isBlock(statement)) return blockFlow(statement.statements);
  if (isIfStatement(statement)) return ifStatementFlow(statement);
  return transparentDeclaration(statement) ? { mayFallThrough: true, returns: [] } : undefined;
}

/** Combines reachable `if` / `else` branches, preserving fallthrough when `else` is absent. */
function ifStatementFlow(
  statement: Statement & { readonly expression: Expression },
): StatementFlow | undefined {
  if (!isIfStatement(statement) || !sideEffectFreeExpression(statement.expression)) {
    return undefined;
  }
  const condition = framedCondition(statement.expression);
  if (condition === true) return statementFlow(statement.thenStatement);
  if (condition === false) {
    return statement.elseStatement === undefined
      ? { mayFallThrough: true, returns: [] }
      : statementFlow(statement.elseStatement);
  }
  const thenFlow = statementFlow(statement.thenStatement);
  if (thenFlow === undefined) return undefined;
  const elseFlow =
    statement.elseStatement === undefined
      ? { mayFallThrough: true, returns: [] }
      : statementFlow(statement.elseStatement);
  if (elseFlow === undefined) return undefined;
  return {
    mayFallThrough: thenFlow.mayFallThrough || elseFlow.mayFallThrough,
    returns: [...thenFlow.returns, ...elseFlow.returns],
  };
}

/** Constant variable statements and local type/function declarations fall through linearly. */
function transparentDeclaration(statement: Statement): boolean {
  return (
    isFunctionDeclaration(statement) ||
    isTypeAliasDeclaration(statement) ||
    isInterfaceDeclaration(statement) ||
    (isVariableStatement(statement) && sideEffectFreeVariableStatement(statement))
  );
}
