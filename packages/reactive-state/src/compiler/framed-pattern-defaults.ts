import {
  type Expression,
  type Identifier,
  isArrayBindingPattern,
  isBindingElement,
} from 'typescript/ast';

import { frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { framedDescriptorEntries } from './framed-descriptor-entries.ts';
import { bindingIdentifiers } from './scope.ts';

/** Written defaults that can supply a selected pattern binding, retaining its member path. */
export function framedPatternDefaults(
  name: Identifier,
  binding: FrameBinding,
): readonly Expression[] | undefined {
  const bound = bindingIdentifiers(binding.name).find((each) => each.text === name.text);
  if (bound === undefined || !isBindingElement(bound.parent)) return [];
  const values: Expression[] = [];
  let element = bound.parent;
  let keys: readonly string[] = [];
  for (;;) {
    if (element.initializer !== undefined) {
      const selected = defaultValues(element.initializer, keys);
      if (selected === undefined) return undefined;
      values.push(...selected);
    }
    const pattern = element.parent;
    const owner = pattern.parent;
    if (!isBindingElement(owner)) return values;
    const key = isArrayBindingPattern(pattern)
      ? String(pattern.elements.indexOf(element))
      : frameMemberName(element);
    if (key === undefined) return undefined;
    keys = [key, ...keys];
    element = owner;
  }
}

/** Literal data entries preserve nested defaults; opaque projections retain the old fallback. */
function defaultValues(
  value: Expression,
  keys: readonly string[],
): readonly Expression[] | undefined {
  let values: readonly Expression[] = [value];
  for (const key of keys) {
    const selected: Expression[] = [];
    for (const each of values) {
      const entries = framedDescriptorEntries(each, [key]);
      if (entries === undefined || entries.length === 0) return undefined;
      selected.push(...entries);
    }
    values = selected;
  }
  return values;
}
