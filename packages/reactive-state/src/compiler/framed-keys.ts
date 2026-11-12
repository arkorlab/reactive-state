import {
  type ArrayLiteralExpression,
  type BindingElement,
  type CallExpression,
  type Expression,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBindingElement,
  isComputedPropertyName,
  isConditionalExpression,
  isElementAccessExpression,
  isExpression,
  isForInStatement,
  isForOfStatement,
  type Identifier,
  isIdentifier,
  isLiteralTypeNode,
  isObjectBindingPattern,
  isParameterDeclaration,
  isParenthesizedTypeNode,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isSpreadElement,
  isUnionTypeNode,
  isVariableDeclaration,
  isVariableDeclarationList,
  type NewExpression,
  type Node,
  SyntaxKind,
  type TypeNode,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { ownerKeyFirst } from './class-key-order.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { executionOwner, exportedDeclaration } from './framed-array-mutations.ts';
import {
  type FrameBinding,
  frameBindingContainer,
  frameBindingOf,
  frameMemberName,
  type FrameSelection,
} from './framed-bindings.ts';
import { framedCondition } from './framed-sources.ts';
import {
  APPLICATION_WORK,
  callWorkExposure,
  extendsWork,
  namedElsewhere,
  tupleBindingExposure,
} from './framed-tuple-work.ts';
import { framedAssignedValues, framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';
import { constantValue } from './numbers.ts';

/** Finite written property keys, and a binding's receiver before its final computed key. */

const TARGET_WRITES: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** Work before the call that exposes a tuple wherever it stands: a call, a construction, a read. */
const PRIOR_WORK: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.CallExpression,
  SyntaxKind.Decorator,
  SyntaxKind.ElementAccessExpression,
  SyntaxKind.NewExpression,
  SyntaxKind.PropertyAccessExpression,
  SyntaxKind.TaggedTemplateExpression,
  SyntaxKind.TemplateExpression,
]);

/** The possible written keys of a member; none known means a computed key remains arbitrary. */
export function framedMemberNames(node: Node): readonly string[] | undefined {
  const name = frameMemberName(node);
  if (name !== undefined) return [name];
  const key = isElementAccessExpression(node) ? node.argumentExpression : computedBindingKey(node);
  return key === undefined ? undefined : framedKeyNames(key);
}

interface ArgumentWork {
  readonly node: Expression;
  readonly seen: ReadonlySet<FrameBinding>;
}

interface ArgumentPrefix {
  readonly values: readonly Expression[];
  readonly unknown: boolean;
  readonly alternatives?: readonly Expression[];
}

interface ArgumentArray {
  readonly array: ArrayLiteralExpression;
  readonly seen: ReadonlySet<FrameBinding>;
  readonly exposed: boolean;
}

/** The first target and key of a native call, never shifting arguments past an unresolved spread. */
export function framedArgumentPrefix(
  call: CallExpression | NewExpression,
  given: readonly Expression[] = call.arguments ?? [],
  limit = 2,
): ArgumentPrefix {
  const values: Expression[] = [];
  const pending: ArgumentWork[] = [];
  for (const node of given) pending.unshift({ node, seen: new Set() });
  for (
    let each = pending.pop();
    each !== undefined && values.length < limit;
    each = pending.pop()
  ) {
    if (!isSpreadElement(each.node)) {
      values.push(each.node);
      continue;
    }
    const selected = argumentArray(each.node.expression, each.seen, call);
    if (selected === undefined) return { values, unknown: true };
    if (selected.exposed) return exposedArgumentPrefix(values, selected, call, each.node);
    for (const node of selected.array.elements.toReversed())
      pending.push({ node, seen: selected.seen });
  }
  return { values, unknown: false };
}

/** An unchanged apply tuple retains its runtime entries through the existing argument-array proof. */
export function framedAppliedArguments(
  call: CallExpression,
  expression: Expression,
): readonly Expression[] | undefined {
  const selected = argumentArray(expression, new Set(), call);
  return selected === undefined || selected.exposed ? undefined : selected.array.elements;
}

