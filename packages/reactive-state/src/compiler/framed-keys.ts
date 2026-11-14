import {
  type ArrayLiteralExpression,
  type BindingElement,
  type CallExpression,
  type Expression,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isComputedPropertyName,
  isConditionalExpression,
  isElementAccessExpression,
  isExpression,
  isForOfStatement,
  isIdentifier,
  isLiteralTypeNode,
  isNewExpression,
  isObjectBindingPattern,
  isParameterDeclaration,
  isParenthesizedTypeNode,
  isPropertyAccessExpression,
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
import { destructuredFirst } from './destructuring-order.ts';
import { executionOwner } from './framed-array-mutations.ts';
import {
  type FrameBinding,
  frameBindingContainer,
  frameBindingOf,
  frameMemberName,
  type FrameSelection,
} from './framed-bindings.ts';
import { namesInType } from './framed-references.ts';
import { framedCondition } from './framed-sources.ts';
import { framedAssignedValues, framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';
import { constantValue } from './numbers.ts';
import { readsBinding } from './scope.ts';

/** Finite written property keys, and a binding's receiver before its final computed key. */

const TARGET_WRITES: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
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
    if (selected.exposed) return exposedArgumentPrefix(values, selected, call);
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
): ArgumentPrefix {
  const alternatives = values.length === 0 ? tupleTargetWrites(selected.seen, call) : [];
  const first = selected.array.elements[0];
  if (first !== undefined && values.length === 0 && !isSpreadElement(first)) values.push(first);
  return { values, unknown: true, alternatives };
}

/** A tuple's written first-entry replacements remain possible receivers after its proof is lost. */
function tupleTargetWrites(
  aliases: ReadonlySet<FrameBinding>,
  call: CallExpression | NewExpression,
): readonly Expression[] {
  const values: Expression[] = [];
  const owner = executionOwner(call);
  const pending: Node[] = [call.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isBinaryExpression(node) &&
      TARGET_WRITES.has(node.operatorToken.kind) &&
      tupleWriteBefore(node, call, aliases, owner) &&
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

/** Later writes in a repeated body can supply the tuple at its next native call. */
function tupleWriteBefore(
  node: Node,
  call: CallExpression | NewExpression,
  aliases: ReadonlySet<FrameBinding>,
  owner: Node,
): boolean {
  if (executionOwner(node) !== owner || node.pos < call.pos) return true;
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
    exposed ||= arrayExposed(binding, call, seen);
    value = unwrapped(binding.initializer);
  }
  return isArrayLiteralExpression(value) ? { array: value, seen, exposed } : undefined;
}

/** Prior reads or application work can change a captured array before the native call reads it. */
function arrayExposed(
  binding: FrameBinding,
  call: CallExpression | NewExpression,
  aliases: ReadonlySet<FrameBinding>,
): boolean {
  const pending: Node[] = [call.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const repeated =
      node.pos >= call.end &&
      executionOwner(node) === executionOwner(call) &&
      (destructuredFirst(node, call) ||
        repeatedFrameRead(node, call, binding, executionOwner(call))) &&
      framedPossibleBranch(node);
    if (!repeated && node.pos >= call.pos) continue;
    if (
      node.pos >= binding.end &&
      (repeated || node.end <= call.pos) &&
      arrayExposure(node, binding, aliases)
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return deferredTupleExposure(binding, call, aliases);
}

/** A deferred read also sees later uses that can replace a captured tuple's entries. */
function deferredTupleExposure(
  binding: FrameBinding,
  call: CallExpression | NewExpression,
  aliases: ReadonlySet<FrameBinding>,
): boolean {
  if (executionOwner(call) === executionOwner(binding)) return false;
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

/** A prior effect or a use outside known constant aliases loses the mutable tuple proof. */
function arrayExposure(
  node: Node,
  binding: FrameBinding,
  aliases: ReadonlySet<FrameBinding>,
): boolean {
  if (
    isCallExpression(node) ||
    isNewExpression(node) ||
    isPropertyAccessExpression(node) ||
    isElementAccessExpression(node)
  )
    return true;
  return tupleBindingExposure(node, binding, aliases);
}

/** Only a whole constant alias can retain a tuple without exposing its mutable entries. */
function tupleBindingExposure(
  node: Node,
  binding: FrameBinding,
  aliases: ReadonlySet<FrameBinding>,
): boolean {
  if (
    !isIdentifier(node) ||
    node === binding.name ||
    !readsBinding(node) ||
    namesInType(node) ||
    frameBindingOf(node)?.binding !== binding
  )
    return false;
  const owner = node.parent;
  return !isVariableDeclaration(owner) || owner.initializer !== node || !aliases.has(owner);
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

/** Written conditional alternatives, constants and literal key annotations keep their finite names. */
export function framedKeyNames(key: Expression): readonly string[] | undefined {
  const names = new Set<string>();
  const pending: KeyWork[] = [{ node: key, seen: new Set(), fallback: undefined }];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    const step = keyStep(each);
    if (step === undefined) return undefined;
    for (const name of step.names) names.add(name);
    pending.push(...step.next);
  }
  return [...names];
}

/** A source-proven value takes precedence over a literal annotation; opaque values keep its bound. */
function keyStep(
  each: KeyWork,
): { readonly names: readonly string[]; readonly next: readonly KeyWork[] } | undefined {
  const value = unwrapped(each.node);
  if (each.seen.has(value)) return undefined;
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
  const names = literalTypeKeys(binding.binding.type);
  const values = constantKeys(binding.binding);
  if (values !== undefined) return { values, fallback: names };
  if (names === undefined) return undefined;
  const sources = binding.binding.initializer === undefined ? [] : [binding.binding.initializer];
  if (isIdentifier(value)) sources.push(...framedAssignedValues(value));
  return sources.length === 0
    ? { names }
    : {
        values: sources,
        fallback: names,
        callerNames: isParameterDeclaration(binding.binding) ? names : [],
      };
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
