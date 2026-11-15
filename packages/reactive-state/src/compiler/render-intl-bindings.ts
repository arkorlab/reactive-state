import {
  type Node,
  isBindingElement,
  isComputedPropertyName,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isObjectBindingPattern,
  isStringLiteral,
  isVariableDeclaration,
  isVariableStatement,
  type Expression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameBindingContainer } from './framed-bindings.ts';
import { freshIntlReceiver, wholeIntlConstant } from './render-intl-receivers.ts';

/** Native method captures retain only fresh, unchanged formatter sources at their original read. */

interface IntlBindingRead {
  readonly expression: Expression;
  readonly names: readonly string[];
}

/** A simple const object binding reads one native method without inventing a property-access node. */
export function intlBindingRead(
  node: Node,
  native: (callee: Expression, names: readonly string[]) => boolean,
): IntlBindingRead | undefined {
  if (!isBindingElement(node) || !isObjectBindingPattern(node.parent)) return undefined;
  const selected = frameBindingContainer(node);
  if (selected === undefined || selected.keys.length > 0) return undefined;
  const { binding } = selected;
  const statement = isVariableDeclaration(binding) ? binding.parent.parent : undefined;
  if (statement === undefined || !isVariableStatement(statement)) return undefined;
  if (!/^const\s/u.test(statement.declarationList.getText(statement.getSourceFile())))
    return undefined;
  const name = bindingMethodName(node.propertyName ?? node.name);
  if (name === undefined || binding.initializer === undefined) return undefined;
  const names = [name];
  const expression = binding.initializer;
  const source = freshIntlReceiver(expression, node);
  if (source === undefined || !native(source.expression, names)) return undefined;
  return { expression, names };
}

/** Computed binding keys retain literal strings and whole immutable literal-string aliases only. */
function bindingMethodName(node: Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (isIdentifier(node) || isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (!isComputedPropertyName(node)) return undefined;
  const seen = new Set<Node>();
  let value = unwrapped(node.expression);
  while (!seen.has(value)) {
    seen.add(value);
    if (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value)) return value.text;
    const binding = isIdentifier(value) ? wholeIntlConstant(value) : undefined;
    if (binding?.initializer === undefined) return undefined;
    value = unwrapped(binding.initializer);
  }
  return undefined;
}
