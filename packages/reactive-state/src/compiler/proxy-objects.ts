import {
  type ArrayLiteralExpression,
  type Block,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isExpressionStatement,
  isGetAccessorDeclaration,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isTaggedTemplateExpression,
  isTypeOfExpression,
  isVariableDeclaration,
  isVoidExpression,
  type Node,
  type ObjectLiteralExpression,
  type SourceFile,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { readsOf } from './local-module-reads.ts';
import {
  type ArrayScope,
  collectAliasIdentifiers,
  enclosingOwner,
  mayRunBefore,
  unwrappedUse,
} from './proxy-arrays.ts';
import { peelAccessChain, resolvesToContainerAlias } from './proxy-containers.ts';
import {
  cachedMetadataInitializer,
  type Context,
  peeled,
  propertyKey,
  type ProxyReading,
  sourcePath,
  writtenBefore,
} from './proxy-values.ts';
import { isTypeOnly, withinFunction } from './scope.ts';
import { writtenBy } from './written.ts';

/** Memoized transitive `const` alias sets keyed by root object declaration identifier. */
const CONST_OBJECT_ALIASES = new WeakMap<Identifier, ReadonlySet<Identifier>>();

/** Memoized candidate non-passive read sites of a declared object alias inside its owner. */
const CANDIDATE_OBJECT_ESCAPES = new WeakMap<Identifier, readonly Identifier[]>();

/** Equality operators that compare object identity without mutating or retaining it. */
const EQUALITY_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
]);

/** Read-only `Object.*` inspection helpers that neither mutate nor expose new slots on `arg[0]`. */
const PASSIVE_OBJECT_CALLS: ReadonlySet<string> = new Set([
  'Object.entries',
  'Object.getOwnPropertyNames',
  'Object.isExtensible',
  'Object.isFrozen',
  'Object.isSealed',
  'Object.keys',
  'Object.values',
]);

/** Whether `held` can evaluate to an object literal across local constants and branches. */
export function holdsObjectLiteral(held: Expression): boolean {
  const pending: Expression[] = [held];
  const visited = new Set<Expression>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const value = peeled(next);
    if (visited.has(value)) {
      continue;
    }
    visited.add(value);
    if (isObjectLiteralExpression(value)) {
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
      pushBinaryObjectBranches(value, pending);
    }
  }
  return false;
}

