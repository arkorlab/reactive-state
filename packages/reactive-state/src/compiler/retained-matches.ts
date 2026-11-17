import {
  type CallExpression,
  type ElementAccessExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isClassExpression,
  isConditionalExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isModuleBlock,
  isNewExpression,
  isObjectLiteralExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isRegularExpressionLiteral,
  isSourceFile,
  isSpreadElement,
  isVariableDeclaration,
  isVariableStatement,
  type NewExpression,
  type Node,
  type PropertyAccessExpression,
  type SourceFile,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { isAnswering, parametersOf } from './answers.ts';
import { globalOf, unwrapped } from './bounded.ts';
import { literalKey } from './exported-values.ts';
import { globalPath } from './global-answers.ts';
import { readsOf } from './local-module-reads.ts';
import {
  ASSIGNING,
  COMPUTING,
  handedTo,
  isConstList,
  isPatternTarget,
  isWrapping,
  UPDATING,
} from './local-write-paths.ts';
import { constantValue } from './numbers.ts';
import { bindingIdentifiers } from './scope.ts';

/**
 * Distinguishes native global `RegExp` matches (`'aba'.match(/a/g)`, `re[Symbol.match]('aba')`),
 * which return `string[] | null` without extra match properties, from non-global, string-pattern,
 * dynamic-flag, or mutated matches that return decorated match arrays (`index`, `input`, `groups`).
 */

interface ConstBinding {
  readonly id: Identifier;
  readonly initializer: Expression;
}

type ConstLookup =
  | { readonly binding: ConstBinding; readonly kind: 'found' }
  | { readonly kind: 'none' }
  | { readonly kind: 'shadowed' };

interface RegExpObligation {
  readonly expr: Expression;
  readonly visiting: ReadonlySet<Identifier>;
}

const INTRINSIC_MUTATED = new WeakMap<SourceFile, boolean>();

const VALID_REGEXP_FLAGS: ReadonlySet<string> = new Set(['d', 'g', 'i', 'm', 's', 'u', 'v', 'y']);

const MATCH_INTRINSICS: ReadonlySet<string> = new Set([
  'RegExp',
  'RegExp.prototype',
  'String',
  'String.prototype',
]);

const MUTATING_OBJECT_GLOBALS: ReadonlySet<string> = new Set([
  'Object.assign',
  'Object.defineProperties',
  'Object.defineProperty',
  'Object.setPrototypeOf',
  'Reflect.defineProperty',
  'Reflect.deleteProperty',
  'Reflect.set',
  'Reflect.setPrototypeOf',
]);

const SAFE_REGEXP_METHODS: ReadonlySet<string> = new Set([
  'exec',
  'Symbol.match',
  'Symbol.matchAll',
  'Symbol.replace',
  'Symbol.search',
  'Symbol.split',
  'test',
  'toString',
  'valueOf',
]);

const SAFE_STRING_PATTERN_METHODS: ReadonlySet<string> = new Set([
  'match',
  'matchAll',
  'replace',
  'replaceAll',
  'search',
  'split',
]);

/** Direct statements of a lexical scope container (`Block`, `SourceFile`, `ModuleBlock`, clause). */
function scopeStatements(scope: Node): readonly Statement[] | undefined {
  if (isBlock(scope) || isSourceFile(scope) || isModuleBlock(scope)) {
    return scope.statements;
  }
  if (scope.kind === SyntaxKind.CaseClause || scope.kind === SyntaxKind.DefaultClause) {
    const found: Statement[] = [];
    scope.forEachChild((child) => {
      if (isFunctionDeclaration(child) || isVariableStatement(child)) {
        found.push(child);
      }
    });
    return found;
  }
  return undefined;
}

/** Finds a unique `const name = initializer` declaration in `statements`, or `'shadowed'`. */
function constInStatements(name: string, statements: readonly Statement[]): ConstLookup {
  let match: ConstBinding | undefined;
  for (const statement of statements) {
    if (isFunctionDeclaration(statement) && statement.name?.text === name) {
      return { kind: 'shadowed' };
    }
    if (!isVariableStatement(statement)) {
      continue;
    }
    for (const decl of statement.declarationList.declarations) {
      if (bindingIdentifiers(decl.name).every((bound) => bound.text !== name)) {
        continue;
      }
      if (
        match !== undefined ||
        !isConstList(decl.parent) ||
        !isIdentifier(decl.name) ||
        decl.initializer === undefined
      ) {
        return { kind: 'shadowed' };
      }
      match = { id: decl.name, initializer: decl.initializer };
    }
  }
  return match === undefined ? { kind: 'none' } : { binding: match, kind: 'found' };
}

/** Resolves `id` to an unshadowed lexical `const` binding when one exists. */
function constBindingOf(id: Identifier): ConstBinding | undefined {
  let scope: Node = id;
  while (!isSourceFile(scope)) {
    scope = scope.parent;
    if (
      isAnswering(scope) &&
      parametersOf(scope).some((param) =>
        bindingIdentifiers(param.name).some((bound) => bound.text === id.text),
      )
    ) {
      return undefined;
    }
    const statements = scopeStatements(scope);
    if (statements !== undefined) {
      const found = constInStatements(id.text, statements);
      if (found.kind === 'shadowed') {
        return undefined;
      }
      if (found.kind === 'found') {
        return found.binding;
      }
    }
  }
  return undefined;
}

/** Resolves `Symbol.foo` (directly, via `globalThis`, or via local `const` aliases). */
export function symbolMethodName(key: Expression): string | undefined {
  const seen = new Set<Identifier>();
  let current = unwrapped(key);
  for (;;) {
    const path = globalPath(current)?.join('.');
    if (path?.startsWith('Symbol.') === true) {
      return path;
    }
    if (!isIdentifier(current) || seen.has(current)) {
      return undefined;
    }
    seen.add(current);
    const bound = constBindingOf(current);
    if (bound === undefined) {
      return undefined;
    }
    current = unwrapped(bound.initializer);
  }
}

/** Whether `expr` addresses `RegExp`, `String`, their `.prototype`, or any member of them. */
function isMatchIntrinsic(expr: Expression): boolean {
  let current = unwrapped(expr);
  while (isElementAccessExpression(current) || isPropertyAccessExpression(current)) {
    const path = globalPath(current)?.join('.');
    if (
      path !== undefined &&
      (MATCH_INTRINSICS.has(path) || path.startsWith('RegExp.') || path.startsWith('String.'))
    ) {
      return true;
    }
    current = unwrapped(current.expression);
  }
  const rootPath = globalPath(current)?.join('.');
  return rootPath !== undefined && MATCH_INTRINSICS.has(rootPath);
}

/** Whether `node` directly mutates `RegExp` / `String` or their prototypes. */
function isIntrinsicMutationNode(node: Node): boolean {
  if (isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    return (ASSIGNING.has(kind) || COMPUTING.has(kind)) && isMatchIntrinsic(node.left);
  }
  if (isDeleteExpression(node)) {
    return isMatchIntrinsic(node.expression);
  }
  if (
    (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)) &&
    UPDATING.has(node.operator)
  ) {
    return isMatchIntrinsic(node.operand);
  }
  if (
    (isPropertyAccessExpression(node) || isElementAccessExpression(node)) &&
    isPatternTarget(node)
  ) {
    return isMatchIntrinsic(node);
  }
  if (isCallExpression(node) || isNewExpression(node)) {
    const callee = globalPath(unwrapped(node.expression))?.join('.');
    const first = node.arguments?.[0];
    return (
      callee !== undefined &&
      MUTATING_OBJECT_GLOBALS.has(callee) &&
      first !== undefined &&
      !isSpreadElement(first) &&
      isMatchIntrinsic(first)
    );
  }
  return false;
}

