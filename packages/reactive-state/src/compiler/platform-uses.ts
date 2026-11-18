import {
  type CallExpression,
  type Expression,
  type Identifier,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isConditionalExpression,
  isDecorator,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionLikeDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isNewExpression,
  isNonNullExpression,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isTypeAssertion,
  isTypeOfExpression,
  isVariableDeclaration,
  isVariableStatement,
  isVoidExpression,
  type NewExpression,
  type Node,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { type Answering, answersLater, isAnswering } from './answers.ts';
import { literalName, unwrapped } from './bounded.ts';
import { GLOBAL_OBJECTS, globalPathOf } from './code-globals.ts';
import { declarationOf, takenApartOf } from './framed.ts';
import { metadataCallee } from './input-callees.ts';
import { readsOf } from './local-module-reads.ts';
import { isTypeOnly, withinFunction } from './scope.ts';
import { writtenBy } from './written.ts';

/** Platform constructors that read input options without storing or returning an alias to them. */
const SAFE_PLATFORM_NEW: ReadonlySet<string> = new Set([
  'Blob',
  'CustomEvent',
  'Event',
  'File',
  'FormData',
  'Headers',
  'Request',
  'Response',
  'URL',
  'URLSearchParams',
]);

/** Built-in calls that neither mutate an argument object nor return a mutable alias to it. */
const SAFE_PLATFORM_CALL: ReadonlySet<string> = new Set([
  'Boolean',
  'Object.hasOwn',
  'Object.is',
  'Reflect.has',
  'Response.redirect',
]);

/** Equality operators that compare identity without coercing or retaining an object reference. */
const EQUALITY_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
]);

/** Binary operators that select between operand values without constructing a fresh primitive. */
const BRANCH_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/** Assignments that can leave their right operand in the binding they write. */
const VALUE_ASSIGNMENTS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** Source ranges of nodes in one syntax tree preserve ancestry for the loop's work. */
export function contains(outer: Node, inner: Node): boolean {
  return (
    outer.getSourceFile() === inner.getSourceFile() &&
    outer.pos <= inner.pos &&
    inner.end <= outer.end
  );
}

/** Whether `node` executes during `owner`'s own top-down evaluation rather than a later call. */
export function runsInOwner(node: Node, owner: Node): boolean {
  if (node === owner || !contains(owner, node)) {
    return false;
  }
  for (let child = node; child.parent !== owner; child = child.parent) {
    if (defersEvaluation(child.parent, child)) {
      return false;
    }
  }
  return true;
}

/** Whether `parent` defers evaluating `child` until a separate call or construction runs. */
function defersEvaluation(parent: Node, child: Node): boolean {
  if (isFunctionLikeDeclaration(parent)) {
    const isOwnName = 'name' in parent && parent.name === child;
    return !isOwnName && !isDecorator(child);
  }
  return (
    isPropertyDeclaration(parent) &&
    parent.initializer?.pos === child.pos &&
    parent.initializer.end === child.end &&
    parent.modifiers?.some((each) => each.kind === SyntaxKind.StaticKeyword) !== true
  );
}

/** A nested source body or parameter default reads captured inputs when its callers execute. */
export function readPoints(before: Node, owner: Node): readonly Node[] | undefined {
  if (!contains(owner, before)) {
    return undefined;
  }
  for (let child = before; child !== owner && !isSourceFile(child); child = child.parent) {
    const parent = child.parent;
    if (parent !== owner && defersEvaluation(parent, child)) {
      return isAnswering(parent) ? invocationPoints(parent, owner) : undefined;
    }
  }
  return [before];
}

