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
  isElementAccessExpression,
  isIdentifier,
  isObjectBindingPattern,
  isOmittedExpression,
  isParameterDeclaration,
  isSourceFile,
  isSpreadElement,
  isVariableDeclaration,
  type NewExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { ownerKeyFirst } from './class-key-order.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { executionOwner, exportedDeclaration, repeatsAround } from './framed-array-mutations.ts';
import {
  type FrameBinding,
  frameBindingContainer,
  frameBindingOf,
  frameMemberName,
  type FrameSelection,
} from './framed-bindings.ts';
import { constantKeys, framedKeyNames, TARGET_WRITES } from './framed-key-names.ts';
import { framedQuietOperand } from './framed-quiet-operands.ts';
import { framedQuietCallee, framedQuietValue } from './framed-quiet-values.ts';
import {
  APPLICATION_WORK,
  callWorkExposure,
  extendsWork,
  namedElsewhere,
  tupleBindingExposure,
} from './framed-tuple-work.ts';
import { framedPossibleBranch, repeatedBodyRead, repeatedFrameRead } from './framed-writes.ts';
import { type Constant, constantValue } from './numbers.ts';

export { framedKeyNames } from './framed-key-names.ts';

/** Finite written property keys, and a binding's receiver before its final computed key. */

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
  /**
   * What is written past the place the prefix ends at, where that is a spread the compile cannot
   * read or one of an array other code may have changed (`writtenPast`): its value is known, its
   * position is not. None where nothing is written there.
   */
  readonly past?: readonly Expression[];
}

interface ArgumentArray {
  readonly array: ArrayLiteralExpression;
  readonly seen: ReadonlySet<FrameBinding>;
  readonly exposed: boolean;
}

/**
 * The first target and key of a native call, never shifting arguments past an unresolved spread.
 * Any use that may run before the call exposes a spread array — one written before it, one in what a
 * destructuring pattern around the call destructures, or one in a loop's condition or update on the
 * next pass — and an exposed prefix keeps its original and written targets. A spread past code the
 * call itself may run first ends the prefix (`readInOrder`), since that code may change the array in
 * any way, and keeps what the positions from it may hold as alternatives
 * (`reorderedArgumentPrefix`). A prefix that ends at a spread the compile cannot read, or at an
 * exposed one, keeps what is written past it (`past`): `Object.assign(box, ...sources, { inner })`
 * still writes `inner`, whatever `sources` holds. A reader whose proof an exposure drops passes
 * `reached` false, to count only uses that run before it as written or in a body that repeats it.
 */
export function framedArgumentPrefix(
  call: CallExpression | NewExpression,
  given: readonly Expression[] = call.arguments ?? [],
  limit = 2,
  reached = true,
): ArgumentPrefix {
  return argumentPrefix(call, given, limit, { reached, ordered: true });
}

interface PrefixContext {
  readonly reached: boolean;
  readonly ordered: boolean;
}

/**
 * The prefix of `framedArgumentPrefix`. One not `ordered` leaves what the call evaluates before a
 * spread to its caller, which has found that quiet.
 */
function argumentPrefix(
  call: CallExpression | NewExpression,
  given: readonly Expression[],
  limit: number,
  context: PrefixContext,
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
    const { expression } = each.node;
    const selected = argumentArray(expression, each.seen, call, context.reached);
    if (selected === undefined)
      return endedPrefix({ values, unknown: true }, writtenPast(call, pending, context.reached));
    if (context.ordered && !readInOrder(call, each.node, expression, context.reached)) {
      const rest = [...selected.array.elements, ...pending.toReversed().map((work) => work.node)];
      return reorderedArgumentPrefix(values, rest, call, {
        reached: context.reached,
        aliases: selected.seen,
        spread: each.node,
      });
    }
    if (selected.exposed) {
      const ended = { call, spread: each.node, pending, reached: context.reached };
      return exposedArgumentPrefix(values, selected, ended);
    }
    for (const node of selected.array.elements.toReversed())
      pending.push({ node, seen: selected.seen });
  }
  return { values, unknown: false };
}

