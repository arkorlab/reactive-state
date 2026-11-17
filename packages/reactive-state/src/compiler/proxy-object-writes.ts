import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrowFunction,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isExpression,
  isForOfStatement,
  isFunctionExpression,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSpreadElement,
  type Node,
  type ObjectLiteralElementLike,
  SyntaxKind,
} from 'typescript/ast';

import { isAnswering, returnedBy } from './answers.ts';
import { globalPathOf } from './code-globals.ts';
import { targetsOf } from './kept.ts';
import { type ArrayScope, mayRunBefore } from './proxy-arrays.ts';
import { resolvesToContainerAlias } from './proxy-containers.ts';
import { helperCallScopes } from './proxy-helper-calls.ts';
import { constObjectScope, overwrittenPlainKeys } from './proxy-objects.ts';
import { patternTargetOrigins } from './proxy-parameter-patterns.ts';
import {
  type Context,
  type Origin,
  type OriginKey,
  originKey,
  peeled,
  propertyKey,
} from './proxy-values.ts';
import { isTypeOnly } from './scope.ts';

export { holdsObjectLiteral, objectChangedBefore } from './proxy-objects.ts';

interface ObjectWriteQuery {
  readonly baseTail: Origin;
  readonly matchesObject: (candidate: Expression) => boolean;
  readonly seenCalls: ReadonlySet<CallExpression>;
}

/** Assignment operators whose right-hand expression can become a property's value. */
const VALUE_ASSIGNMENTS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** Conservative initial and written property origins for a mutated or escaped object constant. */
export function mutatedObjectOrigins(
  name: Identifier,
  held: Expression,
  at: Origin,
): readonly Origin[] {
  const scope = constObjectScope(name);
  const overwritten =
    scope === undefined ? new Set<string>() : overwrittenPlainKeys(name, held, scope, at.context);
  const initial = initialObjectOrigins(held, at, overwritten);
  const written = scope === undefined ? [] : writtenObjectOrigins(scope, at, new Set());
  return [...initial, ...written];
}

/** Retains surviving initial object origins after excluding unconditionally overwritten keys. */
function initialObjectOrigins(
  held: Expression,
  at: Origin,
  overwritten: ReadonlySet<string>,
): readonly Origin[] {
  if (at.keys.length === 0) {
    if (overwritten.size === 0) {
      return [{ ...at, value: held }];
    }
    const excluded = new Set(at.excluded);
    for (const key of overwritten) {
      excluded.add(key);
    }
    return [{ ...at, excluded, value: held }];
  }
  const [firstKey] = at.keys;
  if (firstKey !== undefined && firstKey !== null && overwritten.has(firstKey)) {
    return [];
  }
  return [{ ...at, value: held }];
}

/** Collects property value origins written onto `scope` before `scope.readSite`. */
function writtenObjectOrigins(
  scope: ArrayScope,
  at: Origin,
  seenCalls: ReadonlySet<CallExpression>,
  restContainers?: ReadonlySet<Identifier>,
): readonly Origin[] {
  const baseTail: Origin = { ...at, excluded: undefined, keys: [], spread: undefined };
  const query: ObjectWriteQuery = {
    baseTail,
    matchesObject: (candidate) =>
      resolvesToContainerAlias(candidate, scope, at.context, restContainers),
    seenCalls,
  };
  const found: Origin[] = [];
  const visit = (node: Node): void => {
    if (isTypeOnly(node)) {
      return;
    }
    if (mayRunBefore(node, scope)) {
      found.push(...nodeObjectWriteOrigins(node, query, at));
    }
    node.forEachChild(visit);
  };
  scope.owner.forEachChild(visit);
  return found;
}

/** Extracts property origins written onto `query.matchesObject` by an assignment, loop, or call. */
function nodeObjectWriteOrigins(
  node: Node,
  query: ObjectWriteQuery,
  at: Origin,
): readonly Origin[] {
  if (isBinaryExpression(node) && VALUE_ASSIGNMENTS.has(node.operatorToken.kind)) {
    return binaryObjectWriteOrigins(node.left, node.right, query, at);
  }
  if (isForOfStatement(node) && isExpression(node.initializer)) {
    const loopSource: Origin = { ...query.baseTail, keys: [null], value: node.expression };
    return destructuredMemberWriteOrigins(node.initializer, loopSource, query, at);
  }
  if (!isCallExpression(node)) {
    return [];
  }
  return [
    ...callObjectWriteOrigins(node, query, at),
    ...helperParameterObjectWrites(node, query, at),
  ];
}