/** An exposed array retains its original and written replacement targets, but proves no key. */
function exposedArgumentPrefix(
  values: Expression[],
  selected: ArgumentArray,
  call: CallExpression | NewExpression,
  spread: Node,
): ArgumentPrefix {
  const alternatives = values.length === 0 ? tupleTargetWrites(selected.seen, call, spread) : [];
  const first = selected.array.elements[0];
  if (first !== undefined && values.length === 0 && !isSpreadElement(first)) values.push(first);
  return { values, unknown: true, alternatives };
}

/**
 * A tuple's written first-entry replacements remain possible receivers after its proof is lost:
 * those written before the `spread` that reads it, in the call's own work too, and those a later
 * pass or another owner may run first.
 */
function tupleTargetWrites(
  aliases: ReadonlySet<FrameBinding>,
  call: CallExpression | NewExpression,
  spread: Node,
): readonly Expression[] {
  const values: Expression[] = [];
  const owner = executionOwner(call);
  const pending: Node[] = [call.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isBinaryExpression(node) &&
      TARGET_WRITES.has(node.operatorToken.kind) &&
      (node.end <= spread.pos || tupleWriteBefore(node, call, aliases, owner)) &&
      framedPossibleBranch(node) &&
      firstTupleEntry(node.left, aliases)
    )
      values.push(node.right);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return values;
}

/**
 * Later writes in a repeated body can supply the tuple at its next native call, and so can those in
 * what a pattern around the call destructures and in a computed key of a class around it, which run
 * before it though they are written after.
 */
function tupleWriteBefore(
  node: Node,
  call: CallExpression | NewExpression,
  aliases: ReadonlySet<FrameBinding>,
  owner: Node,
): boolean {
  if (
    executionOwner(node) !== owner ||
    node.pos < call.pos ||
    destructuredFirst(node, call) ||
    ownerKeyFirst(node, call)
  )
    return true;
  for (const binding of aliases) if (repeatedFrameRead(node, call, binding, owner)) return true;
  return false;
}

/** Only slot zero of the same lexical tuple or resolved constant alias supplies its receiver. */
function firstTupleEntry(target: Expression, aliases: ReadonlySet<FrameBinding>): boolean {
  const value = unwrapped(target);
  if (!isElementAccessExpression(value)) return false;
  const index = constantValue(value.argumentExpression);
  if (index !== 0 && index !== '0') return false;
  const holder = unwrapped(value.expression);
  const selected = isIdentifier(holder) ? frameBindingOf(holder) : undefined;
  return selected?.keys.length === 0 && aliases.has(selected.binding);
}

/** Literal arrays and whole constant aliases, with mutable contents left unproven after exposure. */
function argumentArray(
  expression: Expression,
  previous: ReadonlySet<FrameBinding>,
  call: CallExpression | NewExpression,
): ArgumentArray | undefined {
  let value = unwrapped(expression);
  const seen = new Set(previous);
  let exposed = false;
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0 || seen.has(selected.binding))
      return undefined;
    const { binding } = selected;
    seen.add(binding);
    const values = constantKeys(binding);
    if (values?.length !== 1 || binding.initializer === undefined) return undefined;
    exposed ||= arrayExposed(binding, call, seen, expression);
    value = unwrapped(binding.initializer);
  }
  return isArrayLiteralExpression(value) ? { array: value, seen, exposed } : undefined;
}

/**
 * Prior reads or application work can change a captured array before the native call reads it — the
 * work of a pattern's source and of a computed key of a class around the call, which run before it
 * though they are written after — and so can the call's own work before it reads `read`
 * (`callWorkExposure`).
 */
