import {
  type Expression,
  isCallExpression,
  isIdentifier,
  isNewExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { argumentArrayExposed } from './framed-array-selections.ts';
import { arrayError } from './framed-arrays.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedNativeArguments } from './framed-native-arguments.ts';
import { framedObjectSources } from './framed-object-members.ts';

/** A native Request converts its selected init body rather than the whole options object. */

const REQUESTS = new Set(['Request']);

interface BodyWords {
  readonly error: (value: Expression, keys?: readonly string[]) => boolean;
  readonly typed: (value: Expression) => boolean;
}

/** Literal body fields and getters retain their original Error words and array text conversion. */
export function framedRequestBodyText(node: Node, words: BodyWords): boolean {
  if (!isCallExpression(node) && !isNewExpression(node)) return false;
  const selected = framedNativeArguments(node, REQUESTS);
  if (selected?.constructed !== true || selected.args === undefined) return false;
  const prefix = framedArgumentPrefix(node, selected.args);
  const options = prefix.values[1];
  if (options === undefined || prefix.unknown) return false;
  const selectedOptions = requestOptions(options) ?? options;
  const sources = framedObjectSources(selectedOptions, ['body']) ?? [
    { value: options, keys: ['body'] },
  ];
  return sources.some(
    ({ value, keys }) =>
      words.error(value, keys) || (keys.length === 0 && arrayError(value, words, node)),
  );
}

/** Whole constant options aliases retain their fields only before any earlier exposure or write. */
function requestOptions(expression: Expression): Expression | undefined {
  let value = unwrapped(expression);
  const aliases = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0) return undefined;
    const { binding } = selected;
    if (
      !isVariableDeclaration(binding) ||
      !isIdentifier(binding.name) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined ||
      aliases.has(binding)
    )
      return undefined;
    aliases.add(binding);
    value = unwrapped(binding.initializer);
  }
  return argumentArrayExposed(expression, aliases) ? undefined : value;
}
