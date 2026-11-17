import {
  type CallExpression,
  type ElementAccessExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isConditionalExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isForStatement,
  isIdentifier,
  isNewExpression,
  isNonNullExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isSourceFile,
  isSpreadElement,
  isTypeAssertion,
  isVariableDeclaration,
  isVariableStatement,
  type NewExpression,
  type Node,
  type PropertyAccessExpression,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { literalKey } from './exported-values.ts';
import { type FrameBinding, frameBindingOf, frameDeclarationOf } from './framed-bindings.ts';
import { readsOf } from './local-module-reads.ts';
import {
  ASSIGNING,
  COMPUTING,
  isConstList,
  isPatternTarget,
  UPDATING,
} from './local-write-paths.ts';
import { bindingIdentifiers, readsBinding } from './scope.ts';

/**
 * Lexical `const` resolution, `Symbol.*` method lookup, and per-file `String` / `RegExp` intrinsic
 * mutation checks (including local aliases and helper handoffs) for `retained-matches.ts`.
 */

export interface ConstBinding {
  readonly id: Identifier;
  readonly initializer: Expression;
}

const INTRINSIC_MUTATED = new WeakMap<SourceFile, boolean>();
const GLOBAL_HOLDERS: ReadonlySet<string> = new Set(['globalThis', 'self', 'window']);
const MATCH_CONSTRUCTORS: ReadonlySet<string> = new Set(['RegExp', 'String']);
const REGEXP_PROTOTYPE = 'RegExp.prototype';
const STRING_PROTOTYPE = 'String.prototype';
const PROTOTYPE_CANDIDATES: readonly string[] = [REGEXP_PROTOTYPE, STRING_PROTOTYPE];
const MATCH_PROTOTYPES: ReadonlySet<string> = new Set(PROTOTYPE_CANDIDATES);
const MUTATING_PROTOTYPE_METHODS: ReadonlySet<string> = new Set([
  '__defineGetter__',
  '__defineSetter__',
  'compile',
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
const READONLY_INTRINSIC_INSPECTORS: ReadonlySet<string> = new Set([
  'Object.entries',
  'Object.getOwnPropertyDescriptor',
  'Object.getOwnPropertyDescriptors',
  'Object.getOwnPropertyNames',
  'Object.getOwnPropertySymbols',
  'Object.getPrototypeOf',
  'Object.hasOwn',
  'Object.is',
  'Object.isExtensible',
  'Object.isFrozen',
  'Object.isSealed',
  'Object.keys',
  'Object.values',
  'Reflect.get',
  'Reflect.getOwnPropertyDescriptor',
  'Reflect.getPrototypeOf',
  'Reflect.has',
  'Reflect.isExtensible',
  'Reflect.ownKeys',
]);
const SAFE_CONSTRUCTOR_CALLBACK_METHODS: ReadonlySet<string> = new Set([
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
  'forEach',
  'map',
  'some',
]);
const LOGICAL_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

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

/** Unwraps outward parentheses, casts, and `!` wrappers around `expr`. */
export function topWrapped(expr: Expression): Expression {
  let top = expr;
  for (let next = parentWrapper(top); next !== undefined; next = parentWrapper(top)) top = next;
  return top;
}

/** Enclosing function or source file owning `node`. */
export function ownerScopeOf(node: Node): Node {
  let owner = node;
  while (!isSourceFile(owner) && !isAnswering(owner)) owner = owner.parent;
  return owner;
}

/** Whether `expr` sits on the write/delete/update/destructuring target side of its parent. */
export function isMutationTarget(expr: Expression): boolean {
  if (isPatternTarget(expr)) return true;
  const { parent } = expr;
  if (isDeleteExpression(parent) && parent.expression === expr) return true;
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

/** Resolves `id` to an unshadowed `const name = initializer` binding when one exists. */
export function constBindingOf(id: Identifier): ConstBinding | undefined {
  const decl = frameDeclarationOf(id);
  if (
    decl === undefined ||
    !isVariableDeclaration(decl) ||
    !isIdentifier(decl.name) ||
    decl.initializer === undefined ||
    !isConstList(decl.parent)
  ) {
    return undefined;
  }
  const container = decl.parent.parent;
  return isVariableStatement(container) || isForStatement(container)
    ? { id: decl.name, initializer: decl.initializer }
    : undefined;
}

/** Resolves unshadowed local `const` initializers for constant folding. */
export function resolveLocalConst(name: Identifier): Expression | undefined {
  return constBindingOf(name)?.initializer;
}

/** Resolves `Symbol.foo` (directly, via `globalThis`, or via local `const` aliases). */
export function symbolMethodName(key: Expression): string | undefined {
  const seen = new Set<Identifier>();
  let current = unwrapped(key);
  for (;;) {
    const path = globalPathOf(current)?.join('.');
    if (path?.startsWith('Symbol.') === true) return path;
    if (!isIdentifier(current) || seen.has(current)) return undefined;
    seen.add(current);
    const bound = constBindingOf(current);
    if (bound === undefined) return undefined;
    current = unwrapped(bound.initializer);
  }
}

/** Static property/literal name or `Symbol.*` key of a member access expression. */
export function memberOrSymbolKey(
  expr: PropertyAccessExpression | ElementAccessExpression,
): string | undefined {
  return isPropertyAccessExpression(expr)
    ? expr.name.text
    : (literalKey(unwrapped(expr.argumentExpression)) ?? symbolMethodName(expr.argumentExpression));
}

/** Projects one member `key` (`undefined` when dynamic) onto `basePaths`. */
function projectIntrinsicKey(
  basePaths: readonly string[],
  key: string | undefined,
): readonly string[] {
  const out = new Set<string>();
  for (const base of basePaths) {
    if (base === 'globalThis') {
      if (key === undefined) {
        out.add('RegExp');
        out.add('String');
      } else out.add(key);
    } else {
      out.add(key === undefined ? `${base}.*` : `${base}.${key}`);
    }
  }
  return [...out];
}

/** Projects a sequence of destructured or member `keys` onto `basePaths`. */
function projectIntrinsicKeys(
  basePaths: readonly string[],
  keys: readonly string[],
): readonly string[] {
  let current = basePaths;
  for (const key of keys) current = projectIntrinsicKey(current, key);
  return current;
}

/** Collects RHS expressions assigned to any identifier in `binding` across its owner scope. */
function assignedSourcesOf(binding: FrameBinding): readonly Expression[] {
  if (!isVariableDeclaration(binding) || isConstList(binding.parent)) return [];
  const owner = ownerScopeOf(binding);
  const matchers = bindingIdentifiers(binding.name).map((id) => readsOf(id, owner));
  const sources: Expression[] = [];
  const visit = (node: Node): void => {
    if (isIdentifier(node) && readsBinding(node) && matchers.some((match) => match(node))) {
      const top = topWrapped(node);
      for (let at: Node = top; !isSourceFile(at); at = at.parent) {
        if (isBinaryExpression(at) && ASSIGNING.has(at.operatorToken.kind) && at.right !== top) {
          sources.push(at.right);
          break;
        }
      }
    }
    node.forEachChild(visit);
  };
  owner.forEachChild(visit);
  return sources;
}

/** Candidate intrinsic paths from `Object.getPrototypeOf(arg)` or `Reflect.getPrototypeOf(arg)`. */
function prototypeCallPaths(call: CallExpression): readonly string[] {
  const callee = globalPathOf(unwrapped(call.expression))?.join('.');
  if (callee !== 'Object.getPrototypeOf' && callee !== 'Reflect.getPrototypeOf') return [];
  const first = call.arguments[0];
  if (first === undefined) return [];
  const inner = unwrapped(first);
  return isObjectLiteralExpression(inner) || isArrayLiteralExpression(inner)
    ? []
    : PROTOTYPE_CANDIDATES;
}

/** Resolves `Identifier` `id` (through `const`/`let`/`var` initializers, assignments, destructuring). */
function identifierIntrinsicPaths(
  id: Identifier,
  visiting: ReadonlySet<FrameBinding>,
): readonly string[] {
  if (GLOBAL_HOLDERS.has(id.text) && globalPathOf(id)?.length === 1) return ['globalThis'];
  const direct = globalPathOf(id)?.join('.');
  if (direct !== undefined) return [direct];
  const selected = frameBindingOf(id);
  if (selected === undefined || visiting.has(selected.binding)) return [];
  const nextVisiting = new Set([...visiting, selected.binding]);
  const initial = selected.binding.initializer === undefined ? [] : [selected.binding.initializer];
  const candidates = [...initial, ...assignedSourcesOf(selected.binding)];
  const resolved = candidates.flatMap((src) => intrinsicPathsOf(src, nextVisiting));
  return [...new Set(projectIntrinsicKeys(resolved, selected.keys))];
}

/** Resolves member access intrinsic dot-paths (`globalThis.String`, `proto.match`, `x.__proto__`). */
function memberIntrinsicPaths(
  value: PropertyAccessExpression | ElementAccessExpression,
  visiting: ReadonlySet<FrameBinding>,
): readonly string[] {
  const direct = globalPathOf(value)?.join('.');
  if (direct !== undefined) return [direct];
  const key = memberOrSymbolKey(value);
  if (key === '__proto__') {
    const recv = unwrapped(value.expression);
    return isObjectLiteralExpression(recv) || isArrayLiteralExpression(recv)
      ? []
      : PROTOTYPE_CANDIDATES;
  }
  return projectIntrinsicKey(intrinsicPathsOf(value.expression, visiting), key);
}

/** Deduplicates two intrinsic path lists without intermediate spread arrays. */
function mergePaths(left: readonly string[], right: readonly string[]): readonly string[] {
  const merged = new Set(left);
  for (const each of right) merged.add(each);
  return [...merged];
}

/** Resolves all global intrinsic dot-paths `expr` may evaluate to (including local aliases). */
function intrinsicPathsOf(
  expr: Expression,
  visiting: ReadonlySet<FrameBinding>,
): readonly string[] {
  const value = unwrapped(expr);
  if (isIdentifier(value)) return identifierIntrinsicPaths(value, visiting);
  if (isConditionalExpression(value)) {
    return mergePaths(
      intrinsicPathsOf(value.whenTrue, visiting),
      intrinsicPathsOf(value.whenFalse, visiting),
    );
  }
  if (isBinaryExpression(value)) {
    const kind = value.operatorToken.kind;
    if (LOGICAL_OPERATORS.has(kind)) {
      return mergePaths(
        intrinsicPathsOf(value.left, visiting),
        intrinsicPathsOf(value.right, visiting),
      );
    }
    return kind === SyntaxKind.CommaToken ? intrinsicPathsOf(value.right, visiting) : [];
  }
  if (isCallExpression(value)) return prototypeCallPaths(value);
  if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    return memberIntrinsicPaths(value, visiting);
  }
  return [];
}

/** Whether `path` names `RegExp`, `String`, their `.prototype`, or any member on them. */
function isMatchIntrinsicPath(path: string): boolean {
  return (
    MATCH_CONSTRUCTORS.has(path) ||
    MATCH_PROTOTYPES.has(path) ||
    path.startsWith('RegExp.') ||
    path.startsWith('String.')
  );
}

/** Whether `expr` (or any member chain base of `expr`) resolves to a match intrinsic. */
function isMatchIntrinsic(expr: Expression): boolean {
  let current = unwrapped(expr);
  for (;;) {
    if (intrinsicPathsOf(current, new Set()).some((path) => isMatchIntrinsicPath(path))) {
      return true;
    }
    if (!isPropertyAccessExpression(current) && !isElementAccessExpression(current)) return false;
    current = unwrapped(current.expression);
  }
}

/** Unpacks `arg` (and 1-level array literal elements) into candidate expressions handed to a call. */
function argumentCandidates(arg: Expression): readonly Expression[] {
  const inner = unwrapped(isSpreadElement(arg) ? arg.expression : arg);
  if (!isArrayLiteralExpression(inner)) return [inner];
  const elements: Expression[] = [inner];
  for (const element of inner.elements) {
    if (!isOmittedExpression(element)) {
      elements.push(unwrapped(isSpreadElement(element) ? element.expression : element));
    }
  }
  return elements;
}

/** Whether `call` is a read-only `Object.*` / `Reflect.*` inspection call. */
function isReadonlyInspectorCall(call: CallExpression | NewExpression): boolean {
  if (!isCallExpression(call)) return false;
  const path = globalPathOf(unwrapped(call.expression))?.join('.');
  if (path === undefined || !READONLY_INTRINSIC_INSPECTORS.has(path)) return false;
  return path !== 'Reflect.get' || call.arguments.length <= 2;
}

/** Whether passing `String` at `argIndex` to `call` is a read-only mapper callback. */
function isSafeConstructorCallback(
  call: CallExpression | NewExpression,
  argIndex: number,
  paths: readonly string[],
): boolean {
  if (!isCallExpression(call) || paths.some((path) => path !== 'String')) return false;
  const callee = unwrapped(call.expression);
  if (globalPathOf(callee)?.join('.') === 'Array.from') return argIndex === 1;
  return (
    argIndex === 0 &&
    isPropertyAccessExpression(callee) &&
    SAFE_CONSTRUCTOR_CALLBACK_METHODS.has(callee.name.text)
  );
}

/** Whether `call` mutates or leaks a match intrinsic via its callee or arguments. */
function isIntrinsicMutatingCall(call: CallExpression | NewExpression): boolean {
  const callee = unwrapped(call.expression);
  const calleePath = globalPathOf(callee)?.join('.');
  const given = call.arguments ?? [];
  const first = given[0];
  if (
    first !== undefined &&
    calleePath !== undefined &&
    MUTATING_OBJECT_GLOBALS.has(calleePath) &&
    argumentCandidates(first).some((candidate) => isMatchIntrinsic(candidate))
  ) {
    return true;
  }
  if (
    isCallExpression(call) &&
    intrinsicPathsOf(callee, new Set()).some((path) => {
      const tail = path.split('.').at(-1) ?? '';
      return isMatchIntrinsicPath(path) && MUTATING_PROTOTYPE_METHODS.has(tail);
    })
  ) {
    return true;
  }
  if (isReadonlyInspectorCall(call)) return given.some((each) => isSpreadElement(each));
  return given.some((arg, index) => {
    if (isSpreadElement(arg)) return argumentCandidates(arg).some((each) => isMatchIntrinsic(each));
    return argumentCandidates(arg).some((candidate) => {
      const paths = intrinsicPathsOf(candidate, new Set());
      const exposesHolder = paths.some(
        (path) =>
          path === 'globalThis' || MATCH_PROTOTYPES.has(path) || MATCH_CONSTRUCTORS.has(path),
      );
      return exposesHolder && !isSafeConstructorCallback(call, index, paths);
    });
  });
}

/** Whether `node` directly mutates or hands off `RegExp` / `String` or their prototypes. */
function isIntrinsicMutationNode(node: Node): boolean {
  if (isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    return (ASSIGNING.has(kind) || COMPUTING.has(kind)) && isMatchIntrinsic(node.left);
  }
  if (isDeleteExpression(node)) return isMatchIntrinsic(node.expression);
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
  return (isCallExpression(node) || isNewExpression(node)) && isIntrinsicMutatingCall(node);
}

/** Cached per-`SourceFile` check that neither `RegExp` nor `String` prototypes are mutated. */
export function mutatesMatchIntrinsics(file: SourceFile): boolean {
  const cached = INTRINSIC_MUTATED.get(file);
  if (cached !== undefined) return cached;
  const state = { mutated: false };
  const visit = (node: Node): void => {
    if (state.mutated) return;
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
