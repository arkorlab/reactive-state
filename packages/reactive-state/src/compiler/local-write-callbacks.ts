import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isAsExpression,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isComputedPropertyName,
  isConditionalExpression,
  isElementAccessExpression,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isModuleBlock,
  isNonNullExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isTypeAssertion,
  isVariableDeclarationList,
  isVariableStatement,
  type NewExpression,
  type Node,
  type ObjectLiteralExpression,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, isAnswering, overloadsOf, parametersOf } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { literalKey } from './exported-values.ts';
import { readsOf } from './local-module-reads.ts';
import { ASSIGNING, isConstList, memberKey } from './local-write-paths.ts';
import type { Calls } from './local-writes.ts';
import type { Resolve } from './numbers.ts';
import { bindingIdentifiers, readsBinding } from './scope.ts';

/**
 * Resolves named, aliased, overloaded, branched, member, `.bind(...)`, and spread-array callables
 * when `local-writes.ts` checks whether a callee or callback mutates its parameters.
 */

export interface ResolvedCallable {
  readonly anyIndex: boolean;
  readonly fn: Answering;
  readonly offset: number;
}

interface Pending {
  readonly ancestors: ReadonlyMap<string, number>;
  readonly anyIndex: boolean;
  readonly expr: Expression;
  readonly offset: number;
}

interface LexicalMatch {
  readonly declarations: readonly Answering[];
  readonly expressions: readonly Expression[];
  readonly keys: readonly string[];
}

const MAX_BIND_OFFSET = 32;

const LOGICAL_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/** Source-span key identifying an AST node independent of bound-argument offsets. */
function spanKey(node: Node): string {
  return `${String(node.pos)}:${String(node.end)}`;
}

/** Direct parent wrapper expression (`(...)`, `as`, `satisfies`, `!`, `<T>`) around `node`. */
function parentWrapper(node: Expression): Expression | undefined {
  const { parent } = node;
  return (isParenthesizedExpression(parent) ||
    isAsExpression(parent) ||
    isSatisfiesExpression(parent) ||
    isNonNullExpression(parent) ||
    isTypeAssertion(parent)) &&
    parent.expression === node
    ? parent
    : undefined;
}

/** Unwraps outward parentheses, casts, and `!` wrappers around `node`. */
function topWrapped(node: Expression): Expression {
  let top = node;
  for (let next = parentWrapper(top); next !== undefined; next = parentWrapper(top)) top = next;
  return top;
}

/** Direct statement list of a block, module block, source file, or switch clause. */
function statementsOf(scope: Node): readonly Statement[] | undefined {
  if (isBlock(scope) || isSourceFile(scope) || isModuleBlock(scope)) return scope.statements;
  if (scope.kind !== SyntaxKind.CaseClause && scope.kind !== SyntaxKind.DefaultClause) {
    return undefined;
  }
  const found: Statement[] = [];
  scope.forEachChild((child) => {
    if (isFunctionDeclaration(child) || isVariableStatement(child)) found.push(child);
  });
  return found;
}

/** Enclosing function or source file where reads of `declared` may assign to it. */
function ownerScopeOf(declared: Node): Node {
  let owner = declared;
  while (!isSourceFile(owner) && !isAnswering(owner)) owner = owner.parent;
  return owner;
}

/** Right-hand expressions assigned to a mutable (`let` / `var`) identifier within its owner scope. */
function assignedExpressionsOf(declared: Identifier): readonly Expression[] {
  const owner = ownerScopeOf(declared);
  const isRead = readsOf(declared, owner);
  const assigned: Expression[] = [];
  const visit = (node: Node): void => {
    if (isRead(node) && readsBinding(node)) {
      const top = topWrapped(node);
      const { parent } = top;
      if (
        isBinaryExpression(parent) &&
        parent.left === top &&
        ASSIGNING.has(parent.operatorToken.kind)
      ) {
        assigned.push(parent.right);
      }
    }
    node.forEachChild(visit);
  };
  owner.forEachChild(visit);
  return assigned;
}

/** Collects expressions bound to a matching variable declaration `each`. */
function variableExpressions(each: {
  readonly initializer?: Expression | undefined;
  readonly name: Node;
  readonly parent: Node;
}): readonly Expression[] {
  if (!isIdentifier(each.name)) return [];
  const initial = each.initializer === undefined ? [] : [each.initializer];
  return isConstList(each.parent) ? initial : [...initial, ...assignedExpressionsOf(each.name)];
}

