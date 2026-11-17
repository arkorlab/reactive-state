import {
  type ArrayLiteralExpression,
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isComputedPropertyName,
  isConditionalExpression,
  isElementAccessExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { returnedBy } from './answers.ts';
import { isTakenApart, patternKey } from './code-globals.ts';
import { constantValue } from './numbers.ts';
import { platformInitializer } from './platform-inputs.ts';
import { peelPlatform, platformPathsOf, sourceFunction } from './platform-uses.ts';
import {
  type EventQuery,
  expandIdentifierQuery,
  patternParentQueries,
  staticMemberKey,
} from './timed-event-bindings.ts';

/** Platform constructors whose instances expose a creation-time `timeStamp`. */
const EVENT_CLASSES: ReadonlySet<string> = new Set(['CustomEvent', 'Event']);

/** Binary operators that forward one of their operands' values. */
const VALUE_BRANCH_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/** Array methods returning a single element from their receiver. */
const ELEMENT_READ_METHODS: ReadonlySet<string> = new Set([
  'at',
  'find',
  'findLast',
  'pop',
  'shift',
]);

/** Array methods returning a shallow array copy whose elements come from their receiver. */
const ARRAY_COPY_METHODS: ReadonlySet<string> = new Set([
  'filter',
  'reverse',
  'slice',
  'sort',
  'toReversed',
  'toSorted',
]);

/** Whether `node` reads the `timeStamp` property of a constructed `Event` or `CustomEvent`. */
export function eventReadsClock(node: Node): boolean {
  const queries = timestampQueries(node);
  return queries.length > 0 && mayReachEvent(queries);
}

/** Extracts initial `EventQuery` roots when `node` reads a `timeStamp` member or destructures it. */
function timestampQueries(node: Node): readonly EventQuery[] {
  if (isPropertyAccessExpression(node) && node.name.text === 'timeStamp') {
    return isAssignmentTarget(node) ? [] : [{ expr: node.expression, keys: [] }];
  }
  if (isElementAccessExpression(node) && staticMemberKey(node) === 'timeStamp') {
    return isAssignmentTarget(node) ? [] : [{ expr: node.expression, keys: [] }];
  }
  if (
    isBindingElement(node) &&
    isObjectBindingPattern(node.parent) &&
    patternKey(node) === 'timeStamp'
  ) {
    return patternParentQueries(node.parent, []);
  }
  if (
    (isPropertyAssignment(node) || isShorthandPropertyAssignment(node)) &&
    isTakenApart(node.parent) &&
    patternKey(node) === 'timeStamp'
  ) {
    return assignmentPatternQueries(node.parent as ObjectLiteralExpression, []);
  }
  return [];
}

/** Whether `node` stands directly on the left-hand side of a plain `=` assignment. */
function isAssignmentTarget(node: Expression): boolean {
  let current: Node = node;
  while (peelPlatform(current as Expression) !== current) {
    current = current.parent;
  }
  const parent = current.parent;
  return (
    isBinaryExpression(parent) &&
    parent.operatorToken.kind === SyntaxKind.EqualsToken &&
    parent.left === current
  );
}

/** Resolves RHS queries for an assignment destructuring pattern `({ ... } = rhs)`. */
function assignmentPatternQueries(
  pattern: Expression,
  initialKeys: readonly (string | null)[],
): readonly EventQuery[] {
  let current: Node = pattern;
  const steps: (string | null)[] = [];
  for (;;) {
    while (peelPlatform(current as Expression) !== current) {
      current = current.parent;
    }
    const parent = current.parent;
    if (
      isBinaryExpression(parent) &&
      parent.operatorToken.kind === SyntaxKind.EqualsToken &&
      parent.left === current
    ) {
      return [{ expr: parent.right, keys: [...steps.toReversed(), ...initialKeys] }];
    }
    if (isPropertyAssignment(parent) && isTakenApart(parent.parent)) {
      steps.push(patternKey(parent) ?? null);
      current = parent.parent;
    } else if (isArrayLiteralExpression(parent) && isTakenApart(parent)) {
      const index = parent.elements.indexOf(current as Expression);
      steps.push(index === -1 ? null : String(index));
      current = parent;
    } else {
      return [];
    }
  }
}

/** Walks an explicit worklist to test whether any query can evaluate to an `Event` instance. */
function mayReachEvent(initial: readonly EventQuery[]): boolean {
  const pending = [...initial];
  const seen = new Set<string>();
  for (let query = pending.pop(); query !== undefined; query = pending.pop()) {
    const value = peelPlatform(query.expr);
    const key = `${value.pos}:${value.end}:${query.keys.map((step) => step ?? '*').join('/')}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (query.keys.length === 0 && isEventConstruction(value)) {
      return true;
    }
    expandEventQuery(value, query.keys, pending);
  }
  return false;
}

/** Whether `value` constructs a global `Event` or `CustomEvent` (directly or through an alias). */
function isEventConstruction(value: Expression): boolean {
  return (
    isNewExpression(value) &&
    platformPathsOf(value.expression).some((path) => EVENT_CLASSES.has(path))
  );
}

/** Expands one `EventQuery` step across expressions, containers, calls, and lexical bindings. */
function expandEventQuery(
  value: Expression,
  keys: readonly (string | null)[],
  pending: EventQuery[],
): void {
  if (isConditionalExpression(value)) {
    pending.push({ expr: value.whenTrue, keys }, { expr: value.whenFalse, keys });
  } else if (isBinaryExpression(value)) {
    expandBinaryQuery(value, keys, pending);
  } else if (isPropertyAccessExpression(value)) {
    pending.push({ expr: value.expression, keys: [value.name.text, ...keys] });
  } else if (isElementAccessExpression(value)) {
    pending.push({ expr: value.expression, keys: [staticMemberKey(value) ?? null, ...keys] });
  } else if (isArrayLiteralExpression(value)) {
    expandArrayLiteralQuery(value, keys, pending);
  } else if (isObjectLiteralExpression(value)) {
    expandObjectLiteralQuery(value, keys, pending);
  } else if (isCallExpression(value)) {
    expandCallQuery(value, keys, pending);
  } else if (isIdentifier(value)) {
    expandIdentifierQuery(value, keys, pending);
  }
}

/** Expands comma, assignment-expression, and logical branch operators. */
function expandBinaryQuery(
  value: Expression & {
    readonly left: Expression;
    readonly operatorToken: { readonly kind: SyntaxKind };
    readonly right: Expression;
  },
  keys: readonly (string | null)[],
  pending: EventQuery[],
): void {
  const kind = value.operatorToken.kind;
  if (kind === SyntaxKind.CommaToken || kind === SyntaxKind.EqualsToken) {
    pending.push({ expr: value.right, keys });
  } else if (VALUE_BRANCH_OPERATORS.has(kind)) {
    pending.push({ expr: value.left, keys }, { expr: value.right, keys });
  }
}

/** Projects `keys[0]` through an array literal, accounting for spreads and dynamic indices. */
function expandArrayLiteralQuery(
  array: ArrayLiteralExpression,
  keys: readonly (string | null)[],
  pending: EventQuery[],
): void {
  if (keys.length === 0) {
    return;
  }
  const [head, ...rest] = keys;
  const targetIndex =
    head === undefined || head === null || !/^\d+$/u.test(head) ? undefined : Number(head);
  let spreadSeen = false;
  for (const [index, element] of array.elements.entries()) {
    if (isSpreadElement(element)) {
      spreadSeen = true;
      if (targetIndex === undefined || index <= targetIndex) {
        pending.push({ expr: element.expression, keys: [null, ...rest] });
      }
      continue;
    }
    const matches =
      targetIndex === undefined ||
      (!spreadSeen && index === targetIndex) ||
      (spreadSeen && index <= targetIndex);
    if (matches) {
      pending.push({ expr: element, keys: rest });
    }
  }
}

/** Projects `keys[0]` through an object literal, including spreads, computed keys, and getters. */
function expandObjectLiteralQuery(
  object: ObjectLiteralExpression,
  keys: readonly (string | null)[],
  pending: EventQuery[],
): void {
  if (keys.length === 0) {
    return;
  }
  const [head, ...rest] = keys;
  for (const property of object.properties) {
    if (isSpreadAssignment(property)) {
      pending.push({ expr: property.expression, keys });
      continue;
    }
    const propKey = objectPropertyKey(property);
    if (head !== null && propKey !== undefined && propKey !== head) {
      continue;
    }
    pushObjectPropertyOrigins(property, rest, pending);
  }
}

/** Resolves a literal or constant-computed property name on an object literal element. */
function objectPropertyKey(property: ObjectLiteralElementLike): string | undefined {
  if (isSpreadAssignment(property)) {
    return undefined;
  }
  const { name } = property;
  if (
    isIdentifier(name) ||
    isStringLiteral(name) ||
    isNoSubstitutionTemplateLiteral(name) ||
    isNumericLiteral(name)
  ) {
    return name.text;
  }
  const computed = isComputedPropertyName(name)
    ? constantValue(name.expression, (id) => platformInitializer(id, id))
    : undefined;
  return computed === undefined ? undefined : String(computed);
}

/** Pushes value expressions or getter return expressions for a matching object property. */
function pushObjectPropertyOrigins(
  property: ObjectLiteralElementLike,
  rest: readonly (string | null)[],
  pending: EventQuery[],
): void {
  if (isPropertyAssignment(property)) {
    pending.push({ expr: property.initializer, keys: rest });
  } else if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
    pending.push({ expr: property.name, keys: rest });
  } else if (isGetAccessorDeclaration(property)) {
    for (const answer of returnedBy(property)) {
      pending.push({ expr: answer, keys: rest });
    }
  }
}

/** Expands built-in container helpers and local source function return values. */
function expandCallQuery(
  call: CallExpression,
  keys: readonly (string | null)[],
  pending: EventQuery[],
): void {
  const globalPath = platformPathsOf(call.expression);
  if (globalPath.includes('Object.assign')) {
    for (const arg of call.arguments) {
      if (!isSpreadElement(arg)) {
        pending.push({ expr: arg, keys });
      }
    }
    return;
  }
  if (globalPath.includes('Array.from')) {
    const first = call.arguments[0];
    if (first !== undefined && keys.length > 0 && !isSpreadElement(first)) {
      pending.push({ expr: first, keys: [null, ...keys.slice(1)] });
    }
    return;
  }
  const callee = peelPlatform(call.expression);
  if (isPropertyAccessExpression(callee)) {
    expandMethodCallQuery(call, callee, keys, pending);
  }
  const fn = sourceFunction(call.expression);
  if (fn !== undefined) {
    for (const answer of returnedBy(fn)) {
      pending.push({ expr: answer, keys });
    }
  }
}

/** Expands element-reading and shallow-copying array method calls on `receiver`. */
function expandMethodCallQuery(
  call: CallExpression,
  callee: Expression & {
    readonly expression: Expression;
    readonly name: { readonly text: string };
  },
  keys: readonly (string | null)[],
  pending: EventQuery[],
): void {
  const receiver = callee.expression;
  const method = callee.name.text;
  if (ELEMENT_READ_METHODS.has(method)) {
    pending.push({ expr: receiver, keys: [null, ...keys] });
    return;
  }
  if (keys.length === 0) {
    return;
  }
  const rest = keys.slice(1);
  if (ARRAY_COPY_METHODS.has(method)) {
    pending.push({ expr: receiver, keys: [null, ...rest] });
    return;
  }
  if (method === 'concat') {
    pending.push({ expr: receiver, keys: [null, ...rest] });
    for (const arg of call.arguments) {
      const expr = isSpreadElement(arg) ? arg.expression : arg;
      pending.push({ expr, keys: [null, ...rest] }, { expr, keys: rest });
    }
  }
}
