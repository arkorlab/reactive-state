import { type Expression, isCallExpression, type Node } from 'typescript/ast';

import { framedArgumentPrefix } from './framed-keys.ts';
import { framedNativeArguments } from './framed-native-arguments.ts';
import { framedPropertyNames } from './framed-symbol-keys.ts';

const REFLECT_GET = new Set(['Reflect.get']);

/** Native Reflect.get retains its selected target and key through source-known borrowing. */
export function framedReflectRead(node: Node):
  | {
      readonly names: readonly string[] | undefined;
      readonly of: Expression;
      readonly alternatives?: readonly Expression[] | undefined;
    }
  | undefined {
  if (!isCallExpression(node)) return undefined;
  const selected = framedNativeArguments(node, REFLECT_GET);
  if (selected?.args === undefined) return undefined;
  const prefix = framedArgumentPrefix(node, selected.args);
  const [target, key] = prefix.values;
  return target === undefined || (key === undefined && !prefix.unknown)
    ? undefined
    : {
        of: target,
        names: key === undefined ? undefined : framedPropertyNames(key),
        alternatives: prefix.alternatives,
      };
}