/** Collects matching function/variable declarations in a single lexical `statements` list. */
function matchingInStatements(
  name: string,
  statements: readonly Statement[],
): LexicalMatch | undefined {
  const declarations: Answering[] = [];
  const expressions: Expression[] = [];
  const keys: string[] = [];
  for (const statement of statements) {
    if (isFunctionDeclaration(statement) && statement.name?.text === name) {
      keys.push(spanKey(statement));
      declarations.push(statement);
    } else if (isVariableStatement(statement)) {
      for (const each of statement.declarationList.declarations) {
        if (bindingIdentifiers(each.name).some((bound) => bound.text === name)) {
          keys.push(spanKey(each));
          expressions.push(...variableExpressions(each));
        }
      }
    }
  }
  return keys.length > 0 ? { declarations, expressions, keys } : undefined;
}

/** Collects matching loop-head declarations (`for`, `for..of`, `for..in`) when `scope` is a loop. */
function matchingInLoopHead(scope: Node, name: string): LexicalMatch | undefined {
  if (!isForStatement(scope) && !isForOfStatement(scope) && !isForInStatement(scope)) {
    return undefined;
  }
  const { initializer } = scope;
  if (initializer === undefined || !isVariableDeclarationList(initializer)) return undefined;
  const expressions: Expression[] = [];
  const keys: string[] = [];
  for (const each of initializer.declarations) {
    if (bindingIdentifiers(each.name).some((bound) => bound.text === name)) {
      keys.push(spanKey(each));
      expressions.push(...variableExpressions(each));
    }
  }
  return keys.length > 0 ? { declarations: [], expressions, keys } : undefined;
}

/** Parameter match when `scope` is a function declaring `name`. */
function matchingParameter(scope: Answering, name: string): LexicalMatch | undefined {
  const parameter = parametersOf(scope).find((each) =>
    bindingIdentifiers(each.name).some((bound) => bound.text === name),
  );
  if (parameter === undefined) return undefined;
  const expressions =
    isIdentifier(parameter.name) && parameter.initializer !== undefined
      ? [parameter.initializer]
      : [];
  return { declarations: [], expressions, keys: [spanKey(parameter)] };
}

/** Resolves `id` to the innermost lexical declaration (loop head, parameter, function, variable). */
function lexicalTargets(id: Identifier): LexicalMatch {
  let scope: Node = id;
  while (!isSourceFile(scope)) {
    scope = scope.parent;
    const loopMatch = matchingInLoopHead(scope, id.text);
    if (loopMatch !== undefined) return loopMatch;
    if (isAnswering(scope)) {
      const param = matchingParameter(scope, id.text);
      if (param !== undefined) return param;
    }
    const statements = statementsOf(scope);
    const found = statements === undefined ? undefined : matchingInStatements(id.text, statements);
    if (found !== undefined) return found;
  }
  return { declarations: [], expressions: [], keys: [] };
}

/** Sub-expressions when `value` is a conditional, logical, or comma expression. */
function branchExpressions(value: Expression): readonly Expression[] | undefined {
  if (isConditionalExpression(value)) return [value.whenTrue, value.whenFalse];
  if (!isBinaryExpression(value)) return undefined;
  const kind = value.operatorToken.kind;
  if (LOGICAL_OPERATORS.has(kind)) return [value.left, value.right];
  return kind === SyntaxKind.CommaToken ? [value.right] : undefined;
}

/** Unwraps `fn.bind(thisArg, ...boundArgs)` into the underlying target and bounded parameter offset. */
function bindTarget(
  value: Expression,
  item: Pending,
  ancestors: ReadonlyMap<string, number>,
): Pending | undefined {
  if (!isCallExpression(value)) return undefined;
  const callee = unwrapped(value.expression);
  if (!isPropertyAccessExpression(callee) || callee.name.text !== 'bind') return undefined;
  if (value.arguments.some((each) => isSpreadElement(each))) {
    return { ancestors, anyIndex: true, expr: callee.expression, offset: item.offset };
  }
  const nextOffset = item.offset + Math.max(0, value.arguments.length - 1);
  if (nextOffset > MAX_BIND_OFFSET) {
    return { ancestors, anyIndex: true, expr: callee.expression, offset: MAX_BIND_OFFSET };
  }
  return { ancestors, anyIndex: item.anyIndex, expr: callee.expression, offset: nextOffset };
}

