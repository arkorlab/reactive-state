import {
  type Expression,
  isCallExpression,
  isElementAccessExpression,
  isNewExpression,
  isPropertyAccessExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { framedAggregateError } from './framed-aggregate-errors.ts';
import type { AssignedFrameSource } from './framed-assignment-patterns.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedLiteralObject } from './framed-literal-data.ts';
import { framedNativeArguments } from './framed-native-arguments.ts';
import { framedTypedObjectSources, framedUnreadAssign } from './framed-object-members.ts';
import { framedNativeConstructor } from './framed-sources.ts';

const AGGREGATE = new Set(['AggregateError']);
const DOM = new Set(['DOMException']);

/** Native Error options retain a selected cause without converting it into the outer error's words. */
export function framedErrorCause(
  node: Expression,
  selection: { readonly made: boolean; readonly keys: readonly string[] },
  names: ReadonlySet<string>,
  error: (value: Expression, local: boolean, path: readonly string[]) => boolean,
): boolean | undefined {
  const aggregate = framedAggregateError(node, selection, names, error);
  if (aggregate !== undefined) return aggregate;
  const { made, keys } = selection;
  const sources = causeSources(node, keys, names);
  if (sources === undefined) return undefined;
  if (sources.some((each) => error(each.value, made, each.keys))) return true;
  if (
    !made &&
    sources.length > 0 &&
    sources.every(
      (each) =>
        each.keys.length === 0 && (framedLiteralObject(each.value) || error(each.value, true, [])),
    )
  )
    return false;
  return undefined;
}

/** A direct selected cause keeps its native constructor's options slot and remaining member path. */
function causeSources(
  node: Expression,
  keys: readonly string[],
  names: ReadonlySet<string>,
): readonly AssignedFrameSource[] | undefined {
  let value = unwrapped(node);
  let path = keys;
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const key = frameMemberName(value);
    if (key === undefined) return undefined;
    path = [key, ...path];
    value = unwrapped(value.expression);
  }
  if (path[0] !== 'cause' || (!isCallExpression(value) && !isNewExpression(value)))
    return undefined;
  const selected = framedNativeArguments(value, names);
  if (selected?.args === undefined || framedNativeConstructor(selected.target, DOM))
    return undefined;
  const index = framedNativeConstructor(selected.target, AGGREGATE) ? 2 : 1;
  const prefix = framedArgumentPrefix(value, selected.args, index + 1);
  if (prefix.unknown || (prefix.alternatives?.length ?? 0) > 0) return undefined;
  const options = prefix.values[index];
  if (options === undefined) return undefined;
  const optionPath = ['cause', ...path.slice(1)];
  const typed = { value: options, keys: optionPath };
  const sources = framedTypedObjectSources(options, optionPath);
  if (sources === undefined) return [typed];
  return framedUnreadAssign(options) ? [...sources, typed] : sources;
}
