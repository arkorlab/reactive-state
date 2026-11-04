import {
  type CallExpression,
  type Expression,
  type GetAccessorDeclaration,
  type IfStatement,
  isArrowFunction,
  isBlock,
  isBreakStatement,
  isContinueStatement,
  isCallExpression,
  isExpression,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIfStatement,
  isObjectLiteralExpression,
  isReturnStatement,
  isSpreadElement,
  isSpreadAssignment,
  isSetAccessorDeclaration,
  isThrowStatement,
  isSwitchStatement,
  type Node,
  type ObjectLiteralExpression,
  type Statement,
  type TryStatement,
} from 'typescript/ast';

import { type Answering, answersLater, eagerBody, isAnswering } from './answers.ts';
import { calledMember, unwrapped } from './bounded.ts';
import { runsLater } from './deferred-syntax.ts';
import { globalPath } from './global-answers.ts';
import type { Resolve } from './numbers.ts';
import { skipsEvaluation } from './skipped-evaluation.ts';
import { arrayCallbackCount } from './throw-array-callback-counts.ts';
import { arrayLocaleFunction } from './throw-array-locales.ts';
import { assignTargetSetter } from './throw-assign-setters.ts';
import { bindingGetter, destructuringThrows } from './throw-bindings.ts';
import { borrowedArrayGetter } from './throw-borrowed-array-getters.ts';
import {
  branchThrows,
  computedBy,
  finallyReturns,
  isBranchStatement,
  knownBranch,
  loopHeaderThrows,
  statementsThrowing,
  switchEnding,
} from './throw-branches.ts';
import { CALLING } from './throw-callback-methods.ts';
import { heritageThrows, type EagerClass, eagerClassOf } from './throw-classes.ts';
import { coercionFunction } from './throw-coercions.ts';
import { collectionCallback } from './throw-collection-callbacks.ts';
import { comparatorResultThrows } from './throw-comparator-results.ts';
import { constructionThrows } from './throw-constructions.ts';
import { descriptorGetterFunction } from './throw-descriptor-getters.ts';
import { optionsThrowing } from './throw-errors.ts';
import { factoryMapper, factoryResultThrows } from './throw-factory-mappers.ts';
import { ownReadGetter } from './throw-getters.ts';
import { groupingKeyResultThrows } from './throw-groupby-keys.ts';
import { iterationSyntaxThrows } from './throw-iteration-syntax.ts';
import { consumedIteratorFunction } from './throw-iteration.ts';
import { iteratorCloseFunction } from './throw-iterator-close.ts';
import { iteratorResultThrows } from './throw-iterator-results.ts';
import { jsonCycleThrows } from './throw-json-cycles.ts';
import { jsonReplacerResultThrows } from './throw-json-replacer-results.ts';
import { jsonReviverFunction } from './throw-json-revivers.ts';
import { enumerationKey, ordinaryAssignKeys, propertyKeyThrows } from './throw-keys.ts';
import { nativeArgumentThrows } from './throw-native-arguments.ts';
import { nativeCollectionThrows } from './throw-native-collections.ts';
import { consumedNextFunction } from './throw-next.ts';
import { objectTagGetter } from './throw-object-tags.ts';
import { instanceHookFunction } from './throw-operators.ts';
import { invocationInitializationThrows } from './throw-parameters.ts';
import { privateBrandThrows } from './throw-private-brands.ts';
import {
  proxyOperationFunction,
  proxyOperationResultThrows,
  proxyReadFunction,
} from './throw-proxies.ts';
import { shortedReceiver, strictArgumentsRead } from './throw-reads.ts';
import { setKeysFunction, setKeysResultThrows } from './throw-sets.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';
import { replacementFunction, replacementResultThrows } from './throw-string-callbacks.ts';
import { stringProtocolFunction, stringProtocolThrows } from './throw-string-protocols.ts';
import { isSymbolWritten } from './throw-symbols.ts';
import { tdzCallThrows } from './throw-tdz-reads.ts';
import { assignmentSetter } from './throw-writes.ts';
import { throwsWithin } from './throws.ts';

/**
 * Whether a function the compile reads throws each time it is called, before it answers — of a
 * `throw` its code reaches whatever it is given, or of what its code computes there of what it
 * writes (`throwsWithin`) — which faults what calls it as surely as what it would return.
 */

/** How a statement ends the function it stands in: it throws, it may return, or it runs on. */
type Ending = 'returns' | 'runs' | 'throws';