/** Immediate calls and unchanged lexical callable bindings, without following callbacks or escapes. */
function invocationPoints(fn: Answering, owner: Node): readonly Node[] | undefined {
  let value: Node = fn;
  while (wrappedBy(value.parent)) {
    value = value.parent;
  }
  const immediate = directCall(value, owner);
  if (immediate !== undefined) {
    return answersLater(fn) ? undefined : [immediate];
  }
  const declaration = isVariableDeclaration(value.parent) ? value.parent : fn;
  if (!isVariableDeclaration(declaration) && !isFunctionDeclaration(declaration)) {
    return undefined;
  }
  const { name } = declaration;
  if (name === undefined || !isIdentifier(name)) {
    return undefined;
  }
  const state = { points: [] as Node[], unknown: false };
  const visit = (node: Node): void => {
    if (state.unknown || isTypeOnly(node)) {
      return;
    }
    if (node !== name && isIdentifier(node) && declarationOf(node) === declaration) {
      const call = directCall(node, owner);
      if (call === undefined || sourceFunction(call.expression) !== fn || answersLater(fn)) {
        state.unknown = true;
      } else {
        state.points.push(call);
      }
    }
    node.forEachChild(visit);
  };
  owner.forEachChild(visit);
  return state.unknown ? undefined : state.points;
}

/** A direct invocation in the binding owner's execution, excluding deferred caller bodies. */
function directCall(node: Node, owner: Node): CallExpression | NewExpression | undefined {
  let value = node;
  while (wrappedBy(value.parent)) {
    value = value.parent;
  }
  const call = value.parent;
  return (isCallExpression(call) || isNewExpression(call)) &&
    call.expression === value &&
    !withinFunction(call, owner)
    ? call
    : undefined;
}

/** A binding or mutable member assignment, including destructuring targets. */
export function bindsTarget(
  node: Node,
  isRead: (node: Node) => node is Identifier,
  mutable: boolean,
): boolean {
  let target = node;
  for (;;) {
    if (wrappedBy(target)) {
      target = (target as Expression & { readonly expression: Expression }).expression;
    } else if (isPropertyAssignment(target)) {
      target = target.initializer;
    } else if (isPropertyAccessExpression(target) || isElementAccessExpression(target)) {
      if (!mutable) {
        return false;
      }
      target = target.expression;
    } else {
      break;
    }
  }
  if (isIdentifier(target)) {
    return isRead(target);
  }
  if (isShorthandPropertyAssignment(target)) {
    return isRead(target.name);
  }
  return (
    target.forEachChild((child) => (bindsTarget(child, isRead, mutable) ? true : undefined)) ===
    true
  );
}

/** Whether `parent` inspects `node` without storing, returning, or invoking methods on it. */
export function isPassiveUse(
  node: Expression,
  parent: Node,
  held: Expression | undefined,
): boolean {
  if (isSpreadAssignment(parent) && parent.expression === node) {
    return hasNoGetter(held);
  }
  if (
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === node
  ) {
    return plainRead(parent, held);
  }
  if (isVoidExpression(parent) || isTypeOfExpression(parent)) {
    return true;
  }
  if (isPrefixUnaryExpression(parent) && parent.operator === SyntaxKind.ExclamationToken) {
    return true;
  }
  if (isConditionalExpression(parent) && parent.condition === node) {
    return true;
  }
  return isBinaryExpression(parent) && EQUALITY_OPERATORS.has(parent.operatorToken.kind);
}

/** Whether reading a member path on `access` neither runs a getter nor invokes a method. */
function plainRead(access: Expression, held: Expression | undefined): boolean {
  if (!hasNoGetter(held)) {
    return false;
  }
  let current: Expression = access;
  for (;;) {
    const next = current.parent;
    if (
      wrappedBy(next) ||
      ((isPropertyAccessExpression(next) || isElementAccessExpression(next)) &&
        next.expression === current)
    ) {
      current = next as Expression;
    } else {
      break;
    }
  }
  const outer = current.parent;
  return !((isCallExpression(outer) || isNewExpression(outer)) && outer.expression === current);
}

/** Whether an initializer literal carries no getter that could run during property reads. */
function hasNoGetter(held: Expression | undefined): boolean {
  if (held === undefined) {
    return true;
  }
  const value = peelPlatform(held);
  return (
    !isObjectLiteralExpression(value) ||
    !value.properties.some((each) => isGetAccessorDeclaration(each))
  );
}

