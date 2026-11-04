import {
  type Expression,
  isIdentifier,
  isVariableDeclaration,
  isVariableDeclarationList,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { framedPrefixSameOwner } from './framed-native-prefix.ts';

/** A proved quiet callback's whole local constants retain their original input binding. */
export function framedGroupByOwnedInput(source: Expression, returned: Expression): Expression {
  let value = unwrapped(source);
  const seen = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0 || seen.has(selected.binding))
      return value;
    const { binding } = selected;
    if (
      !framedPrefixSameOwner(binding, returned) ||
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return value;
    seen.add(binding);
    value = unwrapped(binding.initializer);
  }
  return value;
}
