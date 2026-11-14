import {
  type BinaryExpression,
  type CallExpression,
  type Expression,
  isBinaryExpression,
  isCallExpression,
  isArrayLiteralExpression,
  isElementAccessExpression,
  isConditionalExpression,
  isDeleteExpression,
  isExpression,
  isForInStatement,
  isForOfStatement,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isOmittedExpression,
  isObjectLiteralExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  isVoidExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  isSourceFile,
  isSpreadElement,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { executionOwner } from './framed-array-mutations.ts';
import {
  type AssignedFrameSource,
  assignmentPatternDefault,
  assignmentPatternTargets,
  iteratedFrameSources,
  loopHeadDefault,
} from './framed-assignment-patterns.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { calledArrayElements } from './framed-called-elements.ts';
import { possibleFields } from './framed-entry-fields.ts';
import { UnfollowableError } from './framed-getter-writes.ts';
import { framedAppliedArguments, framedArgumentPrefix, framedKeyNames } from './framed-keys.ts';
import { namesInType } from './framed-references.ts';
import { framedCondition, framedNativeConstructor } from './framed-sources.ts';
import { checkedTuple } from './framed-tuple-escapes.ts';
import { framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';
import { readsBinding } from './scope.ts';

/** Native entry construction installs each source-written value under its converted key. */
const FROM_ENTRIES: ReadonlySet<string> = new Set(['Object.fromEntries']);

/** A source-unshadowed native call retains its entry iterable rather than arbitrary factory fields. */
export function framedEntriesCall(node: Expression): node is CallExpression {
  return isCallExpression(node) && framedNativeConstructor(node.expression, FROM_ENTRIES);
}

interface EntryWork {
  readonly value: Expression;
  readonly seen: ReadonlySet<Node>;
}

/** Ordered literal entries and stable tuple spreads retain definite overwrites and possible keys. */
export function framedEntryValues(
  node: Expression,
  key: string,
): readonly AssignedFrameSource[] | undefined {
  try {
    return entryValuesOf(node, key);
  } catch (error) {
    if (error instanceof UnfollowableError) return undefined;
    throw error;
  }
}

function entryValuesOf(node: Expression, key: string): readonly AssignedFrameSource[] | undefined {
  if (!framedEntriesCall(node)) return undefined;
  const argument = framedArgumentPrefix(node, node.arguments, 1);
  const input = argument.values[0];
  if (input === undefined || argument.unknown) return undefined;
  const entries = framedAppliedArguments(node, input);
  if (entries === undefined) return undefined;
  const pending: EntryWork[] = entries.toReversed().map((value) => ({ value, seen: new Set() }));
  let found: AssignedFrameSource[] = [];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const value = unwrapped(at.value);
    if (at.seen.has(value)) return undefined;
    const seen = new Set(at.seen).add(value);
    if (isSpreadElement(value)) {
      const spread = framedAppliedArguments(node, value.expression);
      if (spread === undefined) found.push(...spreadEntryValues(value.expression));
      else pending.push(...spread.toReversed().map((each) => ({ value: each, seen })));
      continue;
    }
    const selected = entryValue(node, value, key);
    if (selected.definite) found = selected.values;
    else found.push(...selected.values);
  }
  return found;
}

/** Each entry an opaque spread yields may supply its value slot under any key. */
function spreadEntryValues(iterable: Expression): readonly AssignedFrameSource[] {
  return iteratedFrameSources(iterable).map((entry) => ({ ...entry, keys: [...entry.keys, '1'] }));
}

interface EntrySelection {
  readonly definite: boolean;
  readonly values: AssignedFrameSource[];
}

/** An unknown entry key may replace the selected field, but cannot erase an earlier possible value. */
function entryValue(call: CallExpression, entry: Expression, key: string): EntrySelection {
  const written = argumentTupleWrites(call, entry);
  const opaque = { definite: false, values: [{ value: entry, keys: ['1'] }, ...written.values] };
  const tuple = framedAppliedArguments(call, entry) ?? packedEntryTuple(call, entry);
  if (tuple === undefined || written.exposed === true) return opaque;
  const prefix = framedArgumentPrefix(call, tuple);
  const name = prefix.values[0];
  const value = prefix.values[1];
  if (name === undefined || value === undefined || prefix.unknown) return opaque;
  const names = written.key ? undefined : framedKeyNames(name);
  if (names !== undefined && !names.includes(key)) return { definite: false, values: [] };
  return { definite: names?.length === 1, values: [{ value, keys: [] }, ...written.values] };
}

interface TupleWrites {
  readonly key: boolean;
  /** Whether code the argument list runs elsewhere may write the tuple: it is read where it is asked for. */
  readonly exposed?: boolean;
  readonly values: readonly AssignedFrameSource[];
}

/** The member of a tuple whose write may cut it short, its key slot with it. */
const LENGTH = 'length';

const VALUE_WRITES: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/**
 * The call evaluates its whole argument list before native iteration reads an entry, so a slot
 * that evaluation writes on the entry's tuple may be its key or value; an opaque slot may be either,
 * and a write to its length may cut the key off.
 */
function argumentTupleWrites(call: CallExpression, entry: Expression): TupleWrites {
  const aliases = tupleAliases(entry);
  const values: AssignedFrameSource[] = [];
  let key = false;
  const exposed = checkedTuple(call, entry, aliases, (node) => reachedWrite(node, call));
  const owner = executionOwner(call);
  const pending: Node[] = aliases.size === 0 ? [] : [call];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    node.forEachChild((child) => {
      pending.push(child);
    });
    if (executionOwner(node) !== owner) continue;
    for (const write of slotWrites(node, aliases)) {
      if (!reachedWrite(node, call)) break;
      if (write.slot === undefined || write.slot === '0' || write.slot === LENGTH) key = true;
      if (write.slot === undefined || write.slot === '1') values.push(...write.sources);
    }
    const called = calledWrites(node, call, entry);
    key ||= called.key;
    values.push(...called.values);
  }
  return {
    key,
    exposed,
    values: values.filter(
      (each, at) => values.findIndex((other) => sameSource(other, each)) === at,
    ),
  };
}