/**
 * What is written past the place a prefix ends at: each argument still `pending` there, and what
 * the array of a later spread was written with — the rest of an exposed array first — and, of an
 * exposed one, what was written into any of its entries (`tupleTargetWrites`). A spread among them
 * that the compile cannot read supplies nothing it can name, and a hole writes nothing. What a
 * spread before them holds comes first, so none of them stands at a known position: an array that
 * several spreads reach adds what it was written with once.
 */
function writtenPast(
  call: CallExpression | NewExpression,
  pending: ArgumentWork[],
  reached: boolean,
): readonly Expression[] {
  const past: Expression[] = [];
  const expanded = new Set<ArrayLiteralExpression>();
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    if (isOmittedExpression(each.node)) continue;
    if (!isSpreadElement(each.node)) {
      past.push(each.node);
      continue;
    }
    const selected = argumentArray(each.node.expression, each.seen, call, reached);
    if (selected === undefined || expanded.has(selected.array)) continue;
    expanded.add(selected.array);
    const written = selected.array.elements.toReversed();
    for (const node of written) pending.push({ node, seen: selected.seen });
    if (selected.exposed) past.push(...tupleTargetWrites(selected.seen, call, each.node, 'any'));
  }
  return past;
}

/** A prefix that ends early, with what is written past its end where anything is. */
function endedPrefix(prefix: ArgumentPrefix, past: readonly Expression[]): ArgumentPrefix {
  return past.length === 0 ? prefix : { ...prefix, past };
}

/**
 * What the positions past a prefix's end may hold, as far as the source writes it: its alternatives,
 * and what is written past a spread it ends at (`past`). A reader for which a position decides the
 * meaning — a key, an index, a descriptor — takes each as possible there.
 */
export function framedPossibleArguments(prefix: ArgumentPrefix): readonly Expression[] {
  return [...(prefix.alternatives ?? []), ...(prefix.past ?? [])];
}

interface ReorderedContext {
  readonly reached: boolean;
  readonly aliases: ReadonlySet<FrameBinding>;
  /** The spread, or the apply tuple, that the prefix ends at. */
  readonly spread: Node;
}

/**
 * A prefix that ends at a spread past code the call may run first, which may have changed the
 * spread's array in any way: no position from it is known, but what the array was written with,
 * each later argument and the array's written replacements stay possible there, as alternatives —
 * `Object.getOwnPropertyNames.call(ignore(), ...args)` may still read what `args` was written with.
 */
function reorderedArgumentPrefix(
  values: readonly Expression[],
  rest: readonly Expression[],
  call: CallExpression | NewExpression,
  context: ReorderedContext,
): ArgumentPrefix {
  const later = argumentPrefix(call, rest, Infinity, { reached: context.reached, ordered: false });
  const alternatives = [
    ...later.values,
    ...framedPossibleArguments(later),
    ...tupleTargetWrites(context.aliases, call, context.spread),
  ];
  return { values, unknown: true, alternatives };
}

/**
 * An unchanged apply tuple retains its runtime entries through the existing argument-array proof,
 * where nothing the call evaluates before it may change it (`readInOrder`). A reader whose proof an
 * exposure drops passes `reached` false, as for `framedArgumentPrefix`.
 */
export function framedAppliedArguments(
  call: CallExpression,
  expression: Expression,
  reached = true,
): readonly Expression[] | undefined {
  const selected = argumentArray(expression, new Set(), call, reached);
  if (selected === undefined || selected.exposed) return undefined;
  return readInOrder(call, expression, expression, reached) ? selected.array.elements : undefined;
}

/**
 * An apply tuple's entries as a prefix of `limit` values: those of `framedAppliedArguments`; past
 * code the call may run first, none in a known position, with what the tuple was written with as
 * alternatives, as `framedArgumentPrefix` keeps them; and none of a tuple the compile cannot read.
 */
export function framedAppliedPrefix(
  call: CallExpression,
  expression: Expression,
  limit = 2,
  reached = true,
): ArgumentPrefix {
  const selected = argumentArray(expression, new Set(), call, reached);
  if (selected === undefined || selected.exposed) return { values: [], unknown: true };
  const { elements } = selected.array;
  if (readInOrder(call, expression, expression, reached))
    return framedArgumentPrefix(call, elements, limit, reached);
  return reorderedArgumentPrefix([], elements, call, {
    reached,
    aliases: selected.seen,
    spread: expression,
  });
}