/**
 * Whether `fn`, a function the compile reads, throws each time it is called, before it answers — of a
 * `throw` its code reaches whatever it is given, `function make() { throw new Error('bad') }`, or of
 * what its code computes there of what it writes, `decodeURIComponent('%')` (`throwsWithin`) — the
 * names it reads as what `resolve` answers they hold; none of one that may return first.
 */
export function throwsAlways(fn: Node, resolve: Resolve | undefined): boolean {
  const body = 'body' in fn ? (fn.body as Node | undefined) : undefined;
  return body !== undefined && isBlock(body) && endingOf(body.statements, resolve) === 'throws';
}

/** How `statements`, run in turn, end the function they stand in (`Ending`). */
function endingOf(statements: readonly Statement[], resolve: Resolve | undefined): Ending {
  for (const statement of statements) {
    const ending = statementEnding(statement, resolve);
    if (ending !== 'runs') {
      return ending;
    }
  }
  return 'runs';
}

/**
 * How `statement` ends the function it stands in: a `throw`, a branch of which each throws, what
 * throws as it is computed; a `return`, or what may leave it, a `break` among them; else it runs on.
 */
function statementEnding(statement: Statement, resolve: Resolve | undefined): Ending {
  if (
    isThrowStatement(statement) ||
    destructuringThrows(statement, resolve) ||
    loopHeaderThrows(statement, resolve, throwsWithin)
  ) {
    return 'throws';
  }
  if (isBlock(statement)) {
    return endingOf(statement.statements, resolve);
  }
  if (isIfStatement(statement)) {
    return ifEnding(statement, resolve);
  }
  if (isSwitchStatement(statement)) {
    return switchEnding(statement, resolve, endingOf, throwsWithin);
  }
  if (isReturnStatement(statement)) {
    return statement.expression === undefined ||
      throwsWithin(statement.expression, resolve) === undefined
      ? 'returns'
      : 'throws';
  }
  const computed = computedBy(statement);
  if (computed !== undefined) {
    return computed.some((each) => throwsWithin(each, resolve) !== undefined) ? 'throws' : 'runs';
  }
  return mayLeave(statement) ? 'returns' : 'runs';
}

/**
 * How `statement`, an `if`, ends the function it stands in: it throws where its test throws, or each
 * branch does; it may return where a branch may; else it runs on.
 */
function ifEnding(statement: IfStatement, resolve: Resolve | undefined): Ending {
  if (throwsWithin(statement.expression, resolve) !== undefined) {
    return 'throws';
  }
  const branch = knownBranch(statement, resolve);
  if (branch !== undefined) {
    return endingOf(branch, resolve);
  }
  const then = statementEnding(statement.thenStatement, resolve);
  const otherwise =
    statement.elseStatement === undefined
      ? 'runs'
      : statementEnding(statement.elseStatement, resolve);
  if (then === 'throws' && otherwise === 'throws') {
    return 'throws';
  }
  return then === 'returns' || otherwise === 'returns' ? 'returns' : 'runs';
}

/**
 * Whether `statement` may leave the function it stands in otherwise than by throwing: a `return`, or
 * a `break` or `continue` out of what holds it, within it — a function written within it aside.
 */
function mayLeave(statement: Node): boolean {
  if (
    isReturnStatement(statement) ||
    isBreakStatement(statement) ||
    isContinueStatement(statement)
  ) {
    return true;
  }
  let found = false;
  statement.forEachChild((child) => {
    found ||= !runsLater(child) && mayLeave(child);
  });
  return found;
}

/**
 * The call within `node` of `JSON.stringify`, which calls its replacer for the root value, or of a
 * method of an array the code writes of elements (`CALLING`) — enough
 * that it calls the function it is given — whose function throws each time it is called: of a
 * block, `throwsAlways`; of an expression, what it computes (`throwsWithin`) — `[first].filter(()
 * => { throw new Error('bad') })`, or a constructor's consumed options getter — wherever
 * the code computes it as it computes `node`, including an immediately invoked synchronous body,
 * but within a deferred function the code writes there; none where none throws.
 */