/**
 * What a call the argument list makes does to the tuple it is given: a native mutator or insertion
 * writes the slots it names, and any other call may write what is not written out, which is not
 * followed, as is a call that moves elements or hands an array whose elements it cannot tell.
 */
function calledWrites(node: Node, call: CallExpression, entry: Expression): TupleWrites {
  const none = { key: false, values: [] };
  if (node === call || !isCallExpression(node) || !reachedWrite(node, call)) return none;
  const named = calledArrayElements(node, entry, 0);
  const valued = calledArrayElements(node, entry, 1);
  const unread = [named, valued].some(
    (each) => each.moves || each.elements.some((element) => element.array === true),
  );
  if (unread) throw new UnfollowableError();
  return {
    key: named.elements.length > 0,
    values: valued.elements.map(({ value, keys }) => ({ value, keys })),
  };
}

/**
 * The slots a node writes on the tuple's bindings, with the values it hands them. A default inside
 * a pattern is no assignment of its own, whatever its left is: the enclosing pattern, or the loop
 * head that holds it, evaluates it or not, and routes its right side where it does.
 */
function slotWrites(node: Node, aliases: ReadonlySet<FrameBinding>): SlotWrite[] {
  if (assignmentPatternDefault(node) || loopHeadDefault(node)) return [];
  const slot = tupleWrite(node, aliases);
  if (slot === null) return patternWrites(node, aliases);
  if (isBinaryExpression(node) && VALUE_WRITES.has(node.operatorToken.kind))
    return [{ slot, sources: [{ value: node.right, keys: [] }] }];
  return [{ slot, sources: [] }];
}

/** A default is read as the write it is and as the value its pattern falls back to: one source. */
function sameSource(left: AssignedFrameSource, right: AssignedFrameSource): boolean {
  return (
    left.value === right.value &&
    left.keys.length === right.keys.length &&
    left.keys.every((key, at) => key === right.keys[at])
  );
}

/**
 * A write the call's evaluation may reach: no written literal condition or short-circuit skips it.
 * A condition that reads a value, a Date's time or a constant's alias, is not trusted here, as the
 * argument list may change what it reads before it is judged.
 */
