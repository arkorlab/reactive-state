import {
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isConditionalExpression,
  isExpression,
  isForInStatement,
  isForOfStatement,
  type Identifier,
  isIdentifier,
  isLiteralTypeNode,
  isParameterDeclaration,
  isParenthesizedTypeNode,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isUnionTypeNode,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  SyntaxKind,
  type TypeNode,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { type FrameBinding, frameBindingOf, frameDeclarationOf } from './framed-bindings.ts';
import { framedCondition } from './framed-sources.ts';
import { framedAssignedValues } from './framed-writes.ts';
import { constantValue } from './numbers.ts';
import { bindingIdentifiers } from './scope.ts';

/** The assignment operators that write a target whole: the others read it first, or only test it. */
export const TARGET_WRITES: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

interface KeyWork {
  readonly node: Expression;
  readonly seen: ReadonlySet<Node>;
  readonly fallback: readonly string[] | undefined;
}

/**
 * Written conditional alternatives, constants and literal key annotations keep their finite names.
 * A value is followed once under each declared bound, whichever way it is reached, so that aliases
 * that converge cost no more than a chain.
 */
export function framedKeyNames(key: Expression): readonly string[] | undefined {
  const names = new Set<string>();
  const followed = new Map<Node, Set<string>>();
  const pending: KeyWork[] = [{ node: key, seen: new Set(), fallback: undefined }];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    const step = keyStep(each, followed);
    if (step === undefined) return undefined;
    for (const name of step.names) names.add(name);
    pending.push(...step.next);
  }
  return [...names];
}

/** Whether `value` was followed already under the declared names `fallback`; it is marked followed. */
function wasFollowed(
  value: Node,
  fallback: readonly string[] | undefined,
  followed: Map<Node, Set<string>>,
): boolean {
  const bound = JSON.stringify(fallback ?? null);
  const known = followed.get(value) ?? new Set<string>();
  followed.set(value, known);
  if (known.has(bound)) return true;
  known.add(bound);
  return false;
}

/** A source-proven value takes precedence over a literal annotation; opaque values keep its bound. */
function keyStep(
  each: KeyWork,
  followed: Map<Node, Set<string>>,
): { readonly names: readonly string[]; readonly next: readonly KeyWork[] } | undefined {
  const value = unwrapped(each.node);
  if (each.seen.has(value)) return undefined;
  if (wasFollowed(value, each.fallback, followed)) return { names: [], next: [] };
  const seen = new Set(each.seen).add(value);
  if (isConditionalExpression(value)) {
    const condition = framedCondition(value.condition);
    let branches = [value.whenTrue, value.whenFalse];
    if (condition !== undefined) branches = [condition ? value.whenTrue : value.whenFalse];
    return {
      names: [],
      next: branches.map((node) => ({ ...each, node, seen })),
    };
  }
  const selected = keyAlternatives(value);
  if (selected === undefined)
    return each.fallback === undefined ? undefined : { names: each.fallback, next: [] };
  if ('names' in selected) return { names: selected.names, next: [] };
  const fallback = selected.fallback ?? each.fallback;
  return {
    names: selected.callerNames ?? [],
    next: selected.values.map((node) => ({ node, seen, fallback })),
  };
}

/** One key expression's literal names or source-constant alternatives, in its own lexical scope. */
function keyAlternatives(value: Expression):
  | { readonly names: readonly string[] }
  | {
      readonly values: readonly Expression[];
      readonly fallback: readonly string[] | undefined;
      readonly callerNames?: readonly string[];
    }
  | undefined {
  const literal = constantValue(value);
  if (literal !== undefined) return { names: [String(literal)] };
  if (!isIdentifier(value)) return undefined;
  const binding = frameBindingOf(value);
  if (binding === undefined || binding.keys.length > 0) return undefined;
  const names = declaredKeys(binding.binding);
  const values = constantKeys(binding.binding);
  if (values !== undefined) return { values, fallback: names };
  if (names === undefined) return undefined;
  const again = redeclarations(value, binding.binding);
  const sources = [...initializersOf([binding.binding, ...again]), ...framedAssignedValues(value)];
  const declared =
    isParameterDeclaration(binding.binding) ||
    again.length > 0 ||
    changedBeyondSources(value, binding.binding);
  return sources.length === 0
    ? { names }
    : { values: sources, fallback: names, callerNames: declared ? names : [] };
}

