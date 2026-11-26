import {
  type CallExpression,
  type Expression,
  isBigIntLiteral,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isPropertyAccessExpression,
  isVoidExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedAppliedPrefix, framedArgumentPrefix } from './framed-keys.ts';
import { framedPresenceTarget } from './framed-presence-targets.ts';
import { framedProxyFixedKeys } from './framed-proxy-key-shapes.ts';
import { framedProxyShapeTarget } from './framed-proxy-shape-targets.ts';
import { framedCondition, framedNativeConstructor } from './framed-sources.ts';
import { framedPropertyNames } from './framed-symbol-keys.ts';

/** Native own-key enumeration and presence checks retain an Error's engine-specific shape. */

const ENUMERATIONS = new Set(['Object.getOwnPropertyNames', 'Reflect.ownKeys']);
const PRESENCE = new Set(['Object.hasOwn']);
const MEMBER_PRESENCE = new Set(['Object.prototype.hasOwnProperty']);
const UNDEFINED = new Set(['undefined']);
const SLOTS = { borrowed: 3 } as const;

type ShapeKind = 'keys' | 'own' | 'member';
type Prefix = ReturnType<typeof framedArgumentPrefix>;

interface ShapeCall {
  readonly kind: ShapeKind;
  readonly args: Prefix;
  readonly receiver?: Expression | undefined;
  readonly alternatives?: readonly Expression[] | undefined;
}

interface ShapeObservation {
  readonly of: Expression;
  readonly names: readonly string[] | undefined;
  readonly alternatives: readonly Expression[] | undefined;
}

/** A reflective observation keeps the existing Error receiver and member classification. */
export function framedErrorShape(
  node: Node,
  frames: ReadonlySet<string>,
): ShapeObservation | undefined {
  if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.InKeyword) {
    const of = framedPresenceTarget(node.right);
    const names = presenceNames(node.left, frames);
    return of === undefined || names?.length === 0
      ? undefined
      : { of, names, alternatives: undefined };
  }
  if (!isCallExpression(node)) return undefined;
  const selected = shapeCall(node);
  if (selected === undefined) return undefined;
  const member = selected.kind === 'member';
  const targets = member
    ? { of: selected.receiver, alternatives: selected.alternatives }
    : argumentTarget(selected.args);
  const { of, alternatives } = targets;
  if (of === undefined) return undefined;
  if (selected.kind === 'keys') return keyShape(of, node, selected.args, alternatives);
  const key = selected.args.values[member ? 0 : 1];
  if (key === undefined && !selected.args.unknown) return undefined;
  const names = key === undefined ? undefined : presenceNames(key, frames);
  return names?.length === 0
    ? undefined
    : { of: framedProxyShapeTarget(of, node, 'own', key) ?? of, names, alternatives };
}

/**
 * The target a native reflection takes first, and its alternatives: past a prefix that ends before
 * it, what the positions there may hold (`framedArgumentPrefix`'s alternatives), the first in turn.
 */
function argumentTarget(args: Prefix): {
  readonly of: Expression | undefined;
  readonly alternatives: readonly Expression[] | undefined;
} {
  const [first] = args.values;
  if (first !== undefined || !args.unknown) return { of: first, alternatives: args.alternatives };
  const [of, ...alternatives] = args.alternatives ?? [];
  return { of, alternatives };
}

/** A closed ownKeys trap supplies the key list before the target's native shape is considered. */
function keyShape(
  of: Expression,
  node: CallExpression,
  args: Prefix,
  alternatives: readonly Expression[] | undefined,
): ShapeObservation | undefined {
  if (alternatives === undefined && !args.unknown && framedProxyFixedKeys(of, node))
    return undefined;
  return {
    of: framedProxyShapeTarget(of, node, 'keys') ?? of,
    names: undefined,
    alternatives,
  };
}

/** Only finite engine frame names or an opaque key can reveal native Error layout. */
function presenceNames(
  key: Expression,
  frames: ReadonlySet<string>,
): readonly string[] | undefined {
  const names = framedPropertyNames(key);
  if (names !== undefined) return names.filter((name) => frames.has(name));
  const value = unwrapped(key);
  const primitive =
    framedCondition(value) !== undefined ||
    framedNativeConstructor(value, UNDEFINED) ||
    isVoidExpression(value) ||
    isBigIntLiteral(value);
  return primitive ? [] : undefined;
}

/** Direct native calls and borrowed native callables keep their own consumed target/key prefix. */
function shapeCall(call: CallExpression): ShapeCall | undefined {
  const direct = shapeKind(call.expression);
  if (direct !== undefined && direct !== 'member')
    return { kind: direct, args: framedArgumentPrefix(call) };
  const callee = unwrapped(call.expression);
  if (globalPathOf(callee)?.join('.') === 'Reflect.apply') {
    const prefix = framedArgumentPrefix(call, call.arguments, SLOTS.borrowed);
    const [target, receiver, applied] = prefix.values;
    const kind = target === undefined ? undefined : shapeKind(target);
    return kind === undefined || receiver === undefined
      ? undefined
      : { kind, receiver, args: appliedPrefix(call, applied) };
  }
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) return undefined;
  const method = frameMemberName(callee);
  const kind = shapeKind(callee.expression);
  if (kind === undefined || (method !== 'call' && method !== 'apply')) return undefined;
  const limit = method === 'call' ? SLOTS.borrowed : 2;
  const prefix = framedArgumentPrefix(call, call.arguments, limit);
  const [receiver, applied] = prefix.values;
  if (receiver === undefined) return undefined;
  const args = method === 'call' ? afterReceiver(prefix) : appliedPrefix(call, applied);
  return { kind, receiver, args, alternatives: prefix.alternatives };
}

/** A call's arguments past its receiver, with what the positions past its prefix may hold. */
function afterReceiver(prefix: Prefix): Prefix {
  const values = prefix.values.slice(1);
  return prefix.alternatives === undefined
    ? { values, unknown: prefix.unknown }
    : { values, unknown: prefix.unknown, alternatives: prefix.alternatives };
}

/**
 * An unchanged applied tuple keeps its entries, and one past code the call may run first what it was
 * written with (`framedAppliedPrefix`); an opaque list leaves the key possible.
 */
function appliedPrefix(call: CallExpression, applied: Expression | undefined): Prefix {
  return applied === undefined
    ? { values: [], unknown: false }
    : framedAppliedPrefix(call, applied);
}

/** Whole immutable aliases retain an unshadowed native reflection operation. */
function shapeKind(callee: Expression): ShapeKind | undefined {
  if (framedNativeConstructor(callee, ENUMERATIONS)) return 'keys';
  if (framedNativeConstructor(callee, PRESENCE)) return 'own';
  return framedNativeConstructor(callee, MEMBER_PRESENCE) ? 'member' : undefined;
}