/** Cached per-`SourceFile` check that neither `RegExp` nor `String` prototypes are mutated. */
function mutatesMatchIntrinsics(file: SourceFile): boolean {
  const cached = INTRINSIC_MUTATED.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const state = { mutated: false };
  const visit = (node: Node): void => {
    if (state.mutated) {
      return;
    }
    if (isIntrinsicMutationNode(node)) {
      state.mutated = true;
      return;
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  INTRINSIC_MUTATED.set(file, state.mutated);
  return state.mutated;
}

/** Unwraps outward parentheses, casts, and `!` wrappers around `expr`. */
function topWrapped(expr: Expression): Expression {
  let top = expr;
  while (isWrapping(top.parent, top)) {
    top = top.parent as Expression;
  }
  return top;
}

/** Whether `expr` sits on the write/delete/update/destructuring target side of its parent. */
function isMutationTarget(expr: Expression): boolean {
  if (isPatternTarget(expr)) {
    return true;
  }
  const { parent } = expr;
  if (isDeleteExpression(parent) && parent.expression === expr) {
    return true;
  }
  if (
    (isPrefixUnaryExpression(parent) || isPostfixUnaryExpression(parent)) &&
    parent.operand === expr &&
    UPDATING.has(parent.operator)
  ) {
    return true;
  }
  return (
    isBinaryExpression(parent) &&
    parent.left === expr &&
    (ASSIGNING.has(parent.operatorToken.kind) || COMPUTING.has(parent.operatorToken.kind))
  );
}

/** Checks whether a member access `parent` on `re` is a non-mutating read or safe method call. */
function isSafeRegExpMember(parent: PropertyAccessExpression | ElementAccessExpression): boolean {
  const key = isPropertyAccessExpression(parent)
    ? parent.name.text
    : (literalKey(unwrapped(parent.argumentExpression)) ??
      symbolMethodName(parent.argumentExpression));
  const memberTop = topWrapped(parent);
  if (isMutationTarget(memberTop)) {
    return false;
  }
  if (isCallExpression(memberTop.parent) && memberTop.parent.expression === memberTop) {
    return key !== undefined && SAFE_REGEXP_METHODS.has(key);
  }
  return handedTo(memberTop) === undefined;
}

/** Checks whether passing `top` as an argument to `call` preserves `re` unmutated. */
function isSafeRegExpArgument(top: Expression, call: CallExpression | NewExpression): boolean {
  if (isSpreadElement(top.parent) || call.arguments?.[0] !== top) {
    return false;
  }
  const callee = unwrapped(call.expression);
  if (globalPath(callee)?.join('.') === 'RegExp') {
    return true;
  }
  return (
    isCallExpression(call) &&
    isPropertyAccessExpression(callee) &&
    SAFE_STRING_PATTERN_METHODS.has(callee.name.text)
  );
}

/** Whether `declared` (`const re = …`) can be mutated or escape anywhere in its owner scope. */
function isRegExpMutated(declared: Identifier, checked: ReadonlySet<Identifier>): boolean {
  if (checked.has(declared)) {
    return false;
  }
  const nextChecked = new Set([...checked, declared]);
  let owner: Node = declared;
  while (!isSourceFile(owner) && !isAnswering(owner)) {
    owner = owner.parent;
  }
  const isRead = readsOf(declared, owner);
  const state = { mutated: false };
  const visit = (node: Node): void => {
    if (state.mutated) {
      return;
    }
    if (isRead(node) && !isSafeRegExpRead(node, nextChecked)) {
      state.mutated = true;
      return;
    }
    node.forEachChild(visit);
  };
  owner.forEachChild(visit);
  return state.mutated;
}

/** Whether a single reference `read` to a `const` `RegExp` binding is read-only. */
function isSafeRegExpRead(read: Identifier, checked: ReadonlySet<Identifier>): boolean {
  const top = topWrapped(read);
  if (isMutationTarget(top)) {
    return false;
  }
  const { parent } = top;
  if (isVariableDeclaration(parent) && parent.initializer === top) {
    return (
      isConstList(parent.parent) &&
      isIdentifier(parent.name) &&
      !isRegExpMutated(parent.name, checked)
    );
  }
  if (
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === top
  ) {
    return isSafeRegExpMember(parent);
  }
  const call = handedTo(top);
  return call !== undefined && isSafeRegExpArgument(top, call);
}

/** Validates ECMAScript `RegExp` flags (`g` present, unique valid flag letters, not both `u` & `v`). */
function hasValidGlobalFlags(flags: string): boolean {
  if (!flags.includes('g') || (flags.includes('u') && flags.includes('v'))) {
    return false;
  }
  const seen = new Set<string>();
  for (const ch of flags) {
    if (!VALID_REGEXP_FLAGS.has(ch) || seen.has(ch)) {
      return false;
    }
    seen.add(ch);
  }
  return true;
}

/** Resolves unshadowed local `const` initializers for constant folding of `RegExp` arguments. */
function resolveLocalConst(name: Identifier): Expression | undefined {
  return constBindingOf(name)?.initializer;
}

/** Evaluates `RegExp(pattern, flags)` / `new RegExp(pattern, flags)`, pushing sub-obligations. */
function checkConstructedRegExp(
  expr: CallExpression | NewExpression,
  visiting: ReadonlySet<Identifier>,
  stack: RegExpObligation[],
): boolean {
  if (globalPath(unwrapped(expr.expression))?.join('.') !== 'RegExp') {
    return false;
  }
  const given = expr.arguments ?? [];
  const first = given[0];
  const second = given[1];
  if (
    first === undefined ||
    isSpreadElement(first) ||
    (second !== undefined && isSpreadElement(second))
  ) {
    return false;
  }
  const secondInner = second === undefined ? undefined : unwrapped(second);
  if (
    secondInner === undefined ||
    (isIdentifier(secondInner) && globalOf(secondInner) === 'undefined')
  ) {
    stack.push({ expr: first, visiting });
    return true;
  }
  if (isObjectLiteralExpression(unwrapped(first))) {
    return false;
  }
  const foldedFlags = constantValue(secondInner, resolveLocalConst);
  return typeof foldedFlags === 'string' && hasValidGlobalFlags(foldedFlags);
}

/** Evaluates a single `RegExp` obligation item on `stack`. */
function stepGlobalRegExp(item: RegExpObligation, stack: RegExpObligation[]): boolean {
  const value = unwrapped(item.expr);
  if (isConditionalExpression(value)) {
    stack.push(
      { expr: value.whenTrue, visiting: item.visiting },
      { expr: value.whenFalse, visiting: item.visiting },
    );
    return true;
  }
  if (isRegularExpressionLiteral(value)) {
    const slash = value.text.lastIndexOf('/');
    return slash > 0 && value.text.slice(slash + 1).includes('g');
  }
  if (isCallExpression(value) || isNewExpression(value)) {
    return checkConstructedRegExp(value, item.visiting, stack);
  }
  if (isIdentifier(value) && globalOf(value) === undefined) {
    const bound = constBindingOf(value);
    if (
      bound === undefined ||
      item.visiting.has(bound.id) ||
      isRegExpMutated(bound.id, new Set())
    ) {
      return false;
    }
    stack.push({ expr: bound.initializer, visiting: new Set([...item.visiting, bound.id]) });
    return true;
  }
  return false;
}

/** Proves `root` evaluates to an unmutated native `RegExp` carrying the `'g'` flag. */
function isGlobalRegExp(root: Expression): boolean {
  const stack: RegExpObligation[] = [{ expr: root, visiting: new Set() }];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    if (!stepGlobalRegExp(item, stack)) {
      return false;
    }
  }
  return true;
}

/** Rejects receivers of `.match(…)` proven to be non-string objects that may define custom `.match`. */
function isKnownNonStringReceiver(receiver: Expression): boolean {
  const seen = new Set<Identifier>();
  let current = unwrapped(receiver);
  while (isIdentifier(current) && !seen.has(current)) {
    seen.add(current);
    const bound = constBindingOf(current);
    if (bound === undefined) {
      return false;
    }
    current = unwrapped(bound.initializer);
  }
  if (
    isObjectLiteralExpression(current) ||
    isArrayLiteralExpression(current) ||
    isRegularExpressionLiteral(current) ||
    isArrowFunction(current) ||
    isFunctionExpression(current) ||
    isClassExpression(current)
  ) {
    return true;
  }
  if (isNewExpression(current)) {
    return globalPath(unwrapped(current.expression))?.join('.') !== 'String';
  }
  if (isCallExpression(current)) {
    const path = globalPath(unwrapped(current.expression))?.join('.') ?? '';
    return path.startsWith('Object.');
  }
  return false;
}

/** Whether `call` (`str.match(re)` or `re[Symbol.match](str)`) returns a plain `string[] | null`. */
export function isGlobalMatch(
  call: CallExpression,
  callee: PropertyAccessExpression | ElementAccessExpression,
  name: string,
): boolean {
  if (mutatesMatchIntrinsics(call.getSourceFile())) {
    return false;
  }
  if (name === 'Symbol.match') {
    return isGlobalRegExp(callee.expression);
  }
  if (isKnownNonStringReceiver(callee.expression)) {
    return false;
  }
  const first = call.arguments[0];
  if (first === undefined || isSpreadElement(first)) {
    return false;
  }
  return isGlobalRegExp(first);
}
