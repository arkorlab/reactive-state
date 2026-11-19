import {
  isTemplateExpression,
  type ParameterDeclaration,
  type TaggedTemplateExpression,
} from 'typescript/ast';

import { type Answering, isAnswering } from './answers.ts';
import {
  metadataArguments,
  metadataParameters,
  type MetadataSource,
  type PresentParameterArray,
  presentParameterArray,
  recordParameterArrays,
} from './input-bindings.ts';
import { metadataCallee } from './input-callees.ts';

/** A source tag receives a native strings array before the actual substitution values. */
export function metadataTag(
  tag: TaggedTemplateExpression,
  outer: MetadataSource['bindings'],
): { readonly fn: Answering; readonly bindings: MetadataSource['bindings'] } | undefined {
  const fn = metadataCallee(tag.tag);
  if (fn === undefined || !isAnswering(fn)) {
    return undefined;
  }
  const substitutions = isTemplateExpression(tag.template)
    ? tag.template.templateSpans.map((span) => span.expression)
    : [];
  const given = [tag.template, ...substitutions];
  const bindings = new Map(metadataArguments(fn, given, outer));
  const arrays = new Map<ParameterDeclaration, PresentParameterArray>();
  for (const [key] of outer) {
    const existing = presentParameterArray(outer, key);
    if (existing !== undefined) {
      arrays.set(key, existing);
    }
  }
  for (const [index, parameter] of metadataParameters(fn).entries()) {
    if (parameter.dotDotDotToken !== undefined) {
      // A fresh rest array may contain retained substitutions, so member writes stay unproven.
      bindings.delete(parameter);
      arrays.set(parameter, { entries: given.slice(index) });
    } else if (index === 0) {
      // The native strings array is always present and retains no input, so its default never executes.
      bindings.set(parameter, undefined);
      arrays.set(parameter, {
        entries: Array.from({ length: substitutions.length + 1 }, () => tag.template),
        template: true,
      });
    }
  }
  recordParameterArrays(bindings, arrays);
  return { bindings, fn };
}