/** What holds a spread or an apply tuple, read past up to the call that holds it. */
const READ_PAST: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AsExpression,
  SyntaxKind.NonNullExpression,
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.SatisfiesExpression,
  SyntaxKind.SpreadElement,
]);

/**
 * Whether an array a call reads at `node` — a spread of `expression`, or an apply tuple — holds
 * what it was written with, as far as the call's own work goes. A literal written in place does,
 * whatever ran before it. A constant's array does where nothing the call evaluates before the node
 * may run code, which might change it: `f((args.push(error), 0), ...args)` spreads one more than
 * `args` was written with. That is the call's callee (`framedQuietCallee`), each argument before
 * the node's, and each element before it of a literal written in place around it
 * (`quietArgument`). A node outside the call, in a constant's array, has none of the call's work
 * before it.
 */
function readInOrder(
  call: CallExpression | NewExpression,
  node: Expression,
  expression: Expression,
  reached: boolean,
): boolean {
  if (isArrayLiteralExpression(unwrapped(expression))) return true;
  if (node.pos < call.pos || node.end > call.end) return true;
  let child: Node = node;
  for (let parent = node.parent; parent !== call; child = parent, parent = parent.parent) {
    if (isSourceFile(parent)) return true;
    if (isArrayLiteralExpression(parent)) {
      if (!quietUntil(call, parent.elements, child, reached)) return false;
    } else if (!READ_PAST.has(parent.kind)) {
      return false;
    }
  }
  return (
    framedQuietCallee(call.expression) && quietUntil(call, call.arguments ?? [], child, reached)
  );
}

/** Whether each item of a list before the one that holds a node runs no code (`quietArgument`). */
function quietUntil(
  call: CallExpression | NewExpression,
  items: readonly Expression[],
  child: Node,
  reached: boolean,
): boolean {
  for (const each of items) {
    if (each === child) return true;
    if (!quietArgument(call, each, reached)) return false;
  }
  return true;
}

/**
 * Whether evaluating an argument, or an element of a literal written in place, runs no code: a
 * hole, a quiet value (`framedQuietValue`), or a spread of a literal written in place of such
 * items, or of a constant's array the compile expands whole.
 */
function quietArgument(
  call: CallExpression | NewExpression,
  node: Expression,
  reached: boolean,
): boolean {
  if (isOmittedExpression(node)) return true;
  if (!isSpreadElement(node)) return framedQuietValue(node);
  const array = unwrapped(node.expression);
  if (isArrayLiteralExpression(array))
    return array.elements.every((each) => quietArgument(call, each, reached));
  return !argumentPrefix(call, [node], Infinity, { reached, ordered: false }).unknown;
}

interface ExposedContext {
  readonly call: CallExpression | NewExpression;
  /** The spread the prefix ends at. */
  readonly spread: Node;
  /** The arguments past that spread, which the prefix did not reach. */
  readonly pending: ArgumentWork[];
  readonly reached: boolean;
}

/**
 * An exposed array retains its original and written replacement targets, but proves no key. What
 * it was written with beside that target, and each argument past it, stays possible in no known
 * position (`writtenPast`).
 */
function exposedArgumentPrefix(
  values: Expression[],
  selected: ArgumentArray,
  context: ExposedContext,
): ArgumentPrefix {
  const { call, pending } = context;
  const alternatives =
    values.length === 0 ? tupleTargetWrites(selected.seen, call, context.spread) : [];
  const [first, ...others] = selected.array.elements;
  let unplaced: readonly Expression[] = selected.array.elements;
  if (first !== undefined && values.length === 0 && !isSpreadElement(first)) {
    values.push(first);
    unplaced = others;
  }
  for (const node of unplaced.toReversed()) pending.push({ node, seen: selected.seen });
  const written = tupleTargetWrites(selected.seen, call, context.spread, 'any');
  const named = new Set(alternatives);
  const later = written.filter((node) => !named.has(node));
  const past = [...later, ...writtenPast(call, pending, context.reached)];
  return endedPrefix({ values, unknown: true, alternatives }, past);
}