function arrayExposed(
  binding: FrameBinding,
  call: CallExpression | NewExpression,
  aliases: ReadonlySet<FrameBinding>,
  read: Expression,
): boolean {
  let reachable: boolean | undefined;
  const reached = (): boolean => {
    reachable ??= namedElsewhere(binding, call);
    return reachable;
  };
  const pending: Node[] = [call.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const repeated =
      node.pos >= call.end &&
      executionOwner(node) === executionOwner(call) &&
      (destructuredFirst(node, call) ||
        ownerKeyFirst(node, call) ||
        repeatedFrameRead(node, call, binding, executionOwner(call))) &&
      framedPossibleBranch(node);
    if (!repeated && node.pos >= call.pos) continue;
    if (
      node.pos >= binding.end &&
      (repeated || node.end <= call.pos) &&
      arrayExposure(node, binding, aliases, reached)
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return (
    callWorkExposure(binding, call, aliases, read) || deferredTupleExposure(binding, call, aliases)
  );
}

/**
 * A deferred read also sees later uses that can replace a captured tuple's entries, and what an
 * importing module does to a tuple this one exports before it calls a function that reads it.
 */
function deferredTupleExposure(
  binding: FrameBinding,
  call: CallExpression | NewExpression,
  aliases: ReadonlySet<FrameBinding>,
): boolean {
  if (executionOwner(call) === executionOwner(binding)) return false;
  if (exportedDeclaration(binding)) return true;
  const pending: Node[] = [binding.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node === call) continue;
    if (tupleBindingExposure(node, binding, aliases)) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/**
 * A prior effect or a use outside known constant aliases loses the mutable tuple proof: a call —
 * written, a template's tag or conversion, a decorator — a construction or a member read wherever it
 * stands, and other work that runs the application's code where that code `reached` the tuple.
 */
function arrayExposure(
  node: Node,
  binding: FrameBinding,
  aliases: ReadonlySet<FrameBinding>,
  reached: () => boolean,
): boolean {
  if (
    PRIOR_WORK.has(node.kind) ||
    ((APPLICATION_WORK.has(node.kind) || extendsWork(node)) && reached())
  )
    return true;
  return tupleBindingExposure(node, binding, aliases);
}

/** A computed object's key expression, without giving its target binding's name to the key. */
function computedBindingKey(node: Node): Expression | undefined {
  return isBindingElement(node) &&
    node.propertyName !== undefined &&
    isComputedPropertyName(node.propertyName)
    ? node.propertyName.expression
    : undefined;
}

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
  const binding = isIdentifier(value) ? frameBindingOf(value) : undefined;
  if (binding === undefined || binding.keys.length > 0) return undefined;
  const names = declaredKeys(binding.binding);
  const values = constantKeys(binding.binding);
  if (values !== undefined) return { values, fallback: names };
  if (names === undefined) return undefined;
  const sources = binding.binding.initializer === undefined ? [] : [binding.binding.initializer];
  if (isIdentifier(value)) sources.push(...framedAssignedValues(value));
  const declared =
    isParameterDeclaration(binding.binding) ||
    (isIdentifier(value) && changedBeyondSources(value, binding.binding));
  return sources.length === 0
    ? { names }
    : { values: sources, fallback: names, callerNames: declared ? names : [] };
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
function constantKeys(binding: FrameBinding): readonly Expression[] | undefined {
  if (!isVariableDeclaration(binding) || !isVariableDeclarationList(binding.parent))
    return undefined;
  if (!/^const\s/u.test(binding.parent.getText(binding.getSourceFile()))) return undefined;
  if (binding.initializer !== undefined) return [binding.initializer];
  const loop = binding.parent.parent;
  if (!isForOfStatement(loop)) return undefined;
  const entries = unwrapped(loop.expression);
  return isArrayLiteralExpression(entries) ? entries.elements : undefined;
}

/** The receiver's known ancestor keys remain readable when only the final binding key is unknown. */
export function computedBindingContainer(element: BindingElement): FrameSelection | undefined {
  const selected = frameBindingContainer(element);
  if (selected !== undefined) return selected;
  if (!isObjectBindingPattern(element.parent) || element.dotDotDotToken !== undefined)
    return undefined;
  const keys: string[] = [];
  let owner = element.parent.parent;
  while (isBindingElement(owner)) {
    if (owner.dotDotDotToken !== undefined) return undefined;
    const pattern = owner.parent;
    const key = isArrayBindingPattern(pattern)
      ? String(pattern.elements.indexOf(owner))
      : frameMemberName(owner);
    if (key === undefined) return undefined;
    keys.unshift(key);
    owner = pattern.parent;
  }
  return isParameterDeclaration(owner) || isVariableDeclaration(owner)
    ? { binding: owner, keys }
    : undefined;
}
