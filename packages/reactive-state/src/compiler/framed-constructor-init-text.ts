import { type Expression, isNewExpression, type NewExpression, type Node } from 'typescript/ast';

import { framedInitHeaderIterable } from './framed-init-header-iterables.ts';
import {
  framedInitHeaderWords,
  framedInitTextValue,
  type InitTextWords,
  primitiveOtherOptions,
} from './framed-init-option-text.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedQuietInputs, framedQuietPrimitive } from './framed-native-evaluation.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedTextOptions } from './framed-text-options.ts';
import { framedQuietTextPrefix } from './framed-text-prefix.ts';

/** Native Request referrers and Request or Response headers retain source-known init text inputs. */

const REQUESTS = new Set(['Request']);
const CONSTRUCTORS = new Set(['Request', 'Response']);

/** Only direct native construction adds a proof; opaque wrappers and evaluated application work retain prior opacity. */
export function framedConstructorInitText(node: Node, words: InitTextWords): boolean {
  if (isNewExpression(node) && framedInitHeaderIterable(node, words)) return true;
  if (
    !isNewExpression(node) ||
    !framedNativeConstructor(node.expression, CONSTRUCTORS) ||
    !framedQuietTextPrefix(node, CONSTRUCTORS) ||
    !framedQuietInputs(node.arguments ?? [], CONSTRUCTORS)
  )
    return false;
  const prefix = framedArgumentPrefix(node, node.arguments ?? [], Infinity);
  if (prefix.unknown || prefix.alternatives !== undefined) return false;
  const first = prefix.values[0];
  const options = prefix.values[1];
  if (options === undefined || (first !== undefined && !framedQuietPrimitive(first))) return false;
  const fields = framedTextOptions(options, CONSTRUCTORS);
  if (fields === undefined) return false;
  const request = framedNativeConstructor(node.expression, REQUESTS);
  if (request && requestReferrerWords(fields, node, words)) return true;
  const headers = fields.get('headers');
  return (
    headers !== undefined &&
    primitiveOtherOptions(fields, 'headers') &&
    framedInitHeaderWords(headers, node, words, CONSTRUCTORS)
  );
}

/** Request referrer selection keeps its original quiet unselected-option conversion boundary. */
function requestReferrerWords(
  fields: ReadonlyMap<string, Expression>,
  call: NewExpression,
  words: InitTextWords,
): boolean {
  const referrer = fields.get('referrer');
  return (
    referrer !== undefined &&
    primitiveOtherOptions(fields, 'referrer') &&
    framedInitTextValue(referrer, call, words)
  );
}