/** Propagates property writes performed through helper-call formal parameters onto `at`. */
function helperParameterObjectWrites(
  call: CallExpression,
  query: ObjectWriteQuery,
  at: Origin,
): readonly Origin[] {
  const boundScopes = helperCallScopes(call, query.matchesObject, query.baseTail, query.seenCalls);
  if (boundScopes.length === 0) {
    return [];
  }
  const nextSeenCalls = new Set([...query.seenCalls, call]);
  return boundScopes.flatMap((bound) => {
    return writtenObjectOrigins(
      bound.scope,
      { ...at, context: bound.childContext },
      nextSeenCalls,
      bound.restContainers,
    );
  });
}

/** Extracts written property origins from direct, nested, or destructured assignments. */
function binaryObjectWriteOrigins(
  left: Expression,
  right: Expression,
  query: ObjectWriteQuery,
  at: Origin,
): readonly Origin[] {
  const memberKeys = matchWrittenMemberKeys(left, query.matchesObject, at.context);
  if (memberKeys !== undefined) {
    return projectWrittenMember(memberKeys, right, at);
  }
  const rhsSource: Origin = { ...query.baseTail, value: right };
  return destructuredMemberWriteOrigins(left, rhsSource, query, at);
}

/** Projects destructuring member targets (e.g. `[obj.p] = [v]`) against `rhsSource`. */
function destructuredMemberWriteOrigins(
  pattern: Expression,
  rhsSource: Origin,
  query: ObjectWriteQuery,
  at: Origin,
): readonly Origin[] {
  const found: Origin[] = [];
  for (const target of targetsOf(pattern)) {
    if (!isPropertyAccessExpression(target) && !isElementAccessExpression(target)) {
      continue;
    }
    const memberKeys = matchWrittenMemberKeys(target, query.matchesObject, at.context);
    if (memberKeys === undefined) {
      continue;
    }
    const projectedRead = tailForMemberWrite(memberKeys, at);
    if (projectedRead !== undefined) {
      const leaf = peeled(target);
      found.push(
        ...patternTargetOrigins(
          pattern,
          rhsSource,
          projectedRead,
          (candidate) => candidate === leaf,
        ),
      );
    }
  }
  return found;
}

/** Returns the member key path written on `matchesObject` when `target` is a member of it. */
function matchWrittenMemberKeys(
  target: Expression,
  matchesObject: (candidate: Expression) => boolean,
  context: Context,
): readonly OriginKey[] | undefined {
  let current = peeled(target);
  const keys: OriginKey[] = [];
  while (isPropertyAccessExpression(current) || isElementAccessExpression(current)) {
    const key = isPropertyAccessExpression(current)
      ? current.name.text
      : (originKey(current.argumentExpression, context) ?? null);
    keys.unshift(key);
    if (matchesObject(current.expression)) {
      return keys;
    }
    current = peeled(current.expression);
  }
  return undefined;
}

/** Aligns `memberKeys` with `at.keys` and returns the remaining read `Origin` when compatible. */
function tailForMemberWrite(memberKeys: readonly OriginKey[], at: Origin): Origin | undefined {
  if (at.keys.length === 0) {
    const [onlyKey] = memberKeys;
    const isExcluded =
      onlyKey !== undefined && onlyKey !== null && at.excluded?.has(onlyKey) === true;
    if (isExcluded && memberKeys.length === 1) {
      return undefined;
    }
    return { ...at, excluded: undefined, keys: [], spread: undefined };
  }
  const shared = Math.min(memberKeys.length, at.keys.length);
  for (let i = 0; i < shared; i += 1) {
    const written = memberKeys[i];
    const read = at.keys[i];
    if (written !== null && read !== null && written !== read) {
      return undefined;
    }
  }
  return memberKeys.length <= at.keys.length
    ? { ...at, keys: at.keys.slice(memberKeys.length) }
    : { ...at, excluded: undefined, keys: [], spread: undefined };
}

