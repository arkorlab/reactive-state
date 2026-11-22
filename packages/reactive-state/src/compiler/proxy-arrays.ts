import {
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isClassStaticBlockDeclaration,
  isConditionalExpression,
  isDeleteExpression,
  isDoStatement,
  isElementAccessExpression,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isFunctionLikeDeclaration,
  isIdentifier,
  isNewExpression,
  isNonNullExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isTaggedTemplateExpression,
  isTypeAssertion,
  isTypeOfExpression,
  isVariableDeclaration,
  isVoidExpression,
  isWhileStatement,
  type Node,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { type Answering, isAnswering } from './answers.ts';
import { rootOf, targetsOf } from './kept.ts';
import { readsOf } from './local-module-reads.ts';
import {
  cachedMetadataInitializer,
  type Origin,
  peeled,
  type ProxyReading,
  sourcePath,
  writtenBefore,
} from './proxy-values.ts';
import { isTypeOnly, withinFunction } from './scope.ts';
import { writtenBy } from './written.ts';

/** Enclosing owner and transitive `const` alias set for an array binding read at `readSite`. */
export interface ArrayScope {
  readonly afterEnd: number;
  readonly aliases: ReadonlySet<Identifier>;
  readonly owner: Node;
  readonly readSite: Node;
}

/** Memoized transitive `const` alias sets keyed by root declaration identifier. */
const CONST_ARRAY_ALIASES = new WeakMap<Identifier, ReadonlySet<Identifier>>();

/** All assignment operators that write to their left-hand target. */
const ALL_ASSIGNMENTS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.AmpersandEqualsToken,
  SyntaxKind.AsteriskAsteriskEqualsToken,
  SyntaxKind.AsteriskEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.BarEqualsToken,
  SyntaxKind.CaretEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.GreaterThanGreaterThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  SyntaxKind.LessThanLessThanEqualsToken,
  SyntaxKind.MinusEqualsToken,
  SyntaxKind.PercentEqualsToken,
  SyntaxKind.PlusEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
  SyntaxKind.SlashEqualsToken,
]);

/** Equality operators that compare array identity without retaining or mutating it. */
const EQUALITY_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
]);

/** Parses a canonical non-negative integer property key (`'0'`, `'1'`, ...) into an index. */
export function arrayIndex(key: string): number | undefined {
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && String(index) === key ? index : undefined;
}

/** Filters array or rest elements by `at.excluded` when spread into an object literal. */
export function spreadElementOrigins(elements: readonly Origin[], at: Origin): readonly Origin[] {
  return elements.flatMap((each, index) => {
    const isExcluded = at.spread === true && at.excluded?.has(String(index)) === true;
    if (isExcluded || isOmittedExpression(each.value)) {
      return [];
    }
    return [{ ...each, excluded: undefined, keys: each.keys, spread: undefined }];
  });
}

/** Whether `held` can evaluate to an array literal across local constants and branches. */
export function holdsArrayLiteral(held: Expression): boolean {
  const pending: Expression[] = [held];
  const visited = new Set<Expression>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const value = peeled(next);
    if (visited.has(value)) {
      continue;
    }
    visited.add(value);
    if (isArrayLiteralExpression(value)) {
      return true;
    }
    if (isIdentifier(value)) {
      const local = cachedMetadataInitializer(value);
      if (local !== undefined) {
        pending.push(local);
      }
      continue;
    }
    if (isConditionalExpression(value)) {
      pending.push(value.whenTrue, value.whenFalse);
    } else if (isBinaryExpression(value)) {
      pushBinaryArrayBranches(value, pending);
    }
  }
  return false;
}

/** Queues branch expressions of comma and logical operators that may yield an array literal. */
function pushBinaryArrayBranches(
  value: Expression & {
    readonly left: Expression;
    readonly operatorToken: { readonly kind: SyntaxKind };
    readonly right: Expression;
  },
  pending: Expression[],
): void {
  const { kind } = value.operatorToken;
  if (kind === SyntaxKind.CommaToken) {
    pending.push(value.right);
  } else if (
    kind === SyntaxKind.AmpersandAmpersandToken ||
    kind === SyntaxKind.BarBarToken ||
    kind === SyntaxKind.QuestionQuestionToken
  ) {
    pending.push(value.left, value.right);
  }
}

