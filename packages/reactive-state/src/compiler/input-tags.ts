import { isTemplateExpression, type TaggedTemplateExpression } from 'typescript/ast';

import { type Answering, isAnswering } from './answers.ts';
import { metadataArguments, metadataParameters, type MetadataSource } from './input-bindings.ts';
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
  const bindings = new Map(metadataArguments(fn, [tag.template, ...substitutions], outer));
  for (const [index, parameter] of metadataParameters(fn).entries()) {
    if (parameter.dotDotDotToken !== undefined) {
      // A fresh rest array may contain retained substitutions, so member writes stay unproven.
      bindings.delete(parameter);
    } else if (index === 0) {
      // The native strings array is always present and retains no input, so its default never executes.
      bindings.set(parameter, undefined);
    }
  }
  return { bindings, fn };
}
