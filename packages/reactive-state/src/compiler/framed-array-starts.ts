import {
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isFunctionExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isTemplateExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';

/**
 * Whether a name may start as an array: its initializer is a written array, or a chain of names, the
 * parts a pattern selects among them, ends at one, or at anything the compile cannot read (a
 * parameter, a call). A chain that ends at a value that is no array (a string, a number, a function, an
 * object) starts as none.
 */
export function mayStartAsArray(binding: FrameBinding): boolean {
  const seen = new Set<FrameBinding>([binding]);
  let value: Expression | undefined = binding.initializer;
  while (value !== undefined) {
    const start = unwrapped(value);
    if (isArrayLiteralExpression(start)) return true;
    if (!isIdentifier(start)) return !isNoArray(start);
    const selected = frameBindingOf(start);
    if (selected === undefined) return start.text !== 'undefined';
    if (seen.has(selected.binding)) return true;
    seen.add(selected.binding);
    value = selectedValue(selected.binding.initializer, selected.keys);
  }
  return true;
}

/** Whether an expression is written as a value that is no array. */
function isNoArray(value: Expression): boolean {
  return (
    isStringLiteral(value) ||
    isNumericLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value) ||
    isTemplateExpression(value) ||
    isObjectLiteralExpression(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    value.kind === SyntaxKind.NullKeyword
  );
}

/** What a pattern selects from a written array or object, none where it cannot be read. */
function selectedValue(
  initializer: Expression | undefined,
  keys: readonly string[],
): Expression | undefined {
  let value = initializer === undefined ? undefined : unwrapped(initializer);
  for (const key of keys) {
    if (value === undefined) return undefined;
    value = selectedField(value, key);
  }
  return value;
}

/** The field or the element a written object or array has under the key. */
function selectedField(value: Expression, key: string): Expression | undefined {
  if (isArrayLiteralExpression(value)) {
    const element = value.elements.find((_, at) => String(at) === key);
    const spread = value.elements.some(
      (each) => isSpreadElement(each) || isOmittedExpression(each),
    );
    return element === undefined || spread ? undefined : unwrapped(element);
  }
  if (!isObjectLiteralExpression(value)) return undefined;
  const field = value.properties.findLast(
    (each) => !isSpreadAssignment(each) && writtenArrayKey(each.name) === key,
  );
  return field !== undefined && isPropertyAssignment(field)
    ? unwrapped(field.initializer)
    : undefined;
}