/** Whether an array constant was mutated or escaped before `name` reads it. */
export function arrayChangedBefore(name: Identifier, reading: ProxyReading): boolean {
  if (writtenBefore(name, reading)) {
    return true;
  }
  const scope = constArrayScope(name);
  if (scope === undefined) {
    return false;
  }
  return [...scope.aliases].some((declared) => hasNonPassiveReadBefore(declared, scope, reading));
}

/** Whether a rest array parameter was reassigned, mutated, or escaped before `name` reads it. */
export function restArrayChangedBefore(
  fn: Answering,
  declared: Identifier,
  name: Identifier,
  reading: ProxyReading,
): boolean {
  const scope = restArrayScope(fn, declared, name);
  if (scope === undefined || fn.body === undefined) {
    return false;
  }
  if ([...scope.aliases].some((alias) => hasNonPassiveReadBefore(alias, scope, reading))) {
    return true;
  }
  return hasDirectWriteBefore(fn.body, scope);
}

/** Builds the enclosing owner and transitive `const` alias set for an array constant `name`. */
export function constArrayScope(name: Identifier): ArrayScope | undefined {
  const root = rootArrayDeclaration(name);
  if (root === undefined || !isIdentifier(root.name)) {
    return undefined;
  }
  const owner = enclosingOwner(root);
  let aliases = CONST_ARRAY_ALIASES.get(root.name);
  if (aliases === undefined) {
    aliases = new Set(collectAliasIdentifiers(root.name, owner, owner));
    CONST_ARRAY_ALIASES.set(root.name, aliases);
  }
  return { afterEnd: root.end, aliases, owner, readSite: name };
}

/** Builds the function scope and transitive `const` alias set for a rest parameter `declared`. */
export function restArrayScope(
  fn: Answering,
  declared: Identifier,
  name: Identifier,
): ArrayScope | undefined {
  if (fn.body === undefined) {
    return undefined;
  }
  const aliases = new Set(collectAliasIdentifiers(declared, fn, fn.body));
  return { afterEnd: 0, aliases, owner: fn, readSite: name };
}

/** Whether `useSite` inside `scope.owner` can execute after `afterEnd` and before `readSite`. */
export function mayRunBefore(useSite: Node, scope: ArrayScope): boolean {
  const { afterEnd, owner, readSite } = scope;
  if (useSite === owner || useSite.end <= afterEnd) {
    return false;
  }
  if (readSite === owner) {
    return true;
  }
  if (useSite === readSite) {
    return repeatsBefore(useSite, readSite, owner);
  }
  if ((readSite !== owner && withinFunction(readSite, owner)) || withinFunction(useSite, owner)) {
    return true;
  }
  return useSite.pos < readSite.pos || repeatsBefore(useSite, readSite, owner);
}

/** Unwraps parenthesized and type-assertion wrappers around `node` to reach its syntactic parent. */
export function unwrappedUse(node: Expression): {
  readonly expr: Expression;
  readonly parent: Node;
} {
  let expr = node;
  for (;;) {
    const { parent } = expr;
    if (
      isParenthesizedExpression(parent) ||
      isAsExpression(parent) ||
      isSatisfiesExpression(parent) ||
      isNonNullExpression(parent) ||
      isTypeAssertion(parent)
    ) {
      expr = parent;
      continue;
    }
    return { expr, parent };
  }
}

/** Follows local `const` aliases upstream from `name` to the earliest `const` declaration. */
function rootArrayDeclaration(name: Identifier): VariableDeclaration | undefined {
  let current: Identifier | undefined = name;
  let root: VariableDeclaration | undefined;
  const seen = new Set<VariableDeclaration>();
  while (current !== undefined) {
    const initialized = cachedMetadataInitializer(current);
    const parent = initialized?.parent;
    if (
      initialized === undefined ||
      parent === undefined ||
      !isVariableDeclaration(parent) ||
      !isIdentifier(parent.name) ||
      seen.has(parent)
    ) {
      break;
    }
    seen.add(parent);
    root = parent;
    const target = peeled(initialized);
    current = isIdentifier(target) ? target : undefined;
  }
  return root;
}

