import {
  type CallExpression,
  type Expression,
  isCatchClause,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isPropertyAssignment,
  type NewExpression,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { quietErrorConstruction } from './framed-copy-guards.ts';
import { framedGroupByOwnedInput } from './framed-groupby-inputs.ts';
import { iteratorCarriedUnexposed } from './framed-iterator-carried.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import {
  framedProxyHandlerEntryQuiet,
  framedProxyHandlerKey,
  framedProxySource,
  framedProxyUnexposed,
} from './framed-proxy-key-shapes.ts';
import { framedProxyShapeInputs } from './framed-proxy-shape-inputs.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** Own-key and own-presence operations consult their specific Proxy traps independently of get. */

const PROXIES = new Set(['Proxy']);
const UNDEFINED = new Set(['undefined']);

interface ShapeChain {
  readonly terminal: Expression;
  readonly creations: ReadonlySet<NewExpression>;
  readonly roots: readonly Expression[];
}

/** A first quiet observation follows only native layers whose relevant trap is absent. */
export function framedProxyShapeTarget(
  node: Expression,
  consumer: CallExpression,
  kind: 'keys' | 'own',
  key?: Expression,
): Expression | undefined {
  const chain = proxyChain(
    node,
    consumer,
    kind === 'keys' ? 'ownKeys' : 'getOwnPropertyDescriptor',
  );
  if (chain === undefined || !framedProxyShapeInputs(consumer, chain.creations, key))
    return undefined;
  return terminalTarget(chain, consumer);
}

/** Every nested native Proxy layer has a closed unchanged handler before reaching a terminal input. */
function proxyChain(
  node: Expression,
  consumer: CallExpression,
  trap: string,
): ShapeChain | undefined {
  let terminal = node;
  const creations = new Set<NewExpression>();
  const roots: Expression[] = [];
  for (;;) {
    const source = framedProxySource(terminal, consumer);
    const value = source?.value;
    if (
      value === undefined ||
      !isNewExpression(value) ||
      !framedNativeConstructor(value.expression, PROXIES)
    )
      return creations.size === 0 ? undefined : { terminal, creations, roots };
    if (source === undefined || creations.has(value) || !framedProxyUnexposed(consumer, source))
      return undefined;
    const args = framedArgumentPrefix(value);
    const [target, handler] = args.values;
    if (
      target === undefined ||
      handler === undefined ||
      args.alternatives !== undefined ||
      args.unknown
    )
      return undefined;
    const record = handlerRecord(handler, consumer);
    if (record === undefined || !absentTrap(record, trap)) return undefined;
    creations.add(value);
    roots.push(value, record);
    terminal = target;
  }
}

/** A handler's whole immutable aliases stay in the observation's owner and remain unexposed. */
function handlerRecord(
  node: Expression,
  consumer: CallExpression,
): ObjectLiteralExpression | undefined {
  const source = framedProxySource(node, consumer);
  return source !== undefined &&
    isObjectLiteralExpression(source.value) &&
    framedProxyUnexposed(consumer, source)
    ? source.value
    : undefined;
}

/** Closed own data fields can explicitly disable a native trap with undefined or null. */
function absentTrap(record: ObjectLiteralExpression, trap: string): boolean {
  for (const property of record.properties) {
    const name = 'name' in property ? property.name : undefined;
    const key = name === undefined ? undefined : framedProxyHandlerKey(name);
    if (key === undefined || key === '__proto__' || !framedProxyHandlerEntryQuiet(property))
      return false;
    if (key !== trap) continue;
    if (!isPropertyAssignment(property)) return false;
    const value = unwrapped(property.initializer);
    if (value.kind !== SyntaxKind.NullKeyword && !framedNativeConstructor(value, UNDEFINED))
      return false;
  }
  return true;
}

/** A supplied lexical input or fresh native Error is not replaced by an unresolved inner Proxy. */
function terminalTarget(chain: ShapeChain, consumer: CallExpression): Expression | undefined {
  const source = framedProxySource(chain.terminal, consumer);
  if (
    source !== undefined &&
    quietErrorConstruction(source.value) &&
    framedProxyUnexposed(consumer, source)
  )
    return source.value;
  const value = framedGroupByOwnedInput(chain.terminal, consumer);
  if (!isIdentifier(value) || !framedOriginCoowned(chain.terminal, consumer)) return undefined;
  const selected = frameBindingOf(value);
  if (
    selected === undefined ||
    selected.keys.length > 0 ||
    (!isParameterDeclaration(selected.binding) && !isCatchClause(selected.binding.parent))
  )
    return undefined;
  return iteratorCarriedUnexposed(chain.roots, [{ value: chain.terminal }], consumer)
    ? chain.terminal
    : undefined;
}