/** Extracts static property/element access keys (`undefined` if any segment is dynamic). */
function staticAccessChain(
  node: Expression,
  resolve?: Resolve,
): { readonly keys: readonly string[]; readonly root: Expression } | undefined {
  const keys: string[] = [];
  let current = unwrapped(node);
  while (isPropertyAccessExpression(current) || isElementAccessExpression(current)) {
    const key = isPropertyAccessExpression(current)
      ? current.name.text
      : memberKey(unwrapped(current.argumentExpression), resolve);
    if (key === undefined) return undefined;
    keys.unshift(key);
    current = unwrapped(current.expression);
  }
  return keys.length > 0 ? { keys, root: current } : undefined;
}

/** Reads the static name of an object-literal element, folding constant computed keys. */
function objectElementKey(name: Node, resolve?: Resolve): string | undefined {
  if (isComputedPropertyName(name)) return memberKey(unwrapped(name.expression), resolve);
  return isIdentifier(name) ? name.text : literalKey(name);
}

/** Matching methods and property initializers on `object` for `key`. */
function objectMemberTargets(
  object: ObjectLiteralExpression,
  key: string,
  resolve?: Resolve,
): LexicalMatch {
  const declarations: Answering[] = [];
  const expressions: Expression[] = [];
  for (const prop of object.properties) {
    if (isSpreadAssignment(prop)) continue;
    if (isShorthandPropertyAssignment(prop)) {
      if (isIdentifier(prop.name) && prop.name.text === key) expressions.push(prop.name);
    } else if (
      (isMethodDeclaration(prop) || isPropertyAssignment(prop)) &&
      objectElementKey(prop.name, resolve) === key
    ) {
      if (isMethodDeclaration(prop)) declarations.push(prop);
      else expressions.push(prop.initializer);
    }
  }
  return { declarations, expressions, keys: [] };
}

/** Candidate expressions for `root` (itself plus resolved/lexical initializers when an identifier). */
function rootCandidates(root: Expression, resolve?: Resolve): Expression[] {
  if (!isIdentifier(root)) return [root];
  const followed = resolve?.(root);
  const initial = followed === undefined ? [root] : [root, followed];
  return [...initial, ...lexicalTargets(root).expressions];
}

/** Walks `keys` through object literal containers starting from `root`. */
function memberTargets(node: Expression, resolve?: Resolve): LexicalMatch {
  const chain = staticAccessChain(node, resolve);
  const finalKey = chain?.keys.at(-1);
  if (chain === undefined || finalKey === undefined) {
    return { declarations: [], expressions: [], keys: [] };
  }
  let containers = rootCandidates(chain.root, resolve);
  const parentKeys = chain.keys.slice(0, -1);
  for (const key of parentKeys) {
    containers = containers.flatMap((each) => {
      const literal = unwrapped(each);
      return isObjectLiteralExpression(literal)
        ? objectMemberTargets(literal, key, resolve).expressions
        : [];
    });
  }
  const declarations: Answering[] = [];
  const expressions: Expression[] = [];
  for (const each of containers) {
    const literal = unwrapped(each);
    if (isObjectLiteralExpression(literal)) {
      const found = objectMemberTargets(literal, finalKey, resolve);
      declarations.push(...found.declarations);
      expressions.push(...found.expressions);
    }
  }
  return { declarations, expressions, keys: [] };
}

/** Processes one pending expression during callable resolution. */
function visitCallableCandidate(
  value: Expression,
  item: Pending,
  ancestors: ReadonlyMap<string, number>,
  context: {
    readonly calls: Calls;
    readonly lexical: LexicalMatch | undefined;
    readonly queue: Pending[];
    readonly record: (fn: Answering, pending: Pending) => void;
    readonly resolve?: Resolve | undefined;
  },
): void {
  const branches = branchExpressions(value);
  if (branches !== undefined) {
    for (const branch of branches) {
      context.queue.push({ ancestors, anyIndex: item.anyIndex, expr: branch, offset: item.offset });
    }
    return;
  }
  if (isArrowFunction(value) || isFunctionExpression(value)) {
    context.record(value, item);
    return;
  }
  const bound = bindTarget(value, item, ancestors);
  if (bound !== undefined) {
    context.queue.push(bound);
    return;
  }
  const direct = context.calls.functionOf(value);
  if (direct !== undefined) context.record(direct, item);
  const extra = context.lexical ?? memberTargets(value, context.resolve);
  for (const decl of extra.declarations) context.record(decl, item);
  const followed = isIdentifier(value) ? context.resolve?.(value) : undefined;
  if (followed !== undefined) {
    context.queue.push({ ancestors, anyIndex: item.anyIndex, expr: followed, offset: item.offset });
  }
  for (const next of extra.expressions) {
    context.queue.push({ ancestors, anyIndex: item.anyIndex, expr: next, offset: item.offset });
  }
}

