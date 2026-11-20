import { type Expression, isCallExpression, type Node } from 'typescript/ast';

import { framedArgumentPrefix } from './framed-keys.ts';
import { framedNativeArguments } from './framed-native-arguments.ts';
import { framedPropertyNames } from './framed-symbol-keys.ts';

/**
 * What a native `Reflect.get` reads in a render, as a member read would: of a possible formatter
 * here, of a date (`local-date-inputs.ts`), of a locale member (`render-local-inputs.ts`) and of a
 * date format's `format`, given no date (`untracked-reads.ts`).
 */

const REFLECT_GET: ReadonlySet<string> = new Set(['Reflect.get']);
/** The target, key and receiver `Reflect.get` consumes. */
const SLOTS = { reflected: 3 } as const;

/** What `Reflect.get` is given: its target, its key, and a written receiver. */
interface ReflectedRead {
  readonly target: Expression;
  /** None where an argument list the compile cannot read follows the target. */
  readonly key: Expression | undefined;
  readonly receiver: Expression | undefined;
}

/** A reflective read of a possible formatter: its target, the names its key may be, a receiver. */
interface IntlReflectRead {
  readonly expression: Expression;
  readonly names: readonly string[];
  readonly receiver: Expression | undefined;
}

/**
 * What a source-known native `Reflect.get` is given — written, a whole immutable alias, borrowed by
 * `call` or `apply`, or applied by `Reflect.apply`: its target, its key, and a written receiver,
 * which an accessor such as `format` runs on. None of a target the compile cannot read, nor of a
 * call given no key.
 */
export function reflectedRead(node: Node): ReflectedRead | undefined {
  if (!isCallExpression(node)) return undefined;
  const selected = framedNativeArguments(node, REFLECT_GET);
  if (selected?.args === undefined) return undefined;
  const prefix = framedArgumentPrefix(node, selected.args, SLOTS.reflected);
  const [target, key, receiver] = prefix.values;
  return target === undefined || (key === undefined && !prefix.unknown)
    ? undefined
    : { target, key, receiver };
}

/**
 * What a source-known native `Reflect.get` reads of a possible formatter (`reflectedRead`), by a
 * key the compile reads; none of a key or an argument list it cannot read, which keeps the previous
 * boundary.
 */
export function intlReflectRead(node: Node): IntlReflectRead | undefined {
  const read = reflectedRead(node);
  const names = read?.key === undefined ? undefined : framedPropertyNames(read.key);
  return read === undefined || names === undefined
    ? undefined
    : { expression: read.target, names, receiver: read.receiver };
}