export function callbackThrowsWithin(
  node: Node,
  resolve: Resolve | undefined,
  functionOf?: (callee: Expression) => Answering | undefined,
  constructing = new Set<Node>(),
): Node | undefined {
  const visit = (each: Node): Node | undefined => {
    if (skipsEvaluation(each, resolve)) {
      return undefined;
    }
    if (heritageThrows(each, resolve)) {
      return each;
    }
    const eager = eagerClassOf(each);
    if (eager !== undefined) {
      return eagerThrows(eager, resolve, visit);
    }
    if (runsLater(each)) {
      return undefined;
    }
    const receiver = shortedReceiver(each, resolve);
    if (receiver !== undefined) {
      return visit(receiver);
    }
    const constructed = constructionThrows(each, resolve, constructing, (part, where) => {
      const thrown = isExpression(part) ? throwsWithin(part, where) : undefined;
      return (
        thrown ??
        (where === resolve
          ? visit(part)
          : callbackThrowsWithin(part, where, undefined, constructing))
      );
    });
    if (constructed !== undefined) {
      return constructed;
    }
    if (isBlock(each)) {
      return statementsThrowing(each.statements, resolve, visit, statementEnding);
    }
    if (isBranchStatement(each)) {
      return branchThrows(each, resolve, {
        visit,
        ending: statementEnding,
        escape: (part) => escapingTry(part, resolve, visit),
      });
    }
    if (
      isCallExpression(each) &&
      (callsThrowing(each, resolve) ||
        stringifiesThrowing(each, resolve, functionOf) ||
        assignsThrowing(each, resolve) ||
        enumeratesThrowing(each, resolve))
    ) {
      return each;
    }
    if (operationThrows(each, resolve)) {
      return each;
    }
    const body = eagerBody(each);
    return (body === undefined ? undefined : visit(body)) ?? each.forEachChild(visit);
  };
  return visit(node);
}

/** Binding and synchronous consumption operations that execute before their result is read. */
function operationThrows(node: Node, resolve: Resolve | undefined): boolean {
  return (
    privateBrandThrows(node, resolve) ||
    nativeArgumentThrows(node, resolve) ||
    nativeCollectionThrows(node, resolve) ||
    proxyOperationResultThrows(node, resolve) ||
    strictArgumentsRead(node, resolve) ||
    groupingKeyResultThrows(node, resolve) ||
    tdzCallThrows(node, resolve) ||
    jsonCycleThrows(node, resolve) ||
    comparatorResultThrows(node, resolve) ||
    stringProtocolThrows(node, resolve) ||
    invokesThrowing(stringProtocolFunction(node, resolve), resolve) ||
    iterationSyntaxThrows(node, resolve) ||
    iteratorResultThrows(node, resolve) ||
    destructuringThrows(node, resolve) ||
    invocationInitializationThrows(node, resolve, (expression, where) => {
      return (
        throwsWithin(expression, where) !== undefined ||
        callbackThrowsWithin(expression, where) !== undefined
      );
    }) ||
    callbackOperationsThrow(node, resolve) ||
    iteratorThrows(node, resolve) ||
    invokesThrowing(assignmentSetter(node, resolve), resolve) ||
    (isSpreadAssignment(node) && assignSourceEffect(node.expression, resolve) === 'throws')
  );
}

/** Native callbacks consumed by the operation whose synchronous work is known to throw. */
function callbackOperationsThrow(node: Node, resolve: Resolve | undefined): boolean {
  return (
    invokesThrowing(arrayLocaleFunction(node, resolve), undefined) ||
    optionsThrowing(node, resolve, (each) => throwsAlways(each, resolve)) ||
    invokesThrowing(proxyReadFunction(node, resolve), resolve) ||
    invokesThrowing(proxyOperationFunction(node, resolve), undefined) ||
    invokesThrowing(ownReadGetter(node, resolve), resolve) ||
    invokesThrowing(bindingGetter(node, resolve), undefined) ||
    invokesThrowing(borrowedArrayGetter(node, resolve), undefined) ||
    invokesThrowing(descriptorGetterFunction(node, resolve), undefined) ||
    invokesThrowing(assignTargetSetter(node, resolve), undefined) ||
    invokesThrowing(objectTagGetter(node, resolve), undefined) ||
    invokesThrowing(iteratorCloseFunction(node, resolve), undefined) ||
    invokesThrowing(instanceHookFunction(node, resolve), resolve) ||
    invokesThrowing(factoryMapper(node, resolve), resolve) ||
    factoryResultThrows(node, resolve) ||
    jsonReplacerResultThrows(node, resolve) ||
    invokesThrowing(jsonReviverFunction(node, resolve), undefined) ||
    invokesThrowing(replacementFunction(node, resolve), resolve) ||
    replacementResultThrows(node, resolve) ||
    invokesThrowing(collectionCallback(node, resolve), resolve) ||
    invokesThrowing(coercionFunction(node, resolve), resolve)
  );
}