function reachedWrite(node: Node, call: CallExpression): boolean {
  for (let at = node; at !== call; at = at.parent) {
    const { parent } = at;
    if (isBinaryExpression(parent) && parent.right === at && shortCircuits(parent)) return false;
    if (isConditionalExpression(parent) && at !== parent.condition) {
      const condition = literalCondition(parent.condition);
      if (condition !== undefined && at === (condition ? parent.whenFalse : parent.whenTrue))
        return false;
    }
  }
  return true;
}

/** Whether a written literal on the left keeps a logical operator from evaluating its right. */
function shortCircuits(node: BinaryExpression): boolean {
  const condition = literalCondition(node.left);
  const kind = node.operatorToken.kind;
  return (
    (kind === SyntaxKind.AmpersandAmpersandToken && condition === false) ||
    (kind === SyntaxKind.BarBarToken && condition === true)
  );
}

/** The truth of a written literal, through parentheses and negations; none of anything else. */
function literalCondition(expression: Expression): boolean | undefined {
  let value = unwrapped(expression);
  let negated = false;
  while (isPrefixUnaryExpression(value) && value.operator === SyntaxKind.ExclamationToken) {
    negated = !negated;
    value = unwrapped(value.operand);
  }
  const literal =
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    value.kind === SyntaxKind.NullKeyword ||
    isNumericLiteral(value) ||
    isStringLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value);
  const truth = literal ? framedCondition(value) : undefined;
  return truth === undefined ? undefined : truth !== negated;
}

/** The operators that step a number: an increment and a decrement, before and after. */
const STEPS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.MinusMinusToken,
  SyntaxKind.PlusPlusToken,
]);

/** The slot an assignment, a step or a deletion writes on one of the tuple's bindings, none for an opaque key. */
function tupleWrite(node: Node, aliases: ReadonlySet<FrameBinding>): string | undefined | null {
  if (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node))
    return STEPS.has(node.operator) ? memberSlot(node.operand, aliases) : null;
  if (isDeleteExpression(node)) return memberSlot(node.expression, aliases);
  if (!isBinaryExpression(node)) return null;
  const kind = node.operatorToken.kind;
  if (kind < SyntaxKind.FirstAssignment || kind > SyntaxKind.LastAssignment) return null;
  return memberSlot(node.left, aliases);
}

interface SlotWrite {
  readonly slot: string | undefined;
  readonly sources: readonly AssignedFrameSource[];
}

interface PatternTarget {
  readonly target: Expression;
  readonly sources: readonly AssignedFrameSource[];
  /** Set under a rest: the pattern reads the container's elements at offsets the compile cannot tell. */
  readonly loose?: true;
  /** Under an array rest: the position it starts at, before which the entries are consumed. */
  readonly from?: number;
}

/**
 * The slots a destructuring assignment or a loop head writes on the tuple's bindings, each with the
 * values its pattern hands it. Where the pattern readers do not route a target, a rest or a
 * computed key, it keeps its slot and may take any field or element of the sources at its level.
 */
function patternWrites(node: Node, aliases: ReadonlySet<FrameBinding>): SlotWrite[] {
  const start = patternStart(node);
  if (start === undefined) return [];
  const found: SlotWrite[] = [];
  const pending: PatternTarget[] = [start];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const target = unwrapped(at.target);
    const slot = memberSlot(target, aliases);
    if (slot !== null) found.push({ slot, sources: at.sources });
    else if (!isIdentifier(target)) pending.push(...patternTargets(target, at));
  }
  return found;
}

/** The targets a pattern goes on to: those the pattern readers route, and its others unrouted. */
function patternTargets(target: Expression, at: PatternTarget): readonly PatternTarget[] {
  const routed =
    at.loose === true
      ? []
      : assignmentPatternTargets(target, at.sources).filter(
          (each) => !underRest(each.target, target),
        );
  const covered = new Set<Node>(routed.map((each) => each.target));
  const unrouted = patternChildren(target)
    .filter((child) => !covered.has(child))
    .flatMap((child) => unroutedTargets(child, at));
  return [...routed, ...unrouted];
}

/** Whether a routed target sits in a rest of the pattern, which the unrouted targets read loosely. */
function underRest(inner: Node, pattern: Node): boolean {
  for (let at = inner; at !== pattern && !isSourceFile(at); at = at.parent)
    if (isSpreadElement(at)) return true;
  return false;
}