/** The values that declarations of one variable write where they name it whole. */
function initializersOf(declarations: readonly FrameBinding[]): readonly Expression[] {
  const values: Expression[] = [];
  for (const declaration of declarations) {
    if (isIdentifier(declaration.name) && declaration.initializer !== undefined)
      values.push(declaration.initializer);
  }
  return values;
}

/**
 * The declarations of `binding`'s variable beyond the one a name resolves to, the first: a `var`
 * declared again in its scope — in a block, a `for` head, a `switch` case or a `catch` block, or
 * beside a parameter of its name — writes it where it stands. Its initializer is a source where it
 * names the variable whole; a pattern or a loop head writes what no initializer says, and
 * `keyAlternatives` keeps the names the declared type allows wherever there is one.
 */
function redeclarations(name: Identifier, binding: FrameBinding): readonly VariableDeclaration[] {
  const found: VariableDeclaration[] = [];
  const pending: Node[] = [name.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      node !== binding &&
      isVariableDeclaration(node) &&
      bindingIdentifiers(node.name).some(
        (bound) => bound.text === name.text && frameDeclarationOf(bound) === binding,
      )
    )
      found.push(node);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return found;
}

/**
 * Whether the code changes `binding` where no expression writes the value it takes: a compound
 * assignment, an update or a `for…in` binding. What it is assigned (`framedAssignedValues`) is
 * then not all it may be: the names its declared type allows are possible too, beside what is
 * assigned.
 */
function changedBeyondSources(name: Identifier, binding: FrameBinding): boolean {
  const pending: Node[] = [name.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const target = changedTarget(node);
    const selected =
      target !== undefined && isIdentifier(target) ? frameBindingOf(target) : undefined;
    if (selected?.binding === binding && selected.keys.length === 0) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** What a compound assignment, an update or a `for…in` binding changes, where it is written. */
function changedTarget(node: Node): Expression | undefined {
  if (isBinaryExpression(node)) {
    const { kind } = node.operatorToken;
    const compound =
      kind >= SyntaxKind.FirstAssignment &&
      kind <= SyntaxKind.LastAssignment &&
      !TARGET_WRITES.has(kind);
    return compound ? unwrapped(node.left) : undefined;
  }
  if (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node))
    return node.operator === SyntaxKind.PlusPlusToken ||
      node.operator === SyntaxKind.MinusMinusToken
      ? unwrapped(node.operand)
      : undefined;
  return isForInStatement(node) && isExpression(node.initializer)
    ? unwrapped(node.initializer)
    : undefined;
}

/**
 * The names a binding's declared type allows: those of its literal union, and `undefined` as well
 * for an optional parameter with no default, which holds it where the argument is left out.
 */
function declaredKeys(binding: FrameBinding): readonly string[] | undefined {
  const names = literalTypeKeys(binding.type);
  const optional =
    isParameterDeclaration(binding) &&
    binding.questionToken !== undefined &&
    binding.initializer === undefined;
  return names !== undefined && optional ? [...names, 'undefined'] : names;
}

/** A written literal key or union, without inferring arbitrary string values from their uses. */
function literalTypeKeys(type: TypeNode | undefined): readonly string[] | undefined {
  if (type === undefined) return undefined;
  const names = new Set<string>();
  const pending = [type];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    if (isParenthesizedTypeNode(each)) {
      pending.push(each.type);
    } else if (isUnionTypeNode(each)) {
      pending.push(...each.types);
    } else if (isLiteralTypeNode(each) && isExpression(each.literal)) {
      const value = constantValue(each.literal);
      if (value === undefined) return undefined;
      names.add(String(value));
    } else {
      return undefined;
    }
  }
  return [...names];
}

/** A lexical constant's initializer or the literal entries its for-of loop takes it from. */
export function constantKeys(binding: FrameBinding): readonly Expression[] | undefined {
  if (!isVariableDeclaration(binding) || !isVariableDeclarationList(binding.parent))
    return undefined;
  if (!/^const\s/u.test(binding.parent.getText(binding.getSourceFile()))) return undefined;
  if (binding.initializer !== undefined) return [binding.initializer];
  const loop = binding.parent.parent;
  if (!isForOfStatement(loop)) return undefined;
  const entries = unwrapped(loop.expression);
  return isArrayLiteralExpression(entries) ? entries.elements : undefined;
}