/**
 * A tuple's written first-entry replacements remain possible receivers after its proof is lost:
 * those written before the `spread` that reads it, in the call's own work too, and those a later
 * pass or another owner may run first. Where an `'any'` entry is asked, the replacements of each
 * entry, which stay possible values of the array among what is written past the prefix.
 */
function tupleTargetWrites(
  aliases: ReadonlySet<FrameBinding>,
  call: CallExpression | NewExpression,
  spread: Node,
  entries: 'any' | 'first' = 'first',
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
      tupleEntry(node.left, aliases, entries)
    )
      values.push(node.right);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return values;
}

/**
 * Later writes in a repeated body — a loop's, or a function's that can be called again with a tuple
 * declared outside it — can supply the tuple at its next native call, and so can those in
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
  for (const binding of aliases)
    if (repeatedFrameRead(node, call, binding, owner) || repeatsAround(owner, binding)) return true;
  return false;
}

/** The last canonical index of an array: a larger number, or any other name, is no entry's. */
const ARRAY_INDEX = { last: 4_294_967_294 } as const;

/**
 * Whether a written index may name an entry of an array: one the compile cannot tell, or a canonical
 * one.
 */
function entryIndex(index: Constant | undefined): boolean {
  if (index === undefined) return true;
  const text = String(index);
  return /^(?:0|[1-9]\d*)$/u.test(text) && Number(text) <= ARRAY_INDEX.last;
}

/**
 * Only slot zero of the same lexical tuple or resolved constant alias supplies its receiver; any
 * entry of it, whatever index names it, may supply a value of it, and no property it is given under
 * another name (`sources['meta']`), which a spread of the array never yields.
 */
function tupleEntry(
  target: Expression,
  aliases: ReadonlySet<FrameBinding>,
  entries: 'any' | 'first',
): boolean {
  const value = unwrapped(target);
  if (!isElementAccessExpression(value)) return false;
  const index = constantValue(value.argumentExpression);
  if (entries === 'first' ? index !== 0 && index !== '0' : !entryIndex(index)) return false;
  const holder = unwrapped(value.expression);
  const selected = isIdentifier(holder) ? frameBindingOf(holder) : undefined;
  return selected?.keys.length === 0 && aliases.has(selected.binding);
}

/**
 * Literal arrays and whole constant aliases, past quiet commas (`framedQuietOperand`), with mutable
 * contents left unproven after exposure. Where `reached`, for a reader that keeps every target of
 * an exposed array, every use written before the call counts, one in what a pattern around the call
 * destructures, and one in a loop's condition or update on the next pass. Otherwise, for a reader
 * whose proof an exposure drops, only uses that run before the call as written count — not one in a
 * pattern whose source holds the call — and uses in a loop body that repeats it.
 */ function argumentArray(
  expression: Expression,
  previous: ReadonlySet<FrameBinding>,
  call: CallExpression | NewExpression,
  reached: boolean,
): ArgumentArray | undefined {
  let value = framedQuietOperand(expression);
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
    exposed ||= arrayExposed(binding, call, seen, { reached, read: expression });
    value = framedQuietOperand(binding.initializer);
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
  context: { readonly reached: boolean; readonly read: Expression },
): boolean {
  const { reached, read } = context;
  const later = reached ? repeatedFrameRead : repeatedBodyRead;
  let named: boolean | undefined;
  const namedAround = (): boolean => {
    named ??= namedElsewhere(binding, call);
    return named;
  };
  const pending: Node[] = [call.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const repeated =
      node.pos >= call.end &&
      executionOwner(node) === executionOwner(call) &&
      ((reached && (destructuredFirst(node, call) || ownerKeyFirst(node, call))) ||
        later(node, call, binding, executionOwner(call))) &&
      framedPossibleBranch(node);
    if (!repeated && node.pos >= call.pos) continue;
    if (
      node.pos >= binding.end &&
      (repeated || (node.end <= call.pos && (reached || !destructuredFirst(call, node)))) &&
      arrayExposure(node, binding, aliases, namedAround)
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