/** The targets a pattern or a default names directly, each as the pattern readers route it. */
function patternChildren(target: Expression): readonly Node[] {
  if (isBinaryExpression(target)) return [target.left];
  if (isArrayLiteralExpression(target))
    return target.elements.filter((each) => !isOmittedExpression(each));
  if (!isObjectLiteralExpression(target)) return [];
  return target.properties.flatMap((property): Node[] => {
    if (isPropertyAssignment(property)) return [property.initializer];
    if (isSpreadAssignment(property)) return [property];
    return isShorthandPropertyAssignment(property) && isIdentifier(property.name)
      ? [property.name]
      : [];
  });
}

/**
 * What a target the pattern readers do not route goes on to. A computed key hands it any field or
 * element of the sources, and it is routed against those, a default's right side among them; a
 * rest target takes a fresh container of its level, not what the container holds, and a pattern
 * under a rest reads the container's elements. The receiver and the index of a member that is not
 * the tuple's, and a computed key itself, are reads.
 */
function unroutedTargets(child: Node, at: PatternTarget): readonly PatternTarget[] {
  const { sources } = at;
  if (isSpreadElement(child) || isSpreadAssignment(child)) {
    const target = unwrapped(child.expression);
    const pattern = isArrayLiteralExpression(target) || isObjectLiteralExpression(target);
    const from = restStart(child, at.from);
    if (pattern) return [{ target, sources, loose: true, ...(from !== undefined && { from }) }];
    return [{ target, sources }];
  }
  if (!isExpression(child)) return [];
  const selected = at.from === undefined ? possibleFields(sources) : fieldsFrom(sources, at.from);
  const target = unwrapped(child);
  if (!isBinaryExpression(target)) return [{ target, sources: selected }];
  return [{ target: target.left, sources: [...selected, { value: target.right, keys: [] }] }];
}

/**
 * The position an array rest starts at in the source, after the entries the patterns above and
 * before it leave to the others: the rest's place in its pattern, past the position its pattern
 * itself starts at when it is under a rest. None from the start.
 */
function restStart(rest: Node, under = 0): number | undefined {
  const pattern = rest.parent;
  const place =
    isSpreadElement(rest) && isArrayLiteralExpression(pattern) ? pattern.elements.indexOf(rest) : 0;
  return under + place > 0 ? under + place : undefined;
}

/**
 * What a pattern under an array rest may take: of a written list no spread shifts before the rest,
 * the elements after the rest's position, each as a value; of any other source, and of a list a
 * spread may shift, its fields and elements. A member that is the rest takes the array whole.
 */
function fieldsFrom(
  sources: readonly AssignedFrameSource[],
  from: number,
): readonly AssignedFrameSource[] {
  return sources.flatMap((source) => {
    const value = unwrapped(source.value);
    const cut =
      source.keys.length === 0 &&
      isArrayLiteralExpression(value) &&
      value.elements.slice(0, from).every((each) => !isSpreadElement(each));
    if (!cut) return possibleFields([source]);
    return value.elements.slice(from).flatMap((each): AssignedFrameSource[] => {
      if (isOmittedExpression(each)) return [];
      return isSpreadElement(each)
        ? [...iteratedFrameSources(each.expression)]
        : [{ value: each, keys: [] }];
    });
  });
}

/** The pattern a node assigns, with the sources its right side or iterable hands it. */
function patternStart(
  node: Node,
): { readonly target: Expression; readonly sources: readonly AssignedFrameSource[] } | undefined {
  if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken)
    return { target: node.left, sources: [{ value: node.right, keys: [] }] };
  if (isForOfStatement(node) && isExpression(node.initializer) && !yieldsNothing(node.expression))
    return { target: node.initializer, sources: iteratedFrameSources(node.expression) };
  const head = isForInStatement(node) && isExpression(node.initializer);
  return head && !enumeratesNothing(node.expression)
    ? { target: node.initializer, sources: [] }
    : undefined;
}

/**
 * Whether what a `for ... in` walks is written out and has no key to give its head: null, undefined,
 * an empty string, a list of holes, an object that holds no field and spreads only such things. A
 * prototype it writes may hold enumerable keys; a hole in a list is not a key.
 */