/** Projects a written `rhs` expression at `memberKeys` through `at`. */
function projectWrittenMember(
  memberKeys: readonly OriginKey[],
  rhs: Expression,
  at: Origin,
): readonly Origin[] {
  const tail = tailForMemberWrite(memberKeys, at);
  return tail === undefined ? [] : [{ ...tail, value: rhs }];
}

/** Extracts property origins written by `Object.assign`, `Reflect.set`, and `defineProperty`. */
function callObjectWriteOrigins(
  call: CallExpression,
  query: ObjectWriteQuery,
  at: Origin,
): readonly Origin[] {
  const globalPath = globalPathOf(peeled(call.expression))?.join('.');
  const [firstArg, secondArg, thirdArg] = call.arguments;
  if (firstArg === undefined || isSpreadElement(firstArg) || !query.matchesObject(firstArg)) {
    return [];
  }
  if (globalPath === 'Object.assign') {
    return objectAssignOrigins(call.arguments.slice(1), at);
  }
  if (globalPath === 'Reflect.set' && thirdArg !== undefined) {
    return projectWrittenMember(
      [argumentKey(secondArg, at.context)],
      unwrapSpreadArg(thirdArg),
      at,
    );
  }
  if (globalPath === 'Object.defineProperty' && thirdArg !== undefined) {
    return descriptorOrigins([argumentKey(secondArg, at.context)], unwrapSpreadArg(thirdArg), at);
  }
  if (globalPath === 'Object.defineProperties' && secondArg !== undefined) {
    return [
      {
        ...at,
        excluded: undefined,
        keys: [at.keys[0] ?? null, 'value', ...at.keys.slice(1)],
        spread: undefined,
        value: unwrapSpreadArg(secondArg),
      },
    ];
  }
  return [];
}

/** Projects source arguments of `Object.assign(target, ...sources)` onto `at`. */
function objectAssignOrigins(sources: readonly Expression[], at: Origin): readonly Origin[] {
  return sources.map((arg) => {
    const value = unwrapSpreadArg(arg);
    return at.keys.length === 0
      ? { ...at, keys: [], spread: true, value }
      : { ...at, excluded: undefined, keys: at.keys, spread: undefined, value };
  });
}

/** Unwraps a `SpreadElement` call argument to its underlying expression. */
function unwrapSpreadArg(arg: Expression): Expression {
  return isSpreadElement(arg) ? arg.expression : arg;
}

/** Resolves a call argument to a static property key, or `null` when dynamic/omitted. */
function argumentKey(arg: Expression | undefined, context: Context): OriginKey {
  return arg === undefined || isSpreadElement(arg) ? null : (originKey(arg, context) ?? null);
}

/** Extracts `value` and `get()` return origins from a property descriptor written at `memberKeys`. */
function descriptorOrigins(
  memberKeys: readonly OriginKey[],
  descriptor: Expression,
  at: Origin,
): readonly Origin[] {
  const tail = tailForMemberWrite(memberKeys, at);
  if (tail === undefined) {
    return [];
  }
  const valueOrigin: Origin = { ...tail, keys: ['value', ...tail.keys], value: descriptor };
  const literal = peeled(descriptor);
  return isObjectLiteralExpression(literal)
    ? [valueOrigin, ...descriptorGetterOrigins(literal.properties, tail)]
    : [valueOrigin];
}

/** Extracts return origins from a `get` method or property on an inline descriptor literal. */
function descriptorGetterOrigins(
  properties: readonly ObjectLiteralElementLike[],
  tail: Origin,
): readonly Origin[] {
  const found: Origin[] = [];
  for (const prop of properties) {
    if (isMethodDeclaration(prop) && propertyKey(prop.name, tail.context) === 'get') {
      found.push(...returnedBy(prop).map((value) => ({ ...tail, value })));
    } else if (isPropertyAssignment(prop) && propertyKey(prop.name, tail.context) === 'get') {
      const init = peeled(prop.initializer);
      if ((isArrowFunction(init) || isFunctionExpression(init)) && isAnswering(init)) {
        found.push(...returnedBy(init).map((value) => ({ ...tail, value })));
      }
    }
  }
  return found;
}