/** Whether a global platform constructor or built-in call neither mutates nor aliases `held`. */
export function safePlatformCall(
  call: CallExpression | NewExpression,
  path: string,
  held: Expression | undefined,
): boolean {
  return isNewExpression(call)
    ? SAFE_PLATFORM_NEW.has(path) && hasNoGetter(held)
    : SAFE_PLATFORM_CALL.has(path);
}

/** Whether a variable binding is directly exported from its enclosing statement. */
export function isExportedVariable(name: Identifier): boolean {
  const declaration = name.parent;
  if (!isVariableDeclaration(declaration)) {
    return false;
  }
  const statement = declaration.parent.parent;
  return (
    isVariableStatement(statement) &&
    statement.modifiers?.some((each) => each.kind === SyntaxKind.ExportKeyword) === true
  );
}

/** A source-backed local callable, without assuming what an unknown or imported callback does. */
export function sourceFunction(callee: Expression): Answering | undefined {
  const fn = metadataCallee(callee);
  return fn !== undefined && isAnswering(fn) ? fn : undefined;
}

/** Wrappers that preserve a reference's identity, including angle-bracket type assertions. */
export function wrappedBy(node: Node): boolean {
  return (
    isParenthesizedExpression(node) ||
    isAsExpression(node) ||
    isSatisfiesExpression(node) ||
    isNonNullExpression(node) ||
    isTypeAssertion(node)
  );
}

/** Peels parentheses and TypeScript assertion syntax from `node`. */
export function peelPlatform(node: Expression): Expression {
  let current = unwrapped(node);
  while (isTypeAssertion(current)) {
    current = unwrapped(current.expression);
  }
  return current;
}

/** Identifier spellings appearing anywhere within a write target expression or pattern. */
export function targetNames(target: Node): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (node: Node): void => {
    if (isIdentifier(node)) {
      names.add(node.text);
    }
    node.forEachChild(visit);
  };
  visit(target);
  return names;
}

/**
 * Members a global path may project past the global an alias leads to. A binding assigned from its
 * own member (`current = current.next`) adds one member to the path on each turn, so without a bound
 * the walk never ends; no global the checks name has a path near this long.
 */
const ALIAS_PATH_MEMBERS = 8;

/**
 * Global paths reachable through `node`, following local aliases and static member projections. A
 * projection longer than `ALIAS_PATH_MEMBERS` members names no global the checks look for, and is
 * not followed further.
 */