/** Expands `seed` across transitive `const alias = ...` bindings inside `searchRoot`. */
export function collectAliasIdentifiers(
  seed: Identifier,
  scopeOwner: Node,
  searchRoot: Node,
): readonly Identifier[] {
  const found: Identifier[] = [seed];
  const pending: Identifier[] = [seed];
  const seen = new Set<Identifier>([seed]);
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const isRead = readsOf(current, scopeOwner);
    const visit = (node: Node): void => {
      if (isTypeOnly(node)) {
        return;
      }
      if (isIdentifier(node) && isRead(node)) {
        const alias = constAliasName(node);
        if (alias !== undefined && !seen.has(alias)) {
          seen.add(alias);
          found.push(alias);
          pending.push(alias);
        }
      }
      node.forEachChild(visit);
    };
    searchRoot.forEachChild(visit);
  }
  return found;
}

/** Returns the declared identifier when `read` initializes a local `const` binding directly. */
function constAliasName(read: Identifier): Identifier | undefined {
  const { expr, parent } = unwrappedUse(read);
  return isVariableDeclaration(parent) &&
    parent.initializer === expr &&
    isIdentifier(parent.name) &&
    cachedMetadataInitializer(parent.name) !== undefined
    ? parent.name
    : undefined;
}

/** Checks whether any read of `declared` that may run before `scope.readSite` escapes or mutates. */
function hasNonPassiveReadBefore(
  declared: Identifier,
  scope: ArrayScope,
  reading: ProxyReading,
): boolean {
  const isRead = readsOf(declared, scope.owner);
  const visit = (node: Node): boolean => {
    if (isTypeOnly(node)) {
      return false;
    }
    if (
      isIdentifier(node) &&
      isRead(node) &&
      mayRunBefore(node, scope) &&
      constAliasName(node) === undefined &&
      !isPassiveArrayUse(node, reading)
    ) {
      return true;
    }
    return node.forEachChild((child) => (visit(child) ? true : undefined)) === true;
  };
  return scope.owner.forEachChild((child) => (visit(child) ? true : undefined)) === true;
}

/** Checks whether any direct write targets `scope.aliases` before `scope.readSite` in `root`. */
function hasDirectWriteBefore(root: Node, scope: ArrayScope): boolean {
  const matches = (candidate: Identifier): boolean =>
    [...scope.aliases].some((alias) => readsOf(alias, scope.owner)(candidate));
  const visit = (node: Node): boolean => {
    if (isTypeOnly(node)) {
      return false;
    }
    const target = mayRunBefore(node, scope) ? writtenBy(node) : undefined;
    if (
      target !== undefined &&
      targetsOf(target).some((each) => {
        const base = rootOf(each) ?? each;
        return isIdentifier(base) && matches(base);
      })
    ) {
      return true;
    }
    return node.forEachChild((child) => (visit(child) ? true : undefined)) === true;
  };
  return visit(root);
}

/** Whether `ref` inspects or spreads an array without mutating, calling methods on, or storing it. */
function isPassiveArrayUse(ref: Identifier, reading: ProxyReading): boolean {
  const { expr, parent } = unwrappedUse(ref);
  if ((isSpreadElement(parent) || isSpreadAssignment(parent)) && parent.expression === expr) {
    return true;
  }
  if (
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === expr
  ) {
    return isPassiveMemberRead(parent);
  }
  if (isVoidExpression(parent) || isTypeOfExpression(parent)) {
    return true;
  }
  if (isPrefixUnaryExpression(parent) && parent.operator === SyntaxKind.ExclamationToken) {
    return true;
  }
  if (isConditionalExpression(parent) && parent.condition === expr) {
    return true;
  }
  if (isBinaryExpression(parent) && EQUALITY_OPERATORS.has(parent.operatorToken.kind)) {
    return true;
  }
  return (
    isCallExpression(parent) &&
    parent.arguments.length === 1 &&
    parent.arguments[0] === expr &&
    sourcePath(parent.expression, reading) === 'Array.isArray'
  );
}

