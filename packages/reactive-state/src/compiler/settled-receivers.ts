import {
  type ArrayLiteralExpression,
  type CallExpression,
  type ClassLikeDeclaration,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isConditionalExpression,
  isConstructorDeclaration,
  isElementAccessExpression,
  isExpressionWithTypeArguments,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PropertyName,
  SyntaxKind,
} from 'typescript/ast';

import { declarationOf, type Declared, initializerOf } from './framed.ts';
import { methodsOf, writesThis } from './held-methods.ts';
import { answersOf, isKept, runsPerCall } from './kept.ts';
import { constantValue } from './numbers.ts';
import { platformInitializer } from './platform-inputs.ts';
import { peelPlatform, platformPathsOf, wrappedBy } from './platform-uses.ts';
import { readsBinding } from './scope.ts';
import { methodOf, writtenBy } from './written.ts';

/** Binary operators that evaluate to one of their operand expressions. */
const VALUE_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/** Built-in wrappers that return their first argument object unchanged in identity. */
const IDENTITY_WRAPPERS: ReadonlySet<string> = new Set([
  'Object',
  'Object.freeze',
  'Object.preventExtensions',
  'Object.seal',
]);

/** Extracts every leaf write target from an expression or destructuring assignment pattern. */
export function keptTargetsOf(node: Node): readonly Node[] {
  let current = node;
  while (wrappedBy(current)) {
    current = (current as Expression & { readonly expression: Expression }).expression;
  }
  if (isArrayLiteralExpression(current)) {
    return current.elements.flatMap((element) =>
      keptTargetsOf(isSpreadElement(element) ? element.expression : element),
    );
  }
  if (isObjectLiteralExpression(current)) {
    return current.properties.flatMap((property) => objectTargetLeaves(property));
  }
  return isBinaryExpression(current) && current.operatorToken.kind === SyntaxKind.EqualsToken
    ? keptTargetsOf(current.left)
    : [current];
}

/** Extracts destructuring assignment leaf targets from an object literal element. */
function objectTargetLeaves(property: ObjectLiteralElementLike): readonly Node[] {
  if (isPropertyAssignment(property)) {
    return keptTargetsOf(property.initializer);
  }
  if (isShorthandPropertyAssignment(property)) {
    return [property.name];
  }
  return isSpreadAssignment(property) ? keptTargetsOf(property.expression) : [];
}

/** Resolves the base lexical binding identifier beneath member accesses and TypeScript casts. */
export function keptRootOf(node: Node): Identifier | undefined {
  let current = node;
  for (;;) {
    if (isPropertyAccessExpression(current) || isElementAccessExpression(current)) {
      current = current.expression;
    } else if (wrappedBy(current)) {
      current = (current as Expression & { readonly expression: Expression }).expression;
    } else {
      break;
    }
  }
  return isIdentifier(current) && readsBinding(current) ? current : undefined;
}

/** Checks direct and nested retained receivers for method calls that mutate `this`. */
export function nestedKeptMethodWrite(node: Node): Identifier | undefined {
  const method = isCallExpression(node) ? methodOf(node) : undefined;
  if (method === undefined || !isCallExpression(node) || !runsPerCall(node)) {
    return undefined;
  }
  const callee = peelPlatform(node.expression);
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) {
    return undefined;
  }
  const resolved = receiverMemberPath(callee.expression);
  if (resolved === undefined || !isKept(resolved.root, writtenBy)) {
    return undefined;
  }
  if (resolved.steps.length === 0) {
    return writesThis(methodsOf(resolved.root), method, writtenBy, { call: node, seen: new Set() })
      ? resolved.root
      : undefined;
  }
  const maps = methodsAtExpressionPath(resolved.root, resolved.steps);
  return maps.some((methods) =>
    writesThis(methods, method, writtenBy, { call: node, seen: new Set() }),
  )
    ? resolved.root
    : undefined;
}

/** Splits a receiver expression into its base identifier and static/dynamic member steps. */
export function receiverMemberPath(
  receiver: Expression,
): { readonly root: Identifier; readonly steps: readonly (string | null)[] } | undefined {
  let current = peelPlatform(receiver);
  const steps: (string | null)[] = [];
  while (isPropertyAccessExpression(current) || isElementAccessExpression(current)) {
    const step = isPropertyAccessExpression(current)
      ? current.name.text
      : (staticElementKey(current.argumentExpression) ?? null);
    steps.push(step);
    current = peelPlatform(current.expression);
  }
  return isIdentifier(current) && readsBinding(current)
    ? { root: current, steps: steps.toReversed() }
    : undefined;
}