export function platformPathsOf(node: Expression, immutableOnly = false): readonly string[] {
  const found = new Set<string>();
  const seen = new Set<string>();
  const pending: { readonly expr: Expression; readonly suffix: readonly string[] }[] = [
    { expr: node, suffix: [] },
  ];
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (item.suffix.length > ALIAS_PATH_MEMBERS) {
      continue;
    }
    const value = peelPlatform(item.expr);
    const key = `${value.pos}:${value.end}:${item.suffix.join('.')}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const direct = globalPathOf(value);
    if (direct !== undefined) {
      found.add(normalizeGlobalParts([...direct, ...item.suffix]));
      continue;
    }
    pushAliasSteps(value, item.suffix, immutableOnly, pending);
  }
  return [...found];
}

/** Strips leading global-object segments such as `globalThis` when followed by a member path. */
function normalizeGlobalParts(parts: string[]): string {
  while (parts.length > 1 && GLOBAL_OBJECTS.has(parts[0] ?? '')) {
    parts.shift();
  }
  return parts.join('.');
}

/** Enqueues member projections, branch operands, and lexical alias sources for `value`. */
function pushAliasSteps(
  value: Expression,
  suffix: readonly string[],
  immutableOnly: boolean,
  pending: { readonly expr: Expression; readonly suffix: readonly string[] }[],
): void {
  if (isPropertyAccessExpression(value)) {
    pending.push({ expr: value.expression, suffix: [value.name.text, ...suffix] });
    return;
  }
  if (isElementAccessExpression(value)) {
    const member = literalName(value);
    if (member !== undefined) {
      pending.push({ expr: value.expression, suffix: [member, ...suffix] });
    }
    return;
  }
  if (!immutableOnly && isConditionalExpression(value)) {
    pending.push({ expr: value.whenTrue, suffix }, { expr: value.whenFalse, suffix });
    return;
  }
  if (isBinaryExpression(value)) {
    pushBinaryAliasSteps(value, suffix, immutableOnly, pending);
    return;
  }
  if (isIdentifier(value)) {
    pushIdentifierAliasSteps(value, suffix, immutableOnly, pending);
  }
}

/** Enqueues comma-expression results and, when allowed, logical branch operands. */
function pushBinaryAliasSteps(
  value: Expression & {
    readonly left: Expression;
    readonly right: Expression;
    readonly operatorToken: { readonly kind: SyntaxKind };
  },
  suffix: readonly string[],
  immutableOnly: boolean,
  pending: { readonly expr: Expression; readonly suffix: readonly string[] }[],
): void {
  const kind = value.operatorToken.kind;
  if (kind === SyntaxKind.CommaToken) {
    pending.push({ expr: value.right, suffix });
  } else if (!immutableOnly && BRANCH_OPERATORS.has(kind)) {
    pending.push({ expr: value.left, suffix }, { expr: value.right, suffix });
  }
}

/** Enqueues variable initializers, destructured global members, and reassignments for `id`. */
function pushIdentifierAliasSteps(
  id: Identifier,
  suffix: readonly string[],
  immutableOnly: boolean,
  pending: { readonly expr: Expression; readonly suffix: readonly string[] }[],
): void {
  const declared = declarationOf(id);
  if (declared !== undefined && isVariableDeclaration(declared) && isIdentifier(declared.name)) {
    const writes = bindingWrites(declared);
    if (immutableOnly && writes.reassigned) {
      return;
    }
    if (declared.initializer !== undefined) {
      pending.push({ expr: declared.initializer, suffix });
    }
    if (!immutableOnly) {
      for (const expr of writes.assigned) {
        pending.push({ expr, suffix });
      }
    }
    return;
  }
  const taken = takenApartOf(id);
  if (taken !== undefined && (!immutableOnly || !identifierReassigned(id))) {
    pending.push({ expr: taken.of, suffix: [taken.key, ...suffix] });
  }
}

/** Collects direct reassignments targeting `declaration`'s identifier within its source file. */
function bindingWrites(declaration: VariableDeclaration): {
  readonly assigned: readonly Expression[];
  readonly reassigned: boolean;
} {
  if (!isIdentifier(declaration.name)) {
    return { assigned: [], reassigned: true };
  }
  const sourceFile = declaration.getSourceFile();
  const isRead = readsOf(declaration.name, sourceFile);
  const assigned: Expression[] = [];
  let reassigned = false;
  const visit = (node: Node): void => {
    const target = writtenBy(node);
    if (target !== undefined && bindsTarget(target, isRead, false)) {
      reassigned = true;
      if (
        isBinaryExpression(node) &&
        VALUE_ASSIGNMENTS.has(node.operatorToken.kind) &&
        isIdentifier(peelPlatform(node.left)) &&
        isRead(peelPlatform(node.left))
      ) {
        assigned.push(node.right);
      }
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return { assigned, reassigned };
}

/** Whether any write in `id`'s source file reassigns `id`'s binding. */
function identifierReassigned(id: Identifier): boolean {
  const sourceFile = id.getSourceFile();
  const isRead = readsOf(id, sourceFile);
  let reassigned = false;
  const visit = (node: Node): void => {
    if (reassigned) {
      return;
    }
    const target = writtenBy(node);
    if (target !== undefined && bindsTarget(target, isRead, false)) {
      reassigned = true;
      return;
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return reassigned;
}