/** A class's definition-time work, with static blocks retaining their own exception boundaries. */
function eagerThrows(
  eager: EagerClass,
  resolve: Resolve | undefined,
  visit: (node: Node) => Node | undefined,
): Node | undefined {
  for (const key of eager.keys) {
    if (propertyKeyThrows(key, resolve)) {
      return key;
    }
    const thrown = throwsWithin(key.expression, resolve) ?? visit(key.expression);
    if (thrown !== undefined) {
      return thrown;
    }
  }
  for (const expression of eager.expressions) {
    const thrown = throwsWithin(expression, resolve) ?? visit(expression);
    if (thrown !== undefined) {
      return thrown;
    }
  }
  return eager.blocks.find((block) => visit(block) !== undefined);
}

/** A catch handles its try's exceptions; a finalizer's returning path can override the earlier throw. */
function escapingTry(
  statement: TryStatement,
  resolve: Resolve | undefined,
  visit: (node: Node) => Node | undefined,
): Node | undefined {
  const final = statement.finallyBlock;
  if (final !== undefined && endingOf(final.statements, resolve) === 'throws') {
    return final;
  }
  if (
    final !== undefined &&
    finallyReturns(final, resolve, (each) => statementEnding(each, resolve) === 'returns')
  ) {
    return visit(final);
  }
  const attempted = visit(statement.tryBlock);
  const caught = statement.catchClause;
  if (caught === undefined) {
    return attempted ?? (final === undefined ? undefined : visit(final));
  }
  const throws =
    attempted !== undefined || endingOf(statement.tryBlock.statements, resolve) === 'throws';
  if (throws && endingOf(caught.block.statements, resolve) === 'throws') {
    return caught.block;
  }
  const escaping = throws ? visit(caught) : undefined;
  return escaping ?? (final === undefined ? undefined : visit(final));
}

/** Native iterator consumers call their providers and resume synchronous generators. */
function iteratorThrows(node: Node, resolve: Resolve | undefined): boolean {
  if (
    invokesThrowing(consumedNextFunction(node, resolve), resolve) ||
    invokesThrowing(setKeysFunction(node, resolve), resolve) ||
    setKeysResultThrows(node, resolve)
  ) {
    return true;
  }
  const invocation = consumedIteratorFunction(node, resolve);
  if (invocation === undefined) {
    return false;
  }
  const { fn, resumes } = invocation;
  return (
    invocation.invalid === true ||
    invokesThrowing(fn, resolve) ||
    (resumes && throwsAlways(fn, resolve))
  );
}

/** Whether an invoked source function throws before returning its synchronous result. */
function invokesThrowing(fn: Node | undefined, resolve: Resolve | undefined): boolean {
  if (fn !== undefined && isSetAccessorDeclaration(fn)) {
    return throwsAlways(fn, resolve);
  }
  return (
    fn !== undefined &&
    isAnswering(fn) &&
    !answersLater(fn) &&
    (throwsAlways(fn, resolve) ||
      (isArrowFunction(fn) && !isBlock(fn.body) && throwsWithin(fn.body, resolve) !== undefined))
  );
}

/** Whether Object.assign reads a source getter known to throw before any other getter or target setter. */
function assignsThrowing(call: CallExpression, resolve: Resolve | undefined): boolean {
  const [target, ...sources] = call.arguments;
  if (
    target === undefined ||
    globalPath(unwrapped(call.expression))?.join('.') !== 'Object.assign' ||
    call.arguments.some((each) => isSpreadElement(each))
  ) {
    return false;
  }
  const into = writtenOf(target, resolve);
  if (
    !isObjectLiteralExpression(into) ||
    !ordinaryAssignKeys(into, resolve) ||
    into.properties.some(
      (property) => isGetAccessorDeclaration(property) || isSetAccessorDeclaration(property),
    )
  ) {
    return false;
  }
  for (const source of sources) {
    const effect = assignSourceEffect(source, resolve);
    if (effect !== 'safe') {
      return effect === 'throws';
    }
  }
  return false;
}

