import {
  type ArrayLiteralExpression,
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isForOfStatement,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isVariableDeclarationList,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import type { Answering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { metadataInitializer } from './input-callees.ts';
import { targetsOf } from './kept.ts';
import { readsOf } from './local-module-reads.ts';
import {
  arrayIndex,
  type ArrayScope,
  constArrayScope,
  mayRunBefore,
  restArrayScope,
} from './proxy-arrays.ts';
import {
  type Context,
  type Origin,
  type OriginKey,
  originKey,
  propertyKey,
} from './proxy-values.ts';
import { isTypeOnly } from './scope.ts';
import { methodOf } from './written.ts';

/** Bound rest-parameter array context for mutation and element-origin recovery. */
export interface RestArrayTarget {
  readonly declared: Identifier;
  readonly fn: Answering;
  readonly given: readonly Origin[] | undefined;
  readonly name: Identifier;
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
  const written = scope === undefined ? [] : writtenArrayOrigins(scope, at);
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
  const written = scope === undefined ? [] : writtenArrayOrigins(scope, at);
  if (given === undefined) {
    return written;
  }
  if (at.keys.length === 0) {
    const initial = given.map((each) => ({ ...each, excluded: undefined, spread: undefined }));
    return [...initial, ...written];
  }
  const [firstKey, ...rest] = at.keys;
  if (firstKey === null || (firstKey !== undefined && arrayIndex(firstKey) !== undefined)) {
    const initial = given.map((each) => ({
      ...each,
      excluded: at.excluded,
      keys: [...each.keys, ...rest],
      spread: at.spread,
    }));
    return [...initial, ...written];
  }
  return written;
}

/** Collects element/property expressions written into the array before `scope.readSite`. */
function writtenArrayOrigins(scope: ArrayScope, at: Origin): readonly Origin[] {
  const firstKey = at.keys[0];
  if (firstKey === 'length') {
    return [];
  }
  const elemTail: Origin =
    at.keys.length === 0
      ? { ...at, excluded: undefined, keys: [], spread: undefined }
      : { ...at, keys: at.keys.slice(1) };
  const matchesArray = (candidate: Expression): boolean =>
    resolvesToArrayAlias(candidate, scope, at.context);
  const found: Origin[] = [];
  const visit = (node: Node): void => {
    if (isTypeOnly(node)) {
      return;
    }
    if (mayRunBefore(node, scope)) {
      found.push(...nodeArrayWriteOrigins(node, matchesArray, elemTail, firstKey));
    }
    node.forEachChild(visit);
  };
  scope.owner.forEachChild(visit);
  return found;
}

/** Extracts origins written into `matchesArray` by a single assignment, loop, or mutator call. */
function nodeArrayWriteOrigins(
  node: Node,
  matchesArray: (candidate: Expression) => boolean,
  elemTail: Origin,
  firstKey: OriginKey | undefined,
): readonly Origin[] {
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
  return callArrayWriteOrigins(node, matchesArray, elemTail, namedProperty);
}

/** Extracts element origins from direct or destructured member assignments onto `matchesArray`. */
function binaryArrayWriteOrigins(
  left: Expression,
  right: Expression,
  matchesArray: (candidate: Expression) => boolean,
  elemTail: Origin,
): readonly Origin[] {
  const target = unwrapped(left);
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
  return targetsOf(pattern).some(
    (each) =>
      (isElementAccessExpression(each) || isPropertyAccessExpression(each)) &&
      matchesArray(each.expression),
  );
}

/** Extracts inserted element origins from array mutator methods and `Object.assign`/`Reflect.set`. */
function callArrayWriteOrigins(
  call: CallExpression,
  matchesArray: (candidate: Expression) => boolean,
  elemTail: Origin,
  namedProperty: boolean,
): readonly Origin[] {
  const globalPath = globalPathOf(unwrapped(call.expression))?.join('.');
  const [firstArg, , thirdArg] = call.arguments;
  if (
    globalPath === 'Object.assign' &&
    firstArg !== undefined &&
    !isSpreadElement(firstArg) &&
    matchesArray(firstArg)
  ) {
    return call.arguments.slice(1).map((arg) => ({
      ...elemTail,
      keys: [null, ...elemTail.keys],
      value: isSpreadElement(arg) ? arg.expression : arg,
    }));
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
  const callee = unwrapped(call.expression);
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

/** Checks whether `candidate` resolves directly or through `const` containers to `scope.aliases`. */
function resolvesToArrayAlias(candidate: Expression, scope: ArrayScope, context: Context): boolean {
  const keys: string[] = [];
  let current = unwrapped(candidate);
  for (;;) {
    if (isPropertyAccessExpression(current)) {
      keys.unshift(current.name.text);
      current = unwrapped(current.expression);
      continue;
    }
    if (isElementAccessExpression(current)) {
      const key = originKey(current.argumentExpression, context);
      if (key === undefined) {
        return false;
      }
      keys.unshift(key);
      current = unwrapped(current.expression);
      continue;
    }
    break;
  }
  return matchesAliasAtKeys(current, keys, scope, context);
}

/** Follows `keys` through `const` object/array containers to test whether the leaf is aliased. */
function matchesAliasAtKeys(
  root: Expression,
  keys: readonly string[],
  scope: ArrayScope,
  context: Context,
): boolean {
  let current: Expression | undefined = root;
  const seen = new Set<Expression>();
  for (const key of keys) {
    const resolved = unwrapConstContainer(current, seen);
    if (resolved === undefined) {
      return false;
    }
    current = selectContainerEntry(resolved, key, context);
    if (current === undefined) {
      return false;
    }
  }
  const leaf = unwrapped(current);
  return (
    isIdentifier(leaf) && [...scope.aliases].some((alias) => readsOf(alias, scope.owner)(leaf))
  );
}

/** Resolves `node` across local `const` identifiers without calling external `follow` hooks. */
function unwrapConstContainer(
  node: Expression | undefined,
  seen: Set<Expression>,
): Expression | undefined {
  let current = node === undefined ? undefined : unwrapped(node);
  while (current !== undefined && isIdentifier(current)) {
    if (seen.has(current)) {
      return undefined;
    }
    seen.add(current);
    const held = metadataInitializer(current);
    if (held === undefined) {
      return undefined;
    }
    current = unwrapped(held);
  }
  return current;
}

/** Selects a static property or array element `key` from an object or array literal container. */
function selectContainerEntry(
  container: ArrayLiteralExpression | Expression,
  key: string,
  context: Context,
): Expression | undefined {
  if (isArrayLiteralExpression(container)) {
    const index = arrayIndex(key);
    const element = index === undefined ? undefined : container.elements[index];
    return element === undefined || isOmittedExpression(element) || isSpreadElement(element)
      ? undefined
      : element;
  }
  if (!isObjectLiteralExpression(container)) {
    return undefined;
  }
  for (const property of container.properties.toReversed()) {
    if (isSpreadAssignment(property)) {
      return undefined;
    }
    if (propertyKey(property.name, context) !== key) {
      continue;
    }
    if (isPropertyAssignment(property)) {
      return property.initializer;
    }
    return isShorthandPropertyAssignment(property) ? property.name : undefined;
  }
  return undefined;
}
