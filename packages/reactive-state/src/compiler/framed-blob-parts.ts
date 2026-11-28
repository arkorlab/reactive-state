import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isIdentifier,
  isNewExpression,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  type NewExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { argumentArrayExposed, selectedError } from './framed-array-selections.ts';
import { arrayError, framedArrayString } from './framed-arrays.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { quietReflectedBlob } from './framed-blob-reflected-inputs.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedNativeArguments } from './framed-native-arguments.ts';
import { framedNativeErrorInput } from './framed-native-error-inputs.ts';
import { framedTypedObjectSources, framedUnreadAssign } from './framed-object-members.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedConsumedArguments } from './framed-text-arguments.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';

/** Native Blob and File convert their text parts, retaining Blob and BufferSource values as bytes. */

const BLOBS = new Set(['Blob', 'File']);
const FILES = new Set(['File']);
const ERRORS = new Set([...STANDARD_ERRORS, 'AggregateError', 'DOMException']);

interface BlobCall {
  readonly node: CallExpression | NewExpression;
  readonly target: Expression;
  readonly args: readonly Expression[];
}

interface PartWords {
  readonly error: (value: Expression, keys?: readonly string[]) => boolean;
  readonly typed: (value: Expression) => boolean;
}

/** Native Blob and File parts, filenames and content types supply converted text. */
export function framedBlobParts(node: CallExpression | NewExpression, words: PartWords): boolean {
  const selected = framedNativeArguments(node, BLOBS);
  if (selected?.constructed !== true || selected.args === undefined) return false;
  const inputs = isCallExpression(node) ? reflectedBlobWords(node, words) : words;
  if (
    isCallExpression(node) &&
    (framedNativeConstructor(selected.target, FILES) ||
      !quietReflectedBlob(node, selected.args, blobOptions, (value) => inputs.error(value)))
  )
    return false;
  const call: BlobCall = { node, target: selected.target, args: selected.args };
  const convertedParts = framedConsumedArguments(node, call.args, 1).some((value) => {
    return isSpreadElement(value)
      ? selectedError(
          value.expression,
          0,
          {
            error: (parts) => arrayError(parts, inputs, node),
            typed: () => false,
          },
          node,
        )
      : arrayError(value, inputs, node);
  });
  return convertedParts || fileNameWords(call, inputs) || contentTypeWords(call, inputs);
}

/** Reflected calls add input origins only before their own string conversion becomes opaque. */
function reflectedBlobWords(call: CallExpression, words: PartWords): PartWords {
  const retained = (value: Expression): boolean => {
    if (framedNativeErrorInput(value, call, undefined, false)) return true;
    const source = unwrapped(blobOptions(value) ?? value);
    return isNewExpression(source) && framedNativeConstructor(source.expression, ERRORS);
  };
  return {
    error: (value, keys = []) => keys.length === 0 && retained(value) && words.error(value, keys),
    typed: (value) => retained(value) && words.typed(value),
  };
}

/** A source-known filename slot converts its value with the selected array text method. */
function fileNameWords(call: BlobCall, words: PartWords): boolean {
  if (!framedNativeConstructor(call.target, FILES)) return false;
  const name = framedArgumentPrefix(call.node, call.args).values[1];
  return name !== undefined && (words.error(name) || framedArrayString(name, words, call.node));
}

/** Only the selected options type field participates in native MIME type text conversion. */
function contentTypeWords(call: BlobCall, words: PartWords): boolean {
  const index = framedNativeConstructor(call.target, FILES) ? 2 : 1;
  const options = framedArgumentPrefix(call.node, call.args, index + 1, false).values[index];
  if (options === undefined) return false;
  const pending: { value: Expression; keys: readonly string[] }[] = [
    { value: options, keys: ['type'] },
  ];
  const seen = new Set<Expression>();
  for (let source = pending.pop(); source !== undefined; source = pending.pop()) {
    const { value, keys } = source;
    if (seen.has(value)) continue;
    seen.add(value);
    const selected = blobOptions(value) ?? value;
    const sources = framedTypedObjectSources(selected, keys);
    if (sources !== undefined) {
      pending.push(...sources);
      // What an assign with a source no reader follows holds is what its type says, as written.
      if (!framedUnreadAssign(selected)) continue;
    }
    if (
      words.error(value, keys) ||
      (keys.length === 0 && framedArrayString(value, words, call.node))
    )
      return true;
  }
  return false;
}

/** Whole constant options aliases retain literal fields before an earlier exposure or write. */
function blobOptions(expression: Expression): Expression | undefined {
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
  return argumentArrayExposed(expression, aliases, undefined, false) ? undefined : value;
}