/** Queues branch expressions of comma and logical operators that may yield an object literal. */
function pushBinaryObjectBranches(
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

/** Whether an object constant was written to or escaped into a non-passive use before `name`. */
export function objectChangedBefore(name: Identifier, reading: ProxyReading): boolean {
  if (writtenBefore(name, reading)) {
    return true;
  }
  const scope = constObjectScope(name);
  if (scope === undefined) {
    return false;
  }
  return [...scope.aliases].some((declared) =>
    hasNonPassiveObjectReadBefore(declared, scope, reading),
  );
}

/** Builds the enclosing owner and transitive `const` alias set for an object constant `name`. */
export function constObjectScope(name: Identifier): ArrayScope | undefined {
  const root = rootObjectDeclaration(name);
  if (root === undefined || !isIdentifier(root.name)) {
    return undefined;
  }
  const owner = enclosingOwner(root);
  let aliases = CONST_OBJECT_ALIASES.get(root.name);
  if (aliases === undefined) {
    aliases = new Set(collectAliasIdentifiers(root.name, owner, owner));
    CONST_OBJECT_ALIASES.set(root.name, aliases);
  }
  return { afterEnd: root.end, aliases, owner, readSite: name };
}

/** Follows local `const` aliases upstream from `name` to the earliest `const` declaration. */
function rootObjectDeclaration(name: Identifier): VariableDeclaration | undefined {
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

/** Collects and memoizes reads of `declared` in `owner` that are not syntax-only passive reads. */
function candidateObjectEscapes(declared: Identifier, owner: Node): readonly Identifier[] {
  const cached = CANDIDATE_OBJECT_ESCAPES.get(declared);
  if (cached !== undefined) {
    return cached;
  }
  const isRead = readsOf(declared, owner);
  const sites: Identifier[] = [];
  const visit = (node: Node): void => {
    if (isTypeOnly(node)) {
      return;
    }
    if (
      isIdentifier(node) &&
      isRead(node) &&
      !isConstAliasInit(node) &&
      !isSyntaxPassiveRead(node)
    ) {
      sites.push(node);
    }
    node.forEachChild(visit);
  };
  owner.forEachChild(visit);
  CANDIDATE_OBJECT_ESCAPES.set(declared, sites);
  return sites;
}

/** Checks whether any read of `declared` before `scope.readSite` escapes or mutates the object. */
function hasNonPassiveObjectReadBefore(
  declared: Identifier,
  scope: ArrayScope,
  reading: ProxyReading,
): boolean {
  return candidateObjectEscapes(declared, scope.owner).some(
    (node) => mayRunBefore(node, scope) && !isPassiveObjectCallArg(node, reading),
  );
}

/** Whether `read` directly initializes another `const` alias binding. */
function isConstAliasInit(read: Identifier): boolean {
  const { expr, parent } = unwrappedUse(read);
  return (
    isVariableDeclaration(parent) &&
    parent.initializer === expr &&
    isIdentifier(parent.name) &&
    cachedMetadataInitializer(parent.name) !== undefined
  );
}

/** Syntax-only check for spreads, property reads, unary checks, and equality comparisons. */
function isSyntaxPassiveRead(ref: Identifier): boolean {
  const { expr, parent } = unwrappedUse(ref);
  if (isSpreadAssignment(parent) && parent.expression === expr) {
    return true;
  }
  if (
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === expr
  ) {
    return isPassivePropertyRead(parent);
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
  return isBinaryExpression(parent) && EQUALITY_OPERATORS.has(parent.operatorToken.kind);
}

/** Checks whether `ref` is the sole argument to a read-only `Object.*` static helper. */
function isPassiveObjectCallArg(ref: Identifier, reading: ProxyReading): boolean {
  const { expr, parent } = unwrappedUse(ref);
  return (
    isCallExpression(parent) &&
    parent.arguments.length === 1 &&
    parent.arguments[0] === expr &&
    PASSIVE_OBJECT_CALLS.has(sourcePath(parent.expression, reading) ?? '')
  );
}

/** Whether `ref` inspects or spreads an object without mutating, calling methods on, or storing it. */
function isPassiveObjectUse(ref: Identifier, reading: ProxyReading): boolean {
  return isSyntaxPassiveRead(ref) || isPassiveObjectCallArg(ref, reading);
}

/** Whether `access` reads a property without invoking it as a method or writing to it. */
function isPassivePropertyRead(access: Expression): boolean {
  const { expr, parent } = unwrappedUse(access);
  if ((isCallExpression(parent) || isNewExpression(parent)) && parent.expression === expr) {
    return false;
  }
  if (isTaggedTemplateExpression(parent) && parent.tag === expr) {
    return false;
  }
  return writtenBy(parent) === undefined;
}

/** Collects plain data keys on `held` unconditionally overwritten before `name` with no later escape. */
export function overwrittenPlainKeys(
  name: Identifier,
  held: Expression,
  scope: ArrayScope,
  context: Context,
): ReadonlySet<string> {
  const literal = peeled(held);
  if (
    !isObjectLiteralExpression(literal) ||
    withinFunction(name, scope.owner) ||
    !isPlainDataObjectLiteral(literal, context)
  ) {
    return new Set();
  }
  const overwrittenAt = new Map<string, number>();
  for (let child: Node = name; child !== scope.owner; child = child.parent) {
    const { parent } = child;
    if (isBlock(parent) || isSourceFile(parent)) {
      collectBlockOverwrites(parent, child, scope, { context, overwrittenAt });
    }
  }
  if (overwrittenAt.size === 0) {
    return new Set();
  }
  const earliest = Math.min(...overwrittenAt.values());
  return hasEscapeBetween(earliest, scope, context) ? new Set() : new Set(overwrittenAt.keys());
}

/** Checks that `literal` has no spreads, dynamic keys, or accessors that intercept plain writes. */
function isPlainDataObjectLiteral(literal: ObjectLiteralExpression, context: Context): boolean {
  return literal.properties.every((prop) => {
    if (
      isSpreadAssignment(prop) ||
      isGetAccessorDeclaration(prop) ||
      isSetAccessorDeclaration(prop)
    ) {
      return false;
    }
    return propertyKey(prop.name, context) !== undefined;
  });
}

/** Scans statements in `container` before `stop` for unconditional direct property assignments. */
function collectBlockOverwrites(
  container: Block | SourceFile,
  stop: Node,
  scope: ArrayScope,
  state: { readonly context: Context; readonly overwrittenAt: Map<string, number> },
): void {
  for (const statement of container.statements) {
    if (statement === stop || statement.end > stop.pos) {
      break;
    }
    if (statement.end <= scope.afterEnd || !isExpressionStatement(statement)) {
      continue;
    }
    for (const key of unconditionalDirectKeys(statement.expression, scope, state.context)) {
      state.overwrittenAt.set(key, statement.end);
    }
  }
}

/** Extracts static own property keys unconditionally assigned on `scope.aliases` by `expr`. */
function unconditionalDirectKeys(
  expr: Expression,
  scope: ArrayScope,
  context: Context,
): readonly string[] {
  const current = peeled(expr);
  if (!isBinaryExpression(current)) {
    return [];
  }
  if (current.operatorToken.kind === SyntaxKind.CommaToken) {
    return [
      ...unconditionalDirectKeys(current.left, scope, context),
      ...unconditionalDirectKeys(current.right, scope, context),
    ];
  }
  return current.operatorToken.kind === SyntaxKind.EqualsToken
    ? patternDirectKeys(current.left, scope, context)
    : [];
}

/** Extracts static direct member keys on `scope.aliases` unconditionally bound by `pattern`. */
function patternDirectKeys(
  pattern: Expression,
  scope: ArrayScope,
  context: Context,
): readonly string[] {
  const found: string[] = [];
  const pending: Expression[] = [pattern];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const current = peeled(next);
    if (isPropertyAccessExpression(current) || isElementAccessExpression(current)) {
      const key = singleDirectMemberKey(current, scope, context);
      if (key !== undefined) {
        found.push(key);
      }
    } else {
      pushPatternChildren(current, pending);
    }
  }
  return found;
}

/** Enqueues nested assignment-pattern sub-targets onto `pending`. */
function pushPatternChildren(current: Expression, pending: Expression[]): void {
  if (isBinaryExpression(current) && current.operatorToken.kind === SyntaxKind.EqualsToken) {
    pending.push(current.left);
    return;
  }
  if (isArrayLiteralExpression(current)) {
    enqueueArrayPatternChildren(current, pending);
    return;
  }
  if (isObjectLiteralExpression(current)) {
    for (const prop of current.properties) {
      if (isPropertyAssignment(prop)) {
        pending.push(prop.initializer);
      }
    }
  }
}

/** Enqueues element sub-targets from an array destructuring assignment target. */
function enqueueArrayPatternChildren(current: ArrayLiteralExpression, pending: Expression[]): void {
  for (const el of current.elements) {
    if (!isOmittedExpression(el)) {
      pending.push(isSpreadElement(el) ? el.expression : el);
    }
  }
}

/** Extracts `key` when `access` is a single direct static non-`__proto__` member on `scope`. */
function singleDirectMemberKey(
  access: Expression,
  scope: ArrayScope,
  context: Context,
): string | undefined {
  const { keys, root } = peelAccessChain(access, context);
  const [onlyKey] = keys;
  const isValidKey = onlyKey !== undefined && onlyKey !== null && onlyKey !== '__proto__';
  if (isValidKey && keys.length === 1 && resolvesToContainerAlias(root, scope, context)) {
    return onlyKey;
  }
  return undefined;
}

/** Checks whether `scope.aliases` escapes into a call or container after `fromPos` before `readSite`. */
function hasEscapeBetween(fromPos: number, scope: ArrayScope, reading: ProxyReading): boolean {
  return [...scope.aliases].some((declared) => {
    const isRead = readsOf(declared, scope.owner);
    const visit = (node: Node): boolean => {
      if (isTypeOnly(node)) {
        return false;
      }
      if (
        isIdentifier(node) &&
        isRead(node) &&
        node.pos >= fromPos &&
        mayRunBefore(node, scope) &&
        !isConstAliasInit(node) &&
        !isPassiveOrDirectMemberUse(node, reading)
      ) {
        return true;
      }
      return node.forEachChild((child) => (visit(child) ? true : undefined)) === true;
    };
    return scope.owner.forEachChild((child) => (visit(child) ? true : undefined)) === true;
  });
}

/** Whether `ref` is either passive or a direct property assignment on `ref` (not escaping `ref`). */
function isPassiveOrDirectMemberUse(ref: Identifier, reading: ProxyReading): boolean {
  if (isPassiveObjectUse(ref, reading)) {
    return true;
  }
  const { expr, parent } = unwrappedUse(ref);
  if (!isPropertyAccessExpression(parent) && !isElementAccessExpression(parent)) {
    return false;
  }
  const outer = unwrappedUse(parent).parent;
  return parent.expression === expr && !isCallExpression(outer) && !isNewExpression(outer);
}