/** Whether `access` reads a property/element without writing to it or invoking it as a method. */
function isPassiveMemberRead(access: Expression): boolean {
  const { expr, parent } = unwrappedUse(access);
  if ((isCallExpression(parent) || isNewExpression(parent)) && parent.expression === expr) {
    return false;
  }
  if (isTaggedTemplateExpression(parent) && parent.tag === expr) {
    return false;
  }
  return !isWriteTarget(expr);
}

/** Whether `node` stands in an assignment, `delete`, increment, or loop-header write target. */
function isWriteTarget(node: Node): boolean {
  const current = outermostTargetNode(node);
  const { parent } = current;
  if (isBinaryExpression(parent) && ALL_ASSIGNMENTS.has(parent.operatorToken.kind)) {
    return parent.left === current;
  }
  if (isDeleteExpression(parent)) {
    return true;
  }
  if (isPrefixUnaryExpression(parent) || isPostfixUnaryExpression(parent)) {
    return (
      parent.operator === SyntaxKind.PlusPlusToken || parent.operator === SyntaxKind.MinusMinusToken
    );
  }
  return (isForInStatement(parent) || isForOfStatement(parent)) && parent.initializer === current;
}

/** Walks up enclosing wrappers and destructuring pattern containers around `node`. */
function outermostTargetNode(node: Node): Node {
  let current = node;
  for (;;) {
    const next = stepTargetParent(current);
    if (next === undefined) {
      return current;
    }
    current = next;
  }
}

/** Advances one wrapper or destructuring pattern container step upward from `current`. */
function stepTargetParent(current: Node): Node | undefined {
  const { parent } = current;
  if (
    isParenthesizedExpression(parent) ||
    isAsExpression(parent) ||
    isSatisfiesExpression(parent) ||
    isNonNullExpression(parent) ||
    isTypeAssertion(parent) ||
    isArrayLiteralExpression(parent) ||
    isObjectLiteralExpression(parent) ||
    isSpreadElement(parent) ||
    isSpreadAssignment(parent)
  ) {
    return parent;
  }
  if (isPropertyAssignment(parent) && parent.initializer === current) {
    return parent;
  }
  return isBinaryExpression(parent) &&
    parent.operatorToken.kind === SyntaxKind.EqualsToken &&
    parent.left === current &&
    (isArrayLiteralExpression(parent.parent) ||
      isPropertyAssignment(parent.parent) ||
      isSpreadElement(parent.parent))
    ? parent
    : undefined;
}

/** Returns the innermost function-like or static-block owner of `node`, or its `SourceFile`. */
export function enclosingOwner(node: Node): Node {
  let current = node;
  while (!isSourceFile(current)) {
    const { parent } = current;
    if (
      (isFunctionLikeDeclaration(parent) || isClassStaticBlockDeclaration(parent)) &&
      parent.body?.pos === current.pos &&
      parent.body.end === current.end
    ) {
      return parent;
    }
    if (
      isAnswering(parent) &&
      parent.body?.pos === current.pos &&
      parent.body.end === current.end
    ) {
      return parent;
    }
    current = parent;
  }
  return current;
}

/** Whether an enclosing loop inside `owner` can carry `useSite` into a later read at `readSite`. */
function repeatsBefore(useSite: Node, readSite: Node, owner: Node): boolean {
  for (let each: Node = readSite; each !== owner; each = each.parent) {
    const { parent } = each;
    if (!isLoop(parent) || useSite.pos < parent.pos || useSite.end > parent.end) {
      continue;
    }
    const once =
      (isForStatement(parent) &&
        parent.initializer?.pos === each.pos &&
        parent.initializer.end === each.end) ||
      ((isForOfStatement(parent) || isForInStatement(parent)) &&
        parent.expression.pos === each.pos &&
        parent.expression.end === each.end);
    if (!once) {
      return true;
    }
  }
  return false;
}

/** Whether `node` is a loop statement. */
function isLoop(node: Node): boolean {
  return (
    isForStatement(node) ||
    isForOfStatement(node) ||
    isForInStatement(node) ||
    isWhileStatement(node) ||
    isDoStatement(node)
  );
}