/** Whether a source throws, copies without running code, or may change what a later source holds. */
function assignSourceEffect(
  source: Expression,
  resolve: Resolve | undefined,
): 'safe' | 'throws' | 'unknown' {
  const value = writtenOf(source, resolve);
  if (primitiveOf(value, resolve) !== undefined || isSymbolWritten(value, resolve)) {
    return 'safe';
  }
  if (!isObjectLiteralExpression(value)) {
    return 'unknown';
  }
  const [only] = value.properties;
  // Assign copies symbols too; a sole accessor has no property that could replace it first.
  if (only !== undefined && value.properties.length === 1 && isGetAccessorDeclaration(only)) {
    return throwsAlways(only, resolve) ? 'throws' : 'unknown';
  }
  if (!ordinaryAssignKeys(value, resolve)) {
    return 'unknown';
  }
  if (hasThrowingGetter(value, resolve)) {
    return 'throws';
  }
  return value.properties.some((property) => isGetAccessorDeclaration(property))
    ? 'unknown'
    : 'safe';
}

/**
 * Whether `Object.values` or `Object.entries` calls an own enumerable getter written there that
 * throws each time. Later data properties and getters replace earlier getters; setters keep them.
 * Symbol keys are not enumerated, and unknown spreads or keys may replace preceding properties.
 */
function enumeratesThrowing(call: CallExpression, resolve: Resolve | undefined): boolean {
  const path = globalPath(unwrapped(call.expression))?.join('.');
  const [given] = call.arguments;
  if (given === undefined || (path !== 'Object.values' && path !== 'Object.entries')) {
    return false;
  }
  const value = writtenOf(given, resolve);
  return isObjectLiteralExpression(value) && hasThrowingGetter(value, resolve);
}

/** Whether a sole own getter survives later properties of `object` and always throws. */
function hasThrowingGetter(object: ObjectLiteralExpression, resolve: Resolve | undefined): boolean {
  const seen = new Set<string>();
  const getters: GetAccessorDeclaration[] = [];
  for (const property of object.properties.toReversed()) {
    if (isSpreadAssignment(property)) {
      return false;
    }
    const key = enumerationKey(property.name, resolve);
    if (key === null) {
      continue;
    }
    if (key === undefined) {
      return false;
    }
    if (isSetAccessorDeclaration(property) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (isGetAccessorDeclaration(property)) {
      getters.push(property);
    }
  }
  // Another getter may delete or replace a later entry before the enumeration reads it.
  const [first, second] = getters;
  return first !== undefined && second === undefined && throwsAlways(first, resolve);
}

/** Whether `call`, of `JSON.stringify`, calls a replacer that throws for its root value. */
function stringifiesThrowing(
  call: CallExpression,
  resolve: Resolve | undefined,
  functionOf: ((callee: Expression) => Answering | undefined) | undefined,
): boolean {
  const [value, replacer] = call.arguments;
  if (
    value === undefined ||
    replacer === undefined ||
    globalPath(unwrapped(call.expression))?.join('.') !== 'JSON.stringify' ||
    isSpreadElement(value) ||
    isSpreadElement(replacer)
  ) {
    return false;
  }
  const fn = functionOf?.(replacer) ?? writtenOf(replacer, resolve);
  if (!isAnswering(fn) || answersLater(fn)) {
    return false;
  }
  // A function imported from another module reads that module's constants, never the caller's.
  const follow = fn.getSourceFile() === call.getSourceFile() ? resolve : undefined;
  return (
    throwsAlways(fn, follow) ||
    (isArrowFunction(fn) && !isBlock(fn.body) && throwsWithin(fn.body, follow) !== undefined)
  );
}

/** Whether `call` calls the function it is given for elements the code writes (`CALLING`), which throws. */
function callsThrowing(call: CallExpression, resolve: Resolve | undefined): boolean {
  const member = calledMember(unwrapped(call.expression));
  const least = member === undefined ? undefined : CALLING.get(member.name);
  const [given] = call.arguments;
  if (
    least === undefined ||
    member === undefined ||
    given === undefined ||
    isSpreadElement(given)
  ) {
    return false;
  }
  const initial = call.arguments[1];
  const minimum =
    initial !== undefined &&
    !isSpreadElement(initial) &&
    (member.name === 'reduce' || member.name === 'reduceRight')
      ? 1
      : least;
  const fn = writtenOf(given, resolve);
  if (
    arrayCallbackCount(member.of, member.name, resolve) < minimum ||
    !(isArrowFunction(fn) || isFunctionExpression(fn)) ||
    answersLater(fn)
  ) {
    return false;
  }
  return isBlock(fn.body)
    ? throwsAlways(fn, resolve)
    : throwsWithin(fn.body, resolve) !== undefined;
}
