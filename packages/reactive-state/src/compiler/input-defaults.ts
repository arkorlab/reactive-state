import {
  type BindingName,
  type Expression,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isBindingElement,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isSpreadElement,
  isStringLiteral,
  type Node,
  type ParameterDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import {
  definedArgument,
  metadataParameters,
  type MetadataSource,
  omittedArgument,
  parameterSources,
  presentParameterArray,
  selected,
} from './input-bindings.ts';
import { metadataInitializer } from './input-callees.ts';

/** Parameter defaults selected by known argument projections, with unknown projections conservative. */

interface Selection {
  readonly value: Expression | undefined;
  readonly unknown: boolean;
  readonly present?: boolean;
  readonly entries?: readonly Expression[];
  readonly template?: boolean;
}
interface Reading {
  readonly bindings: MetadataSource['bindings'];
  readonly found: Expression[];
}
const UNKNOWN: Selection = { unknown: true, value: undefined };
const PRESENT: Selection = { present: true, unknown: true, value: undefined };

/** Selected parameter and pattern defaults, including possible defaults of unknown projections. */
export function metadataDefaults(
  fn: { readonly parameters: readonly ParameterDeclaration[] },
  bindings: MetadataSource['bindings'],
): Expression[] {
  const found: Expression[] = [];
  const reading: Reading = { bindings, found };
  for (const parameter of metadataParameters(fn)) {
    const selectedValue = withDefault(
      parameterSelection(parameter, bindings),
      parameter.initializer,
      reading,
    );
    if (!bindingDefaults(parameter.name, selectedValue, reading)) {
      break;
    }
  }
  return found;
}

/** A parameter's pre-default selection, keeping present rest and template string arrays. */
function parameterSelection(
  parameter: ParameterDeclaration,
  bindings: MetadataSource['bindings'],
): Selection {
  const array = presentParameterArray(bindings, parameter);
  if (array !== undefined) {
    return {
      entries: array.entries,
      present: true,
      template: array.template === true,
      unknown: false,
      value: undefined,
    };
  }
  const actual = bindings.get(parameter);
  if (
    actual === undefined ||
    (parameter.initializer !== undefined && actual === parameter.initializer)
  ) {
    return { unknown: false, value: undefined };
  }
  return defaultValue(actual, bindings);
}

/** A pattern's selected fields or entries, stopping before nested nullish destructuring throws. */
function bindingDefaults(binding: BindingName, actual: Selection, reading: Reading): boolean {
  if (isIdentifier(binding)) {
    return true;
  }
  if (nullishSelection(actual, reading.bindings)) {
    return false;
  }
  for (const [index, element] of binding.elements.entries()) {
    if (!isBindingElement(element) || element.name === undefined) {
      continue;
    }
    const key = isArrayBindingPattern(binding)
      ? String(index)
      : propertyName(element.propertyName ?? element.name);
    const value =
      element.dotDotDotToken === undefined
        ? selectedDefault(actual, key, reading.bindings)
        : restSelection(actual, index, reading.bindings);
    if (!bindingDefaults(element.name, withDefault(value, element.initializer, reading), reading)) {
      return false;
    }
  }
  return true;
}

/** A known nullish value throws before its pattern can initialize any binding. */
function nullishSelection(actual: Selection, bindings: MetadataSource['bindings']): boolean {
  if (actual.unknown || actual.entries !== undefined) {
    return false;
  }
  if (actual.value === undefined || omittedArgument(actual.value, bindings)) {
    return true;
  }
  const value = defaultValue(actual.value, bindings);
  return !value.unknown && value.value?.kind === SyntaxKind.NullKeyword;
}

/** Whether a selected value is proven defined so its binding fallback cannot run. */
function definedSelection(value: Selection, bindings: MetadataSource['bindings']): boolean {
  if (value.present === true || value.entries !== undefined) {
    return true;
  }
  if (value.unknown) {
    return false;
  }
  return definedArgument(value.value, bindings);
}

/** A missing binding selects its fallback; an unknown selection may execute that fallback too. */
function withDefault(
  value: Selection,
  initializer: Expression | undefined,
  reading: Reading,
): Selection {
  const omitted =
    value.present !== true &&
    value.entries === undefined &&
    !value.unknown &&
    omittedArgument(value.value, reading.bindings);
  if (omitted) {
    if (initializer !== undefined) {
      reading.found.push(initializer);
    }
    return initializer === undefined
      ? { unknown: false, value: undefined }
      : defaultValue(initializer, reading.bindings);
  }
  if (initializer === undefined || definedSelection(value, reading.bindings)) {
    return value;
  }
  reading.found.push(initializer);
  return UNKNOWN;
}

/** A known own selection, or a present language-inherited member whose value is not interpreted. */
function selectedDefault(
  actual: Selection,
  key: string | undefined,
  bindings: MetadataSource['bindings'],
): Selection {
  if (key === undefined || actual.unknown) {
    return UNKNOWN;
  }
  const value = actual.value === undefined ? undefined : defaultValue(actual.value, bindings).value;
  const array =
    actual.entries ??
    (value !== undefined && isArrayLiteralExpression(value) ? value.elements : undefined);
  if (array !== undefined) {
    return arraySelection(actual, array, key);
  }
  const picked = selected(actual.value, key);
  if (
    value !== undefined &&
    picked.value === undefined &&
    !picked.unknown &&
    Object.hasOwn(Object.prototype, key) &&
    isObjectLiteralExpression(value) &&
    !value.properties.some(
      (property) => isPropertyAssignment(property) && propertyName(property.name) === '__proto__',
    )
  ) {
    return PRESENT;
  }
  return picked;
}

/** An indexed or inherited property read from a known array or template strings list. */
function arraySelection(actual: Selection, array: readonly Expression[], key: string): Selection {
  if (array.some((entry) => isSpreadElement(entry))) {
    return UNKNOWN;
  }
  if (actual.template === true && key === 'raw') {
    return { entries: array, present: true, unknown: false, value: undefined };
  }
  if (
    key === 'length' ||
    Object.hasOwn(Array.prototype, key) ||
    Object.hasOwn(Object.prototype, key)
  ) {
    return PRESENT;
  }
  const index = Number(key);
  const entry = String(index) === key ? array[index] : undefined;
  return {
    unknown: false,
    value: entry === undefined || isOmittedExpression(entry) ? undefined : entry,
  };
}

/** Rest arrays retain their known entries for nested patterns without pretending entries are fresh. */
function restSelection(
  actual: Selection,
  index: number,
  bindings: MetadataSource['bindings'],
): Selection {
  if (actual.unknown) {
    return UNKNOWN;
  }
  const value = actual.value === undefined ? undefined : defaultValue(actual.value, bindings).value;
  const entries =
    actual.entries ??
    (value !== undefined && isArrayLiteralExpression(value) ? value.elements : undefined);
  return entries === undefined || entries.some((entry) => isSpreadElement(entry))
    ? UNKNOWN
    : { entries: entries.slice(index), unknown: false, value: actual.value };
}

/** An actual value through constant and parameter aliases, leaving fresh rest shapes unknown. */
function defaultValue(node: Expression, bindings: MetadataSource['bindings']): Selection {
  const seen = new Set<Expression>();
  let value = unwrapped(node);
  while (isIdentifier(value)) {
    if (seen.has(value)) {
      return UNKNOWN;
    }
    seen.add(value);
    const parameter = parameterSources(value, { bindings, value });
    if (parameter?.present === true) {
      return PRESENT;
    }
    const only = parameter?.sources?.length === 1 ? parameter.sources[0]?.value : undefined;
    const next = parameter === undefined ? metadataInitializer(value) : only;
    if (next === undefined) {
      return UNKNOWN;
    }
    value = unwrapped(next);
  }
  return { unknown: false, value };
}

/** A binding member named without evaluating application code. */
function propertyName(node: Node): string | undefined {
  return isIdentifier(node) || isStringLiteral(node) ? node.text : undefined;
}
