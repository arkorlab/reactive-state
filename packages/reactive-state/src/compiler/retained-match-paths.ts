import {
  type CallExpression,
  type ElementAccessExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isAsExpression,
  isBigIntLiteral,
  isBinaryExpression,
  isCallExpression,
  isClassExpression,
  isConditionalExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isForStatement,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isNonNullExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isRegularExpressionLiteral,
  isSatisfiesExpression,
  isSourceFile,
  isStringLiteral,
  isTaggedTemplateExpression,
  isTemplateExpression,
  isTypeAssertion,
  isVariableDeclaration,
  isVariableStatement,
  type NewExpression,
  type Node,
  type PropertyAccessExpression,
  SyntaxKind,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { isVisiting, whereUnstopped } from './cycle-memo.ts';
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
 * Lexical `const` resolution, `Symbol.*` method lookup, and `String` / `RegExp` intrinsic or
 * instance dot-path resolution (including `.constructor` and `.__proto__` chains).
 */

export interface ConstBinding {
  readonly id: Identifier;
  readonly initializer: Expression;
}

export const GLOBAL_THIS = 'globalThis';
const INSTANCE_REGEXP = 'instance:RegExp';
const INSTANCE_STRING = 'instance:String';
const INSTANCE_OTHER = 'instance:other';
const REGEXP_PROTOTYPE = 'RegExp.prototype';
const STRING_PROTOTYPE = 'String.prototype';
const GLOBAL_HOLDERS: ReadonlySet<string> = new Set([GLOBAL_THIS, 'self', 'window']);
const CONSTRUCTOR_CANDIDATES: readonly string[] = ['RegExp', 'String'];
const PROTOTYPE_CANDIDATES: readonly string[] = [REGEXP_PROTOTYPE, STRING_PROTOTYPE];
export const MATCH_CONSTRUCTORS: ReadonlySet<string> = new Set(CONSTRUCTOR_CANDIDATES);
export const MATCH_PROTOTYPES: ReadonlySet<string> = new Set(PROTOTYPE_CANDIDATES);
const STRING_FACTORY_PATHS: ReadonlySet<string> = new Set([
  'String',
  'String.fromCharCode',
  'String.fromCodePoint',
  'String.raw',
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

/** Static property/literal name, folded `const` key, or `Symbol.*` key of a member access. */
export function memberOrSymbolKey(
  expr: PropertyAccessExpression | ElementAccessExpression,
): string | undefined {
  if (isPropertyAccessExpression(expr)) return expr.name.text;
  const arg = unwrapped(expr.argumentExpression);
  const direct = literalKey(arg) ?? symbolMethodName(expr.argumentExpression);
  if (direct !== undefined || !isIdentifier(arg)) return direct;
  const bound = constBindingOf(arg);
  return bound === undefined ? undefined : literalKey(unwrapped(bound.initializer));
}

/** Projects `key` onto a known `RegExp` or `String` instance marker. */
function projectInstanceBase(
  ctor: string,
  proto: string,
  key: string | undefined,
  out: Set<string>,
): void {
  switch (key) {
    case 'constructor': {
      out.add(ctor);
      break;
    }
    case '__proto__': {
      out.add(proto);
      break;
    }
    case undefined: {
      out.add(ctor);
      out.add(proto);
      break;
    }
    default: {
      break;
    }
  }
}

/** Projects one member `key` (`undefined` when dynamic) onto a single `base` path. */
function projectSingleBase(base: string, key: string | undefined, out: Set<string>): void {
  if (base === GLOBAL_THIS) {
    if (key === undefined) {
      out.add('RegExp');
      out.add('String');
    } else out.add(key);
    return;
  }
  if (base === INSTANCE_REGEXP) {
    projectInstanceBase('RegExp', REGEXP_PROTOTYPE, key, out);
    return;
  }
  if (base === INSTANCE_STRING) {
    projectInstanceBase('String', STRING_PROTOTYPE, key, out);
    return;
  }
  if (base === INSTANCE_OTHER) return;
  if (key === 'constructor' && (base === REGEXP_PROTOTYPE || base === STRING_PROTOTYPE)) {
    out.add(base === REGEXP_PROTOTYPE ? 'RegExp' : 'String');
    return;
  }
  out.add(key === undefined ? `${base}.*` : `${base}.${key}`);
}

/** Projects one member `key` (`undefined` when dynamic) onto `basePaths`. */
function projectIntrinsicKey(
  basePaths: readonly string[],
  key: string | undefined,
): readonly string[] {
  const out = new Set<string>();
  for (const base of basePaths) projectSingleBase(base, key, out);
  return [...out];
}

/** Conservative candidate paths for `.constructor` / `.__proto__` on an unknown receiver. */
function unknownReceiverPaths(key: string | undefined): readonly string[] {
  if (key === 'constructor') return CONSTRUCTOR_CANDIDATES;
  return key === '__proto__' ? PROTOTYPE_CANDIDATES : [];
}

/** Projects destructured `keys` onto `basePaths` (falling back when `basePaths` is opaque). */
function projectIntrinsicKeys(
  basePaths: readonly string[],
  keys: readonly string[],
): readonly string[] {
  const firstKey = keys[0];
  const fallback = firstKey !== undefined && basePaths.length === 0;
  let current = fallback ? unknownReceiverPaths(firstKey) : basePaths;
  const remaining = fallback ? keys.slice(1) : keys;
  for (const key of remaining) current = projectIntrinsicKey(current, key);
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

/** Candidate prototype paths returned by `Object.getPrototypeOf(arg)` / `Reflect.getPrototypeOf`. */
function prototypeOfTargetPaths(
  first: Expression | undefined,
  visiting: ReadonlySet<FrameBinding>,
): readonly string[] {
  if (first === undefined) return [];
  const argPaths = intrinsicPathsOf(first, visiting);
  if (argPaths.length === 0) return PROTOTYPE_CANDIDATES;
  const out = new Set<string>();
  for (const path of argPaths) {
    switch (path) {
      case INSTANCE_REGEXP: {
        out.add(REGEXP_PROTOTYPE);
        break;
      }
      case INSTANCE_STRING: {
        out.add(STRING_PROTOTYPE);
        break;
      }
      case INSTANCE_OTHER: {
        break;
      }
      default: {
        out.add(REGEXP_PROTOTYPE);
        out.add(STRING_PROTOTYPE);
        break;
      }
    }
  }
  return [...out];
}

/** Intrinsic or instance paths produced by a `CallExpression` or `NewExpression`. */
function callIntrinsicPaths(
  call: CallExpression | NewExpression,
  visiting: ReadonlySet<FrameBinding>,
): readonly string[] {
  const globalCallee = globalPathOf(unwrapped(call.expression))?.join('.');
  if (
    (globalCallee === 'Object.getPrototypeOf' || globalCallee === 'Reflect.getPrototypeOf') &&
    isCallExpression(call)
  ) {
    return prototypeOfTargetPaths(call.arguments[0], visiting);
  }
  if (globalCallee === 'Reflect.construct' && isCallExpression(call)) {
    const target = call.arguments[2] ?? call.arguments[0];
    if (target === undefined) return [];
    const targetPaths = intrinsicPathsOf(target, visiting);
    const constructed: string[] = [];
    if (targetPaths.includes('RegExp')) constructed.push(INSTANCE_REGEXP);
    if (targetPaths.includes('String')) constructed.push(INSTANCE_STRING);
    return constructed;
  }
  const calleePaths = intrinsicPathsOf(call.expression, visiting);
  const out: string[] = [];
  if (calleePaths.includes('RegExp')) out.push(INSTANCE_REGEXP);
  if (calleePaths.some((path) => STRING_FACTORY_PATHS.has(path))) out.push(INSTANCE_STRING);
  return out;
}

/** Classifies literal expressions into `RegExp`, `String`, or non-match instance markers. */
function literalInstancePaths(value: Expression): readonly string[] | undefined {
  if (isRegularExpressionLiteral(value)) return [INSTANCE_REGEXP];
  if (
    isStringLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value) ||
    isTemplateExpression(value)
  ) {
    return [INSTANCE_STRING];
  }
  const kind = value.kind;
  if (
    kind === SyntaxKind.TrueKeyword ||
    kind === SyntaxKind.FalseKeyword ||
    isObjectLiteralExpression(value) ||
    isArrayLiteralExpression(value) ||
    isNumericLiteral(value) ||
    isBigIntLiteral(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    isClassExpression(value)
  ) {
    return [INSTANCE_OTHER];
  }
  return undefined;
}

/** What each expression a name is written as resolves to, where no cycle shaped it. */
const RESOLVED_SOURCES = new WeakMap<Expression, readonly string[]>();

/** Resolves `Identifier` `id` (through `const`/`let`/`var` initializers, assignments, destructuring). */
function identifierIntrinsicPaths(
  id: Identifier,
  visiting: ReadonlySet<FrameBinding>,
): readonly string[] {
  if (GLOBAL_HOLDERS.has(id.text) && globalPathOf(id)?.length === 1) return [GLOBAL_THIS];
  const direct = globalPathOf(id)?.join('.');
  if (direct !== undefined) return [direct];
  const selected = frameBindingOf(id);
  if (selected === undefined || isVisiting(visiting, selected.binding)) return [];
  const nextVisiting = new Set([...visiting, selected.binding]);
  const initial = selected.binding.initializer === undefined ? [] : [selected.binding.initializer];
  const candidates = [...initial, ...assignedSourcesOf(selected.binding)];
  const resolved = candidates.flatMap((src) => {
    const written = whereUnstopped(RESOLVED_SOURCES, src, () =>
      intrinsicPathsOf(src, nextVisiting),
    );
    return projectIntrinsicKeys(written, selected.keys);
  });
  return [...new Set(resolved)];
}

/** Resolves member access intrinsic dot-paths (`globalThis.String`, `re.constructor`, `x.__proto__`). */
function memberIntrinsicPaths(
  value: PropertyAccessExpression | ElementAccessExpression,
  visiting: ReadonlySet<FrameBinding>,
): readonly string[] {
  const direct = globalPathOf(value)?.join('.');
  if (direct !== undefined) return [direct];
  const key = memberOrSymbolKey(value);
  const basePaths = intrinsicPathsOf(value.expression, visiting);
  return basePaths.length === 0 ? unknownReceiverPaths(key) : projectIntrinsicKey(basePaths, key);
}

/** Deduplicates two intrinsic path lists without intermediate spread arrays. */
function mergePaths(left: readonly string[], right: readonly string[]): readonly string[] {
  const merged = new Set(left);
  for (const each of right) merged.add(each);
  return [...merged];
}

/** Resolves all global intrinsic or instance markers `expr` may evaluate to. */
export function intrinsicPathsOf(
  expr: Expression,
  visiting: ReadonlySet<FrameBinding>,
): readonly string[] {
  const value = unwrapped(expr);
  const literal = literalInstancePaths(value);
  if (literal !== undefined) return literal;
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
  if (isCallExpression(value) || isNewExpression(value)) {
    return callIntrinsicPaths(value, visiting);
  }
  if (isTaggedTemplateExpression(value)) {
    return intrinsicPathsOf(value.tag, visiting).includes('String.raw') ? [INSTANCE_STRING] : [];
  }
  if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    return memberIntrinsicPaths(value, visiting);
  }
  return [];
}

/** Whether `path` names `RegExp`, `String`, their `.prototype`, or any member on them. */
export function isMatchIntrinsicPath(path: string): boolean {
  return (
    MATCH_CONSTRUCTORS.has(path) ||
    MATCH_PROTOTYPES.has(path) ||
    path.startsWith('RegExp.') ||
    path.startsWith('String.')
  );
}

/** Whether `expr` (or any member chain base of `expr`) resolves to a match intrinsic. */
export function isMatchIntrinsic(expr: Expression): boolean {
  let current = unwrapped(expr);
  for (;;) {
    if (intrinsicPathsOf(current, new Set()).some((path) => isMatchIntrinsicPath(path))) {
      return true;
    }
    if (!isPropertyAccessExpression(current) && !isElementAccessExpression(current)) return false;
    current = unwrapped(current.expression);
  }
}
