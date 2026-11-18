import {
  type CallExpression,
  type Expression,
  type Identifier,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isForOfStatement,
  isPropertyAccessExpression,
  isSpreadElement,
  isVariableDeclarationList,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import type { Answering } from './answers.ts';
import { globalPathOf } from './code-globals.ts';
import { targetsOf } from './kept.ts';
import {
  arrayIndex,
  type ArrayScope,
  constArrayScope,
  mayRunBefore,
  restArrayScope,
} from './proxy-arrays.ts';
import { resolvesToContainerAlias } from './proxy-containers.ts';
import { helperCallScopes } from './proxy-helper-calls.ts';
import { type Origin, type OriginKey, peeled } from './proxy-values.ts';
import { isTypeOnly } from './scope.ts';
import { methodOf } from './written.ts';

/** Bound rest-parameter array context for mutation and element-origin recovery. */
export interface RestArrayTarget {
  readonly declared: Identifier;
  readonly fn: Answering;
  readonly given: readonly Origin[] | undefined;
  readonly name: Identifier;
}

interface ArrayWriteQuery {
  readonly elemTail: Origin;
  readonly firstKey: OriginKey | undefined;
  readonly matchesArray: (candidate: Expression) => boolean;
  readonly seenCalls: ReadonlySet<CallExpression>;
}

/** Assignment operators whose right-hand expression can become the target slot's value. */
const VALUE_ASSIGNMENTS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** Conservative origins for a mutated or escaped array constant read at `name`. */
export function mutatedArrayOrigins(
  name: Identifier,
  held: Expression,
  at: Origin,
): readonly Origin[] {
  const scope = constArrayScope(name);
  const written = scope === undefined ? [] : writtenArrayOrigins(scope, at, new Set());
  if (at.keys.length === 0) {
    return [{ ...at, excluded: undefined, value: held }, ...written];
  }
  const [firstKey, ...rest] = at.keys;
  if (firstKey === null || (firstKey !== undefined && arrayIndex(firstKey) !== undefined)) {
    return [{ ...at, keys: [null, ...rest], value: held }, ...written];
  }
  return written;
}

/** Conservative element and write origins for a mutated or escaped rest parameter read. */
export function mutatedRestOrigins(target: RestArrayTarget, at: Origin): readonly Origin[] {
  const { declared, fn, given, name } = target;
  const scope = restArrayScope(fn, declared, name);
  const written = scope === undefined ? [] : writtenArrayOrigins(scope, at, new Set());
  if (given === undefined) {
    return written;
  }
  if (at.keys.length === 0) {
    const initial = given.map((each) => ({ ...each, excluded: undefined, spread: undefined }));
    return [...initial, ...written];
  }
  const [firstKey, ...rest] = at.keys;
  if (firstKey === null || (firstKey !== undefined && arrayIndex(firstKey) !== undefined)) {
    const initial = given.map((each) => {
      return {
        ...each,
        excluded: at.excluded,
        keys: [...each.keys, ...rest],
        spread: at.spread,
      };
    });
    return [...initial, ...written];
  }
  return written;
}

/** Collects element/property expressions written into `scope` before `scope.readSite`. */
function writtenArrayOrigins(
  scope: ArrayScope,
  at: Origin,
  seenCalls: ReadonlySet<CallExpression>,
  restContainers?: ReadonlySet<Identifier>,
): readonly Origin[] {
  const firstKey = at.keys[0];
  if (firstKey === 'length') {
    return [];
  }
  const elemTail: Origin =
    at.keys.length === 0
      ? { ...at, excluded: undefined, keys: [], spread: undefined }
      : { ...at, keys: at.keys.slice(1) };
  const query: ArrayWriteQuery = {
    elemTail,
    firstKey,
    matchesArray: (candidate) =>
      resolvesToContainerAlias(candidate, scope, at.context, restContainers),
    seenCalls,
  };
  const found: Origin[] = [];
  const visit = (node: Node): void => {
    if (isTypeOnly(node)) {
      return;
    }
    if (mayRunBefore(node, scope)) {
      found.push(...nodeArrayWriteOrigins(node, query, at));
    }
    node.forEachChild(visit);
  };
  scope.owner.forEachChild(visit);
  return found;
}

/** Extracts origins written into `query.matchesArray` by an assignment, loop, or call. */
function nodeArrayWriteOrigins(node: Node, query: ArrayWriteQuery, at: Origin): readonly Origin[] {
  const { elemTail, firstKey, matchesArray } = query;
  if (isBinaryExpression(node) && VALUE_ASSIGNMENTS.has(node.operatorToken.kind)) {
    return binaryArrayWriteOrigins(node.left, node.right, matchesArray, elemTail);
  }
  if (
    isForOfStatement(node) &&
    !isVariableDeclarationList(node.initializer) &&
    targetsArrayElement(node.initializer, matchesArray)
  ) {
    return [{ ...elemTail, keys: [null, ...elemTail.keys], value: node.expression }];
  }
  if (!isCallExpression(node)) {
    return [];
  }
  const namedProperty =
    firstKey !== undefined && firstKey !== null && arrayIndex(firstKey) === undefined;
  return [
    ...callArrayWriteOrigins(node, matchesArray, elemTail, namedProperty),
    ...helperParameterArrayWrites(node, query, at),
  ];
}

/** Propagates element writes performed through helper-call formal parameters onto `at`. */
function helperParameterArrayWrites(
  call: CallExpression,
  query: ArrayWriteQuery,
  at: Origin,
): readonly Origin[] {
  const boundScopes = helperCallScopes(call, query.matchesArray, query.elemTail, query.seenCalls);
  if (boundScopes.length === 0) {
    return [];
  }
  const nextSeenCalls = new Set([...query.seenCalls, call]);
  return boundScopes.flatMap((bound) => {
    return writtenArrayOrigins(
      bound.scope,
      { ...at, context: bound.childContext },
      nextSeenCalls,
      bound.restContainers,
    );
  });
}

/** Extracts element origins from direct or destructured member assignments onto `matchesArray`. */
function binaryArrayWriteOrigins(
  left: Expression,
  right: Expression,
  matchesArray: (candidate: Expression) => boolean,
  elemTail: Origin,
): readonly Origin[] {
  const target = peeled(left);
  if (
    (isElementAccessExpression(target) || isPropertyAccessExpression(target)) &&
    matchesArray(target.expression)
  ) {
    return isPropertyAccessExpression(target) && target.name.text === 'length'
      ? []
      : [{ ...elemTail, value: right }];
  }
  return targetsArrayElement(target, matchesArray)
    ? [{ ...elemTail, keys: [null, ...elemTail.keys], value: right }]
    : [];
}

/** Checks whether any destructuring target inside `pattern` writes into `matchesArray`. */
function targetsArrayElement(
  pattern: Node,
  matchesArray: (candidate: Expression) => boolean,
): boolean {
  return targetsOf(pattern).some((each) => {
    return (
      (isElementAccessExpression(each) || isPropertyAccessExpression(each)) &&
      matchesArray(each.expression)
    );
  });
}

/** Extracts inserted element origins from array mutator methods and `Object.assign`/`Reflect.set`. */
function callArrayWriteOrigins(
  call: CallExpression,
  matchesArray: (candidate: Expression) => boolean,
  elemTail: Origin,
  namedProperty: boolean,
): readonly Origin[] {
  const globalPath = globalPathOf(peeled(call.expression))?.join('.');
  const [firstArg, , thirdArg] = call.arguments;
  if (
    globalPath === 'Object.assign' &&
    firstArg !== undefined &&
    !isSpreadElement(firstArg) &&
    matchesArray(firstArg)
  ) {
    return call.arguments.slice(1).map((arg) => {
      return {
        ...elemTail,
        keys: [null, ...elemTail.keys],
        value: isSpreadElement(arg) ? arg.expression : arg,
      };
    });
  }
  if (
    globalPath === 'Reflect.set' &&
    firstArg !== undefined &&
    !isSpreadElement(firstArg) &&
    matchesArray(firstArg)
  ) {
    return thirdArg === undefined ? [] : [argumentElementOrigin(thirdArg, elemTail)];
  }
  return namedProperty ? [] : methodArrayWriteOrigins(call, matchesArray, elemTail);
}

/** Extracts inserted elements from `push`, `unshift`, `splice`, and `fill` calls on `matchesArray`. */
function methodArrayWriteOrigins(
  call: CallExpression,
  matchesArray: (candidate: Expression) => boolean,
  elemTail: Origin,
): readonly Origin[] {
  const callee = peeled(call.expression);
  if (
    (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) ||
    !matchesArray(callee.expression)
  ) {
    return [];
  }
  const method = methodOf(call);
  if (method === 'push' || method === 'unshift') {
    return call.arguments.map((arg) => argumentElementOrigin(arg, elemTail));
  }
  if (method === 'splice') {
    const inserted = call.arguments.slice(0, 2).some((arg) => isSpreadElement(arg))
      ? call.arguments
      : call.arguments.slice(2);
    return inserted.map((arg) => argumentElementOrigin(arg, elemTail));
  }
  if (method === 'fill') {
    const [first] = call.arguments;
    return first === undefined ? [] : [argumentElementOrigin(first, elemTail)];
  }
  return [];
}

/** Converts a call argument (or spread argument) into an inserted element origin. */
function argumentElementOrigin(arg: Expression, elemTail: Origin): Origin {
  return isSpreadElement(arg)
    ? { ...elemTail, keys: [null, ...elemTail.keys], value: arg.expression }
    : { ...elemTail, value: arg };
}
