import {
  type BinaryExpression,
  type CallExpression,
  type Expression,
  type Identifier,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isElementAccessExpression,
  isExpressionStatement,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadElement,
  isVariableDeclaration,
  type Node,
  type ObjectLiteralExpression,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { type FrameBinding, frameBindingOf } from './framed-bindings.ts';
import { framedAccessorTakes } from './framed-member-accessors.ts';
import {
  framedHeldVariable,
  framedMemberWrites,
  framedPrototypeWrites,
  type MemberWrite,
} from './framed-member-writes.ts';
import { framedLiteralPrototypes } from './framed-object-members.ts';
import { framedAssignedSources, framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';

/** Post-capture member writes and definite field overwrites on a captured record alias. */

/** A record's entries: each definite name's possible values, and values under unread names. */
export interface RecordFields {
  readonly named: ReadonlyMap<string, readonly Expression[]>;
  readonly unknown: readonly Expression[];
}

/** Pre-merge record state retaining per-key optional writes separately from unread-key writes. */
export interface CapturedRecord {
  readonly named: ReadonlyMap<string, readonly Expression[]>;
  readonly optional: ReadonlyMap<string, readonly Expression[]>;
  readonly unknown: readonly Expression[];
}

/** A source-known record alias read at its capture site and consumed later at `consumer`. */
export interface CapturedAlias {
  readonly capture: Identifier;
  readonly binding: FrameBinding;
  readonly origin: ObjectLiteralExpression;
  readonly consumer: Node;
}

interface CutWrite {
  readonly index: number;
  readonly write: MemberWrite;
}

interface MutableCapturedState {
  readonly named: Map<string, Set<Expression>>;
  readonly optional: Map<string, Set<Expression>>;
  readonly unknown: Set<Expression>;
}

/** Flattens optional named writes into `unknown`, keeping only definite keys in `named`. */
export function toRecordFields(captured: CapturedRecord): RecordFields {
  if (captured.optional.size === 0) return { named: captured.named, unknown: captured.unknown };
  const unknown = new Set<Expression>(captured.unknown);
  for (const values of captured.optional.values()) {
    for (const each of values) unknown.add(each);
  }
  return { named: captured.named, unknown: [...unknown] };
}

/**
 * Merges member writes on a captured alias that may run after capture and before `consumer`,
 * replacing earlier values when a definite post-capture field write updates the same object.
 */
export function withCapturedWrites(captured: CapturedRecord, alias: CapturedAlias): RecordFields {
  const holders = aliasHolders(alias.binding);
  if (holders.size === 0) return toRecordFields(captured);
  const writes = postCaptureWrites(alias.capture, holders, alias.consumer);
  if (writes.length === 0) return toRecordFields(captured);
  const overwrites = definiteCapturedOverwrites(writes, holders, alias);
  const state = seededCapturedState(captured, overwrites);
  for (const [index, write] of writes.entries()) {
    applyCapturedWrite({ index, write }, overwrites, alias.consumer, state);
  }
  return settledCapturedFields(state);
}

/** Seeds definite and optional field maps, replacing pre-capture entries for overwritten keys. */
function seededCapturedState(
  captured: CapturedRecord,
  overwrites: ReadonlyMap<string, CutWrite>,
): MutableCapturedState {
  const named = seededFieldMap(captured.named, overwrites);
  const optional = seededFieldMap(captured.optional, overwrites);
  for (const [key, cut] of overwrites) {
    if (!named.has(key) && !optional.has(key)) optional.set(key, new Set([cut.write.value]));
  }
  return { named, optional, unknown: new Set(captured.unknown) };
}

/** Copies per-key candidate sets, substituting the last definite post-capture write where present. */
function seededFieldMap(
  source: ReadonlyMap<string, readonly Expression[]>,
  overwrites: ReadonlyMap<string, CutWrite>,
): Map<string, Set<Expression>> {
  const seeded = new Map<string, Set<Expression>>();
  for (const [key, values] of source) {
    const cut = overwrites.get(key);
    seeded.set(key, new Set(cut === undefined ? values : [cut.write.value]));
  }
  return seeded;
}

/** Applies a post-capture write unless a later definite write on that key replaces it. */
function applyCapturedWrite(
  entry: CutWrite,
  overwrites: ReadonlyMap<string, CutWrite>,
  consumer: Node,
  state: MutableCapturedState,
): void {
  const [first] = entry.write.path;
  if (first === undefined) {
    state.unknown.add(entry.write.value);
    return;
  }
  for (const key of first) {
    const cut = overwrites.get(key);
    if (cut !== undefined && replacedByCapturedWrite(entry, cut, consumer)) continue;
    appendCapturedKeyValue(key, entry.write.value, state);
  }
}

/** Appends a surviving post-capture value to `named`, `optional`, or `unknown`. */
function appendCapturedKeyValue(key: string, value: Expression, state: MutableCapturedState): void {
  const existing = state.named.get(key) ?? state.optional.get(key);
  if (existing === undefined) state.unknown.add(value);
  else existing.add(value);
}

/** Converts mutable captured field sets back into an immutable `RecordFields` result. */
function settledCapturedFields(state: MutableCapturedState): RecordFields {
  const named = new Map<string, readonly Expression[]>();
  for (const [key, values] of state.named) named.set(key, [...values]);
  for (const values of state.optional.values()) {
    for (const each of values) state.unknown.add(each);
  }
  return { named, unknown: [...state.unknown] };
}

/** Whether `cut` itself or an earlier same-owner write before `cut` is superseded at `consumer`. */
function replacedByCapturedWrite(candidate: CutWrite, cut: CutWrite, consumer: Node): boolean {
  if (candidate.index === cut.index) return true;
  if (executionOwner(candidate.write.node) !== executionOwner(consumer)) return false;
  if (candidate.write.node === cut.write.node) return candidate.index < cut.index;
  return candidate.write.node.pos < cut.write.node.pos;
}

/** Finds the last definite post-capture field overwrite per static key on the captured object. */
function definiteCapturedOverwrites(
  writes: readonly MemberWrite[],
  holders: ReadonlySet<VariableDeclaration>,
  alias: CapturedAlias,
): ReadonlyMap<string, CutWrite> {
  const root = unaliasedOriginDeclaration(alias.capture);
  if (root === undefined || hasPrototypeWrite(alias.capture, holders)) return new Map();
  const overwrites = new Map<string, CutWrite>();
  for (const [index, write] of writes.entries()) {
    const key = definiteOverwriteKey(write, root, alias);
    if (key === undefined) continue;
    const next: CutWrite = { index, write };
    if (replacesLaterOverwrite(overwrites.get(key), next)) overwrites.set(key, next);
  }
  return overwrites;
}

/** Picks the later definite overwrite, breaking same-call `Object.assign` ties by entry order. */
function replacesLaterOverwrite(existing: CutWrite | undefined, next: CutWrite): boolean {
  if (existing === undefined) return true;
  if (next.write.node === existing.write.node) return next.index > existing.index;
  return next.write.node.pos > existing.write.node.pos;
}

/** Returns the static key a write definitely replaces on `alias.origin` between capture and use. */
function definiteOverwriteKey(
  write: MemberWrite,
  root: VariableDeclaration,
  alias: CapturedAlias,
): string | undefined {
  const key = singleFieldKey(write.path);
  if (key === undefined) return undefined;
  const target = definiteWriteTarget(write.node);
  if (target === undefined || unaliasedOriginDeclaration(target.receiver) !== root)
    return undefined;
  if (!target.defined && !replacesPlainField(alias.origin, key)) return undefined;
  return definitelyBetween(alias.capture, write.node, alias.consumer) ? key : undefined;
}

/** Extracts a single static non-`__proto__` field name from a depth-1 member write path. */
function singleFieldKey(path: MemberWrite['path']): string | undefined {
  const [first, ...rest] = path;
  if (first?.length !== 1 || rest.length > 0) return undefined;
  const [key] = first;
  return key === undefined || key === '__proto__' ? undefined : key;
}

/** Checks that neither an own accessor nor a literal prototype can intercept plain assignment. */
function replacesPlainField(origin: ObjectLiteralExpression, key: string): boolean {
  return !framedAccessorTakes(origin, key) && framedLiteralPrototypes(origin).length === 0;
}

/** Checks whether any prototype setter targets `holders` in the enclosing module. */
function hasPrototypeWrite(
  capture: Identifier,
  holders: ReadonlySet<VariableDeclaration>,
): boolean {
  return framedPrototypeWrites(capture.getSourceFile()).some((write) => holders.has(write.holder));
}

/** Resolves the receiver identifier and definition mode of a definite member write node. */
function definiteWriteTarget(
  node: Node,
): { readonly receiver: Identifier; readonly defined: boolean } | undefined {
  if (isBinaryExpression(node)) return definiteAssignmentTarget(node);
  if (!isCallExpression(node)) return undefined;
  const callee = globalPathOf(unwrapped(node.expression))?.join('.');
  if (callee === 'Object.assign') return definiteAssignReceiver(node);
  return callee === 'Object.defineProperty' ? definiteDefineReceiver(node) : undefined;
}

/** Plain `receiver.key = value` or `receiver['key'] = value` (excluding logical assignments). */
function definiteAssignmentTarget(
  node: BinaryExpression,
): { readonly receiver: Identifier; readonly defined: false } | undefined {
  if (node.operatorToken.kind !== SyntaxKind.EqualsToken) return undefined;
  const left = unwrapped(node.left);
  if (!isPropertyAccessExpression(left) && !isElementAccessExpression(left)) return undefined;
  const receiver = unwrapped(left.expression);
  return isIdentifier(receiver) ? { receiver, defined: false } : undefined;
}

/** `Object.assign(receiver, { ... })` where every source argument is a static data literal. */
function definiteAssignReceiver(
  call: CallExpression,
): { readonly receiver: Identifier; readonly defined: false } | undefined {
  const [first, second, ...rest] = call.arguments;
  if (first === undefined || second === undefined || isSpreadElement(first)) return undefined;
  const receiver = unwrapped(first);
  if (!isIdentifier(receiver)) return undefined;
  return [second, ...rest].every((source) => plainAssignSource(source))
    ? { receiver, defined: false }
    : undefined;
}

/** Checks that an `Object.assign` source argument contains only static data entries. */
function plainAssignSource(argument: Expression): boolean {
  if (isSpreadElement(argument)) return false;
  const literal = unwrapped(argument);
  return (
    isObjectLiteralExpression(literal) &&
    literal.properties.every((property) => {
      return (
        (isPropertyAssignment(property) || isShorthandPropertyAssignment(property)) &&
        writtenArrayKey(property.name) !== undefined
      );
    })
  );
}

/** `Object.defineProperty(receiver, key, { value })` with a plain data descriptor literal. */
function definiteDefineReceiver(
  call: CallExpression,
): { readonly receiver: Identifier; readonly defined: true } | undefined {
  const [first, second, third] = call.arguments;
  if (first === undefined || second === undefined || third === undefined) return undefined;
  if (isSpreadElement(first) || isSpreadElement(second) || isSpreadElement(third)) return undefined;
  const receiver = unwrapped(first);
  return isIdentifier(receiver) && plainDataDescriptor(third)
    ? { receiver, defined: true }
    : undefined;
}

/** Checks that a descriptor literal has only static data entries and no `get` or `set`. */
function plainDataDescriptor(node: Expression): boolean {
  const descriptor = unwrapped(node);
  return (
    isObjectLiteralExpression(descriptor) &&
    descriptor.properties.every((property) => {
      if (!isPropertyAssignment(property) && !isShorthandPropertyAssignment(property)) return false;
      const name = writtenArrayKey(property.name);
      return name !== undefined && name !== 'get' && name !== 'set';
    })
  );
}

/** Follows unreassigned identifier initializers to the root object-literal declaration, if any. */
function unaliasedOriginDeclaration(identifier: Identifier): VariableDeclaration | undefined {
  const seen = new Set<Node>();
  let current: Identifier | undefined = identifier;
  while (current !== undefined) {
    if (seen.has(current) || framedAssignedSources(current).length > 0) return undefined;
    seen.add(current);
    const initial = directInitializer(current);
    if (initial === undefined) return undefined;
    if (isObjectLiteralExpression(initial.value)) return initial.declaration;
    current = isIdentifier(initial.value) ? initial.value : undefined;
  }
  return undefined;
}

/** Reads the unwrapped initializer of a direct identifier variable declaration. */
function directInitializer(
  name: Identifier,
): { readonly declaration: VariableDeclaration; readonly value: Expression } | undefined {
  const selected = frameBindingOf(name);
  if (
    selected === undefined ||
    selected.keys.length > 0 ||
    !isVariableDeclaration(selected.binding) ||
    !isIdentifier(selected.binding.name) ||
    selected.binding.initializer === undefined
  )
    return undefined;
  return { declaration: selected.binding, value: unwrapped(selected.binding.initializer) };
}

/** Whether `change` is a block statement that definitely runs after `capture` and before `consumer`. */
function definitelyBetween(capture: Identifier, change: Node, consumer: Node): boolean {
  const owner = executionOwner(consumer);
  if (executionOwner(capture) !== owner || executionOwner(change) !== owner) return false;
  const statement = change.parent;
  if (!isExpressionStatement(statement)) return false;
  const block = statement.parent;
  if (!isBlock(block) && !isSourceFile(block)) return false;
  return (
    laterChildInBlock(consumer, block, statement.pos) &&
    earlierCaptureInCommonBlock(capture, statement)
  );
}

/** Whether `node` lies inside a later statement of `block` after `afterPos`. */
function laterChildInBlock(node: Node, block: Node, afterPos: number): boolean {
  for (let at: Node = node; !isSourceFile(at); at = at.parent) {
    if (at.parent === block) return at.pos > afterPos;
  }
  return false;
}

/** Whether `capture` lies in an earlier statement of the innermost shared `Block` or `SourceFile`. */
function earlierCaptureInCommonBlock(capture: Identifier, writeStatement: Node): boolean {
  const writeBranches = enclosingBlockChildren(writeStatement);
  for (let at: Node = capture; !isSourceFile(at); at = at.parent) {
    const writeBranch = writeBranches.get(at.parent);
    if (writeBranch !== undefined) return at.pos < writeBranch.pos;
  }
  return false;
}

/** Indexes each enclosing `Block` or `SourceFile` to the child statement containing `statement`. */
function enclosingBlockChildren(statement: Node): ReadonlyMap<Node, Node> {
  const branches = new Map<Node, Node>();
  for (let at: Node = statement; !isSourceFile(at); at = at.parent) {
    if (isBlock(at.parent) || isSourceFile(at.parent)) branches.set(at.parent, at);
  }
  return branches;
}

/** Variable declarations along an alias's initializer chain whose object reference may be shared. */
function aliasHolders(binding: FrameBinding): ReadonlySet<VariableDeclaration> {
  const holders = new Set<VariableDeclaration>();
  let current: FrameBinding | undefined = binding;
  while (current !== undefined && isVariableDeclaration(current) && !holders.has(current)) {
    holders.add(framedHeldVariable(current));
    holders.add(current);
    current = nextInitializerBinding(current);
  }
  return holders;
}

/** Follows an identifier initializer to the declaration it aliases, if any. */
function nextInitializerBinding(declaration: VariableDeclaration): FrameBinding | undefined {
  if (declaration.initializer === undefined) return undefined;
  const initial = unwrapped(declaration.initializer);
  return isIdentifier(initial) ? frameBindingOf(initial)?.binding : undefined;
}

/** Member writes on `holders` that may execute after `capture` and still reach `consumer`. */
function postCaptureWrites(
  capture: Identifier,
  holders: ReadonlySet<VariableDeclaration>,
  consumer: Node,
): readonly MemberWrite[] {
  return framedMemberWrites(capture.getSourceFile()).filter((write) => {
    return (
      holders.has(write.holder) &&
      write.path.length === 1 &&
      reachesConsumer(write.node, write.holder, consumer) &&
      runsAfterCapture(write.node, capture, write.holder)
    );
  });
}

/** Whether a member write can run before `consumer` evaluates. */
function reachesConsumer(write: Node, holder: VariableDeclaration, consumer: Node): boolean {
  if (!framedPossibleBranch(write)) return false;
  const owner = executionOwner(consumer);
  return (
    executionOwner(write) !== owner ||
    write.pos < consumer.end ||
    destructuredFirst(write, consumer) ||
    repeatedFrameRead(write, consumer, holder, owner)
  );
}

/** Whether a member write is not confined strictly before the alias capture evaluates. */
function runsAfterCapture(write: Node, capture: Identifier, holder: VariableDeclaration): boolean {
  const owner = executionOwner(capture);
  return (
    executionOwner(write) !== owner ||
    write.end > capture.end ||
    destructuredFirst(capture, write) ||
    repeatedFrameRead(write, capture, holder, owner)
  );
}