/** Earliest bound-argument offset recorded along the active chain for any key in `keys`. */
function activeCycleOffset(
  ancestors: ReadonlyMap<string, number>,
  keys: readonly string[],
): number | undefined {
  let earliest: number | undefined;
  for (const key of keys) {
    const prior = ancestors.get(key);
    if (prior !== undefined && (earliest === undefined || prior < earliest)) earliest = prior;
  }
  return earliest;
}

/** Records `keys` in `ancestors` at `offset` when not already present on the active chain. */
function withAncestors(
  ancestors: ReadonlyMap<string, number>,
  keys: readonly string[],
  offset: number,
): ReadonlyMap<string, number> {
  const next = new Map(ancestors);
  for (const key of keys) {
    if (!next.has(key)) next.set(key, offset);
  }
  return next;
}

/** Unique string key for `(node, item)` in callable worklist deduplication. */
function pendingKey(
  node: Node,
  item: { readonly anyIndex: boolean; readonly offset: number },
): string {
  return `${spanKey(node)}:${String(item.offset)}:${item.anyIndex ? '1' : '0'}`;
}

/** Resolves all local callable declarations `node` can evaluate to at a call or callback site. */
export function functionsOf(
  node: Expression,
  calls: Calls,
  resolve?: Resolve,
): readonly ResolvedCallable[] {
  const queue: Pending[] = [{ ancestors: new Map(), anyIndex: false, expr: node, offset: 0 }];
  const seen = new Set<string>();
  const added = new Set<string>();
  const resolved: ResolvedCallable[] = [];
  const record = (fn: Answering, item: Pending): void => {
    for (const each of overloadsOf(fn)) {
      const key = pendingKey(each, item);
      if (!added.has(key)) {
        added.add(key);
        resolved.push({ anyIndex: item.anyIndex, fn: each, offset: item.offset });
      }
    }
  };
  for (let item = queue.pop(); item !== undefined; item = queue.pop()) {
    const value = unwrapped(item.expr);
    const lexical = isIdentifier(value) ? lexicalTargets(value) : undefined;
    const chainKeys = [spanKey(value), ...(lexical?.keys ?? [])];
    const priorOffset = activeCycleOffset(item.ancestors, chainKeys);
    if (priorOffset !== undefined) {
      if (!item.anyIndex && item.offset > priorOffset) {
        queue.push({ ancestors: new Map(), anyIndex: true, expr: value, offset: priorOffset });
      }
      continue;
    }
    const visitKey = pendingKey(value, item);
    if (!seen.has(visitKey)) {
      seen.add(visitKey);
      const nextAncestors = withAncestors(item.ancestors, chainKeys, item.offset);
      visitCallableCandidate(value, item, nextAncestors, {
        calls,
        lexical,
        queue,
        record,
        resolve,
      });
    }
  }
  return resolved;
}

/** Non-hole, non-spread elements of any array literal `argument` resolves to. */
function spreadArrayElements(argument: Expression, resolve?: Resolve): readonly Expression[] {
  const elements: Expression[] = [];
  const candidates = rootCandidates(unwrapped(argument), resolve);
  for (const candidate of candidates) {
    const literal = unwrapped(candidate);
    if (isArrayLiteralExpression(literal)) {
      for (const element of literal.elements) {
        if (!isSpreadElement(element) && !isOmittedExpression(element)) elements.push(element);
      }
    }
  }
  return elements;
}

/** Expands call arguments, unpacking spread array literals (`...callbacks`) into candidate elements. */
export function handedArguments(
  call: CallExpression | NewExpression,
  resolve?: Resolve,
): readonly Expression[] {
  if (call.arguments === undefined) return [];
  const expanded: Expression[] = [];
  for (const argument of call.arguments) {
    if (isSpreadElement(argument))
      expanded.push(...spreadArrayElements(argument.expression, resolve));
    else expanded.push(argument);
  }
  return expanded;
}