/** Resolves method maps reachable from `start` after following member projection `steps`. */
export function methodsAtExpressionPath(
  start: Expression,
  steps: readonly (string | null)[],
): readonly ReadonlyMap<string, Node>[] {
  const leaves = projectExpressionPath(start, steps);
  const result: ReadonlyMap<string, Node>[] = [];
  for (const leaf of leaves) {
    const map = leafMethodsOf(leaf);
    if (map.size > 0) {
      result.push(map);
    }
  }
  return result;
}

/** Projects `start` along `steps` across literals, class instances, factories, and aliases. */
function projectExpressionPath(
  start: Expression,
  steps: readonly (string | null)[],
): readonly Expression[] {
  const leaves: Expression[] = [];
  const seen = new Set<string>();
  const pending: { readonly expr: Expression; readonly path: readonly (string | null)[] }[] = [
    { expr: start, path: steps },
  ];
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    const value = peelIdentityWrapper(item.expr);
    const key = `${value.pos}:${value.end}:${item.path.map((each) => each ?? '*').join('/')}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (expandBranchOrAlias(value, item.path, pending)) {
      continue;
    }
    if (item.path.length === 0) {
      leaves.push(value);
      continue;
    }
    expandContainerStep(value, item.path, pending);
  }
  return leaves;
}

/** Unwraps casts and identity object wrappers such as `Object.freeze(target)`. */
function peelIdentityWrapper(expr: Expression): Expression {
  let current = peelPlatform(expr);
  while (isCallExpression(current)) {
    const first = current.arguments[0];
    if (
      first === undefined ||
      isSpreadElement(first) ||
      platformPathsOf(current.expression).every((path) => !IDENTITY_WRAPPERS.has(path))
    ) {
      break;
    }
    current = peelPlatform(first);
  }
  return current;
}

/** Expands conditional/logical branches, comma expressions, and identifier initializers. */
function expandBranchOrAlias(
  value: Expression,
  path: readonly (string | null)[],
  pending: { readonly expr: Expression; readonly path: readonly (string | null)[] }[],
): boolean {
  if (isConditionalExpression(value)) {
    pending.push({ expr: value.whenTrue, path }, { expr: value.whenFalse, path });
    return true;
  }
  if (isBinaryExpression(value)) {
    const kind = value.operatorToken.kind;
    if (kind === SyntaxKind.CommaToken) {
      pending.push({ expr: value.right, path });
      return true;
    }
    if (VALUE_OPERATORS.has(kind)) {
      pending.push({ expr: value.left, path }, { expr: value.right, path });
      return true;
    }
  }
  if (isIdentifier(value)) {
    const init = initializerOf(value);
    if (init !== undefined) {
      pending.push({ expr: init, path });
      return true;
    }
  }
  return false;
}

/** Projects `path[0]` through an object literal, array literal, class instance, or factory call. */
function expandContainerStep(
  value: Expression,
  path: readonly (string | null)[],
  pending: { readonly expr: Expression; readonly path: readonly (string | null)[] }[],
): void {
  const [head, ...rest] = path;
  if (head === undefined) {
    return;
  }
  if (isObjectLiteralExpression(value)) {
    expandObjectStep(value, head, rest, pending);
  } else if (isArrayLiteralExpression(value)) {
    expandArrayStep(value, head, rest, pending);
  } else if (isNewExpression(value)) {
    expandInstanceStep(value.expression, head, rest, pending);
  } else if (isCallExpression(value)) {
    const fn = localFunctionOf(value.expression);
    if (fn !== undefined) {
      for (const answer of answersOf(fn)) {
        pending.push({ expr: answer, path });
      }
    }
  }
}

/** Projects `head` through `object.properties`, including spreads and shorthand bindings. */
function expandObjectStep(
  object: ObjectLiteralExpression,
  head: string | null,
  rest: readonly (string | null)[],
  pending: { readonly expr: Expression; readonly path: readonly (string | null)[] }[],
): void {
  for (const prop of object.properties) {
    if (isSpreadAssignment(prop)) {
      pending.push({ expr: prop.expression, path: [head, ...rest] });
      continue;
    }
    const key = propertyKeyOf(prop.name);
    if (head !== null && key !== undefined && key !== head) {
      continue;
    }
    if (isPropertyAssignment(prop)) {
      pending.push({ expr: prop.initializer, path: rest });
    } else if (isShorthandPropertyAssignment(prop) && isIdentifier(prop.name)) {
      pending.push({ expr: prop.name, path: rest });
    }
  }
}

/** Projects `head` through `array.elements`, accounting for spreads and dynamic indices. */
function expandArrayStep(
  array: ArrayLiteralExpression,
  head: string | null,
  rest: readonly (string | null)[],
  pending: { readonly expr: Expression; readonly path: readonly (string | null)[] }[],
): void {
  const indexTarget = head === null || !/^\d+$/u.test(head) ? undefined : Number(head);
  let spreadSeen = false;
  for (const [index, el] of array.elements.entries()) {
    if (isSpreadElement(el)) {
      spreadSeen = true;
      if (indexTarget === undefined || index <= indexTarget) {
        pending.push({ expr: el.expression, path: [null, ...rest] });
      }
      continue;
    }
    const matches =
      indexTarget === undefined ||
      (!spreadSeen && index === indexTarget) ||
      (spreadSeen && index <= indexTarget);
    if (matches) {
      pending.push({ expr: el, path: rest });
    }
  }
}

/** Projects `head` through non-static instance field initializers on a local class hierarchy. */
function expandInstanceStep(
  ctor: Expression,
  head: string | null,
  rest: readonly (string | null)[],
  pending: { readonly expr: Expression; readonly path: readonly (string | null)[] }[],
): void {
  const declared = resolveLocalClass(ctor);
  if (declared === undefined) {
    return;
  }
  for (const cls of declaredLineage(declared)) {
    for (const member of cls.members) {
      if (
        isPropertyDeclaration(member) &&
        member.initializer !== undefined &&
        member.modifiers?.some((mod) => mod.kind === SyntaxKind.StaticKeyword) !== true
      ) {
        const key = propertyKeyOf(member.name);
        if (head === null || key === undefined || key === head) {
          pending.push({ expr: member.initializer, path: rest });
        }
      }
    }
  }
}

/** Extracts callable methods on a resolved leaf expression. */
function leafMethodsOf(leaf: Expression): ReadonlyMap<string, Node> {
  if (isIdentifier(leaf)) {
    return methodsOf(leaf);
  }
  if (isObjectLiteralExpression(leaf)) {
    return inlineObjectMethods(leaf);
  }
  if (isNewExpression(leaf)) {
    const cls = resolveLocalClass(leaf.expression);
    return cls === undefined ? new Map() : inlineClassMethods(cls);
  }
  if (isCallExpression(leaf)) {
    return inlineFactoryMethods(leaf);
  }
  return new Map();
}

/** Collects own methods and function-valued properties from `object`. */
function inlineObjectMethods(object: ObjectLiteralExpression): ReadonlyMap<string, Node> {
  const methods = new Map<string, Node>();
  for (const prop of object.properties) {
    if (isSpreadAssignment(prop)) {
      continue;
    }
    const key = propertyKeyOf(prop.name);
    if (key === undefined) {
      continue;
    }
    if (isMethodDeclaration(prop)) {
      methods.set(key, prop);
    } else if (isPropertyAssignment(prop) && isFunctionExpression(peelPlatform(prop.initializer))) {
      methods.set(key, peelPlatform(prop.initializer));
    }
  }
  return methods;
}

/** Collects instance methods and arrow/function fields across `declared`'s lineage. */
function inlineClassMethods(declared: ClassLikeDeclaration): ReadonlyMap<string, Node> {
  const methods = new Map<string, Node>();
  for (const cls of declaredLineage(declared)) {
    for (const member of cls.members) {
      recordClassInstanceMethod(member, methods);
    }
  }
  return methods;
}

/** Records a non-static method or function-valued field from `member` into `methods`. */
function recordClassInstanceMethod(member: Node, methods: Map<string, Node>): void {
  if (!isMethodDeclaration(member) && !isPropertyDeclaration(member)) {
    return;
  }
  if (member.modifiers?.some((mod) => mod.kind === SyntaxKind.StaticKeyword) === true) {
    return;
  }
  const key = propertyKeyOf(member.name);
  if (key === undefined) {
    return;
  }
  if (isMethodDeclaration(member)) {
    methods.set(key, member);
    return;
  }
  const init = member.initializer === undefined ? undefined : peelPlatform(member.initializer);
  if (init !== undefined && (isArrowFunction(init) || isFunctionExpression(init))) {
    methods.set(key, init);
  }
}

/** Collects methods from objects or instances returned by a local factory `call`. */
function inlineFactoryMethods(call: CallExpression): ReadonlyMap<string, Node> {
  const fn = localFunctionOf(call.expression);
  if (fn === undefined) {
    return new Map();
  }
  const merged = new Map<string, Node>();
  for (const answer of answersOf(fn)) {
    const methods = leafMethodsOf(peelIdentityWrapper(answer));
    for (const [name, method] of methods) {
      merged.set(name, method);
    }
  }
  return merged;
}

/** Resolves a local `ClassDeclaration` or `ClassExpression` referenced by `expr`. */
export function resolveLocalClass(expr: Expression): ClassLikeDeclaration | undefined {
  let current = peelPlatform(expr);
  const seen = new Set<Expression>();
  while (!seen.has(current)) {
    seen.add(current);
    if (isClassExpression(current)) {
      return current;
    }
    if (!isIdentifier(current)) {
      return undefined;
    }
    const declared = declarationOf(current);
    if (declared !== undefined && isClassDeclaration(declared)) {
      return declared;
    }
    const init = initializerOf(current);
    if (init === undefined) {
      return undefined;
    }
    current = peelPlatform(init);
  }
  return undefined;
}

/** Returns base-to-derived class declarations in `declared`'s `extends` chain. */
function declaredLineage(declared: ClassLikeDeclaration): readonly ClassLikeDeclaration[] {
  const lineage: ClassLikeDeclaration[] = [];
  const seen = new Set<ClassLikeDeclaration>();
  let current: ClassLikeDeclaration | undefined = declared;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    lineage.unshift(current);
    current = directBaseClass(current);
  }
  return lineage;
}

/** Finds the lexical base class in `declared`'s `extends` heritage clause, if any. */
function directBaseClass(declared: ClassLikeDeclaration): ClassLikeDeclaration | undefined {
  const { heritageClauses } = declared;
  if (heritageClauses === undefined) {
    return undefined;
  }
  for (const clause of heritageClauses) {
    if (clause.token !== SyntaxKind.ExtendsKeyword) {
      continue;
    }
    for (const type of clause.types) {
      if (isExpressionWithTypeArguments(type)) {
        return resolveLocalClass(type.expression);
      }
    }
  }
  return undefined;
}

/** Resolves a local function or arrow declaration referenced by `callee`. */
function localFunctionOf(callee: Expression): Node | undefined {
  const clean = peelPlatform(callee);
  if (isArrowFunction(clean) || isFunctionExpression(clean)) {
    return clean;
  }
  const declared: Declared | undefined = isIdentifier(clean) ? declarationOf(clean) : undefined;
  if (declared === undefined || isClassDeclaration(declared)) {
    return undefined;
  }
  if (isFunctionDeclaration(declared)) {
    return declared;
  }
  const init = declared.initializer === undefined ? undefined : peelPlatform(declared.initializer);
  return init !== undefined && (isArrowFunction(init) || isFunctionExpression(init))
    ? init
    : undefined;
}

/** Resolves a literal or constant-computed property key name. */
function propertyKeyOf(name: PropertyName | undefined): string | undefined {
  if (name === undefined) {
    return undefined;
  }
  if (
    isIdentifier(name) ||
    isStringLiteral(name) ||
    isNoSubstitutionTemplateLiteral(name) ||
    isNumericLiteral(name)
  ) {
    return name.text;
  }
  return isComputedPropertyName(name) ? staticElementKey(name.expression) : undefined;
}

/** Evaluates a constant string or number key expression. */
function staticElementKey(expr: Expression): string | undefined {
  const value = constantValue(expr, (id) => platformInitializer(id, id));
  return value === undefined ? undefined : String(value);
}

/** Finds a constructor with an implementation body on `declared`, if any. */
export function declaredConstructorOf(declared: ClassLikeDeclaration): Node | undefined {
  return declared.members.find(
    (member) => isConstructorDeclaration(member) && member.body !== undefined,
  );
}