function enumeratesNothing(walked: Expression): boolean {
  const value = unwrapped(walked);
  if (value.kind === SyntaxKind.NullKeyword || isVoidExpression(value)) return true;
  if (isIdentifier(value)) return globalPathOf(value)?.join('.') === 'undefined';
  if (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value)) return value.text === '';
  if (isArrayLiteralExpression(value))
    return value.elements.every((each) => isOmittedExpression(each));
  return (
    isObjectLiteralExpression(value) &&
    value.properties.every((each) => isSpreadAssignment(each) && enumeratesNothing(each.expression))
  );
}

/**
 * Whether an iterable is written out and yields nothing: an empty list, a spread of one, an empty
 * string. A loop over it never assigns its head; a hole in a list is an element.
 */
function yieldsNothing(iterable: Expression): boolean {
  const value = unwrapped(iterable);
  if (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value)) return value.text === '';
  return (
    isArrayLiteralExpression(value) &&
    value.elements.every((each) => isSpreadElement(each) && yieldsNothing(each.expression))
  );
}

/** The slot a written target names on one of the tuple's bindings; none for another target. */
function memberSlot(
  target: Expression,
  aliases: ReadonlySet<FrameBinding>,
): string | undefined | null {
  const member = unwrapped(target);
  if (!isElementAccessExpression(member) && !isPropertyAccessExpression(member)) return null;
  const receiver = unwrapped(member.expression);
  const selected = isIdentifier(receiver) ? frameBindingOf(receiver) : undefined;
  if (selected === undefined || selected.keys.length > 0 || !aliases.has(selected.binding))
    return null;
  return frameMemberName(member);
}

/** The bindings a written entry names, through whole aliases to its tuple. */
function tupleAliases(entry: Expression): ReadonlySet<FrameBinding> {
  const aliases = new Set<FrameBinding>();
  let value = unwrapped(entry);
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0 || aliases.has(selected.binding)) break;
    aliases.add(selected.binding);
    if (selected.binding.initializer === undefined) break;
    value = unwrapped(selected.binding.initializer);
  }
  return aliases;
}

/** A constant tuple packed into the known outer iterable retains its contents while unexposed. */
function packedEntryTuple(
  call: CallExpression,
  read: Expression,
): readonly Expression[] | undefined {
  const aliases = new Set<FrameBinding>();
  let value = unwrapped(read);
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0 || aliases.has(selected.binding))
      return undefined;
    const binding = selected.binding;
    if (
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\s/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return undefined;
    aliases.add(binding);
    value = unwrapped(binding.initializer);
  }
  if (!isArrayLiteralExpression(value)) return undefined;
  return [...aliases].some((binding) => packedEntryExposed(call, read, binding, aliases))
    ? undefined
    : value.elements;
}

/** Packing this one source reference is data; other uses, effects and possible loop revisits lose it. */
function packedEntryExposed(
  call: CallExpression,
  read: Expression,
  binding: FrameBinding,
  aliases: ReadonlySet<FrameBinding>,
): boolean {
  const owner = executionOwner(call);
  const pending: Node[] = [call.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node === call) continue;
    const local = node === call.getSourceFile() || executionOwner(node) === owner;
    const prior = node.end <= call.pos && !destructuredFirst(call, node);
    const repeated =
      local &&
      node.pos >= call.end &&
      repeatedFrameRead(node, call, binding, owner) &&
      framedPossibleBranch(node);
    if (node.pos >= binding.end && (prior || !local || repeated)) {
      if (local && packedEntryEffect(node)) return true;
      if (packedEntryReference(node, read, binding, aliases)) return true;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Earlier application work can expose entries; a later constructor or callback use is a reference. */
function packedEntryEffect(node: Node): boolean {
  return (
    isCallExpression(node) ||
    isNewExpression(node) ||
    isPropertyAccessExpression(node) ||
    isElementAccessExpression(node)
  );
}

/** Only the selected packing reference and whole constant alias declarations are transparent. */
function packedEntryReference(
  node: Node,
  read: Expression,
  binding: FrameBinding,
  aliases: ReadonlySet<FrameBinding>,
): boolean {
  if (
    node === read ||
    node === binding.name ||
    !isIdentifier(node) ||
    !readsBinding(node) ||
    namesInType(node) ||
    frameBindingOf(node)?.binding !== binding
  )
    return false;
  const parent = node.parent;
  return !isVariableDeclaration(parent) || parent.initializer !== node || !aliases.has(parent);
}
