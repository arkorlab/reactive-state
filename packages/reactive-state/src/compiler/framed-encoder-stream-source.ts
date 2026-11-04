import {
  type CallExpression,
  type Expression,
  type Identifier,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isNewExpression,
  isPropertyAccessExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  type NewExpression,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { framedQuietData, framedQuietPrimitive } from './framed-native-evaluation.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** A fresh encoder stream retains only its original native writer and default reader chains. */

const ENCODERS = new Set(['TextEncoderStream']);
type StreamRole = 'stream' | 'writable' | 'readable' | 'writer' | 'reader';

export interface EncoderStreamSource {
  readonly created: NewExpression;
  readonly bindings: ReadonlySet<FrameBinding>;
  readonly accesses: ReadonlySet<Expression>;
}

/** Whole constant aliases retain their native stream, writer or default reader identity. */
export function framedEncoderStreamSource(
  expression: Expression,
  role: StreamRole,
): EncoderStreamSource | undefined {
  const bindings = new Set<FrameBinding>();
  const accesses = new Set<Expression>();
  let value = unwrapped(expression);
  let selected = role;
  for (;;) {
    if (isIdentifier(value)) {
      const initializer = streamAlias(value, bindings);
      if (initializer === undefined) return undefined;
      value = unwrapped(initializer);
      continue;
    }
    if (selected === 'stream')
      return isNewExpression(value) &&
        framedNativeConstructor(value.expression, ENCODERS) &&
        (value.arguments ?? []).every((argument) => framedQuietData(argument))
        ? { created: value, bindings, accesses }
        : undefined;
    const next = streamStep(value, selected);
    if (next === undefined) return undefined;
    accesses.add(value);
    value = unwrapped(next.value);
    selected = next.role;
  }
}

/** Only whole immutable local bindings carry a native stream view. */
function streamAlias(value: Identifier, bindings: Set<FrameBinding>): Expression | undefined {
  const source = frameBindingOf(value);
  if (source === undefined || source.keys.length > 0 || bindings.has(source.binding))
    return undefined;
  const { binding } = source;
  if (
    !isVariableDeclaration(binding) ||
    !isVariableDeclarationList(binding.parent) ||
    !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
    binding.initializer === undefined
  )
    return undefined;
  bindings.add(binding);
  return binding.initializer;
}

/** Default reader acquisition has no mode dictionary or callback conversion. */
function streamStep(
  value: Expression,
  role: Exclude<StreamRole, 'stream'>,
): { readonly value: Expression; readonly role: StreamRole } | undefined {
  if (role === 'writer' || role === 'reader') {
    if (!isCallExpression(value) || value.arguments.length > 0) return undefined;
    const method = streamMember(value.expression);
    const expected = role === 'writer' ? 'getWriter' : 'getReader';
    return method?.name === expected
      ? { value: method.value, role: role === 'writer' ? 'writable' : 'readable' }
      : undefined;
  }
  const member = streamMember(value);
  return member?.name === role ? { value: member.value, role: 'stream' } : undefined;
}

/** A literal computed method name adds no application evaluation. */
export function streamMember(
  expression: Expression,
): { readonly name: string | undefined; readonly value: Expression } | undefined {
  const member = unwrapped(expression);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return undefined;
  if (isElementAccessExpression(member) && !framedQuietPrimitive(member.argumentExpression))
    return undefined;
  return { name: frameMemberName(member), value: member.expression };
}

/** A default read on the same fresh channel supplies the closed native conversion handoff. */
export function framedEncoderStreamRead(call: CallExpression): EncoderStreamSource | undefined {
  const member = streamMember(call.expression);
  return member?.name === 'read' && call.arguments.length === 0
    ? framedEncoderStreamSource(member.value, 'reader')
    : undefined;
}

/** Every prior receiver use belongs to the selected closed native channel chain. */
export function framedEncoderStreamUnexposed(
  writer: EncoderStreamSource,
  reader: EncoderStreamSource,
  write: CallExpression,
  read: CallExpression,
): boolean {
  if (writer.created !== reader.created) return false;
  const bindings = new Set([...writer.bindings, ...reader.bindings]);
  const allowed = new Set<Expression>([read, write, ...reader.accesses, ...writer.accesses]);
  const selection = { read, write };
  const pending: Node[] = [write.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isIdentifier(node) && exposedStreamName(node, bindings, allowed, selection)) return false;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** Captured receiver uses and prior unmodeled handoffs can replace the selected native chain. */
function exposedStreamName(
  name: Identifier,
  bindings: ReadonlySet<FrameBinding>,
  allowed: ReadonlySet<Expression>,
  selection: { readonly read: CallExpression; readonly write: CallExpression },
): boolean {
  if (!readsBinding(name)) return false;
  const source = frameBindingOf(name);
  if (source === undefined || !bindings.has(source.binding) || name === source.binding.name)
    return false;
  return (
    executionOwner(name) !== executionOwner(selection.write) ||
    (name.pos < selection.read.end && !allowedStreamUse(name, bindings, allowed))
  );
}

/** Whole aliases and the exact selected method chains cannot replace a native stream member. */
function allowedStreamUse(
  name: Expression,
  bindings: ReadonlySet<FrameBinding>,
  allowed: ReadonlySet<Expression>,
): boolean {
  let used = useOf(name);
  while (isPropertyAccessExpression(used.parent) || isElementAccessExpression(used.parent)) {
    if (used.parent.expression !== used.at) return false;
    if (allowed.has(used.parent)) return true;
    used = useOf(used.parent);
  }
  const { parent } = used;
  if (isCallExpression(parent) && allowed.has(parent)) return true;
  return (
    isVariableDeclaration(parent) &&
    bindings.has(parent) &&
    parent.initializer !== undefined &&
    unwrapped(parent.initializer) === name
  );
}
