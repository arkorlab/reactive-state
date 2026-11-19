import {
  type Expression,
  type Identifier,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isBindingElement,
  isComputedPropertyName,
  isElementAccessExpression,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadElement,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  type ObjectLiteralExpression,
  type PropertyName,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { bindingIdentifiers, isTypeOnly, readsBinding } from './scope.ts';

/** Fresh stored Date projections keep their original lexical and own-data identities. */

interface Projection {
  value: Expression;
  keys: readonly string[];
  projected: boolean;
  readonly bindings: Set<FrameBinding>;
  readonly allowed: Set<Identifier>;
}

interface ConversionSelection {
  readonly read: Expression;
  readonly whole: boolean;
}

/**
 * Only quiet literal holders and unchanged same-owner constants establish an added Date origin: of
 * `node`, or of what `keys` select within it, as a pattern within another takes it apart.
 */
export function localDateProjection(
  node: Expression,
  keys: readonly string[] = [],
  quietSource?: (value: Expression) => boolean,
  conversion?: ConversionSelection,
): boolean {
  const read = conversion?.read ?? node;
  const state: Projection = {
    value: node,
    keys,
    projected: keys.length > 0 || conversion?.whole === true,
    bindings: new Set(),
    allowed: new Set(),
  };
  const seen = new Set<Expression>();
  for (;;) {
    const value = unwrapped(state.value);
    if (seen.has(value)) return false;
    seen.add(value);
    if (
      (isObjectLiteralExpression(value) ||
        isArrayLiteralExpression(value) ||
        isNewExpression(value)) &&
      quietSource?.(value) === false
    )
      return false;
    const advanced = projectionStep(value, read, state);
    if (advanced === true) continue;
    return (
      advanced === undefined && state.projected && nativeDate(value) && stableBindings(read, state)
    );
  }
}

/** One original binding, member or literal position advances a finite source path. */
function projectionStep(
  value: Expression,
  read: Expression,
  state: Projection,
): boolean | undefined {
  if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const key = isPropertyAccessExpression(value)
      ? value.name.text
      : literalKey(value.argumentExpression);
    if (key === undefined) return false;
    state.keys = [key, ...state.keys];
    state.projected = true;
    state.value = value.expression;
    return true;
  }
  if (isIdentifier(value)) return followBinding(value, read, state);
  const [key, ...remaining] = state.keys;
  if (key === undefined) return undefined;
  const selected = literalEntry(value, key);
  if (selected === undefined) return false;
  state.keys = remaining;
  state.value = selected;
  return true;
}

/** Whole const aliases and simple destructuring retain original binding paths without substitution. */
function followBinding(name: Identifier, read: Expression, state: Projection): boolean {
  const selected = frameBindingOf(name);
  const binding = selected?.binding;
  if (
    binding === undefined ||
    !isVariableDeclaration(binding) ||
    !isVariableDeclarationList(binding.parent) ||
    binding.initializer === undefined ||
    state.bindings.has(binding) ||
    !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
    executionOwner(binding) !== executionOwner(read) ||
    !quietPattern(binding.name)
  )
    return false;
  state.bindings.add(binding);
  state.allowed.add(name);
  for (const declared of bindingIdentifiers(binding.name)) state.allowed.add(declared);
  state.keys = [...(selected?.keys ?? []), ...state.keys];
  state.projected ||= (selected?.keys.length ?? 0) > 0;
  state.value = binding.initializer;
  return true;
}

/** A native Date construction with primitive inputs cannot invoke a supplied conversion hook. */
function nativeDate(value: Expression): boolean {
  return (
    isNewExpression(value) &&
    globalPathOf(unwrapped(value.expression))?.join('.') === 'Date' &&
    (value.arguments ?? []).every((argument) => literalKey(argument) !== undefined)
  );
}

/** A fixed own data field or ordinary finite array position retains exactly one written source. */
function literalEntry(value: Expression, key: string): Expression | undefined {
  if (isObjectLiteralExpression(value)) return objectEntry(value, key);
  if (
    !isArrayLiteralExpression(value) ||
    !/^(?:0|[1-9]\d*)$/u.test(key) ||
    value.elements.some((element) => isSpreadElement(element))
  )
    return undefined;
  const element = value.elements[Number(key)];
  return element === undefined || isOmittedExpression(element) ? undefined : element;
}

/** Every holder field is plain own data; getters, spreads and prototype syntax remain opaque. */
function objectEntry(object: ObjectLiteralExpression, key: string): Expression | undefined {
  let found: Expression | undefined;
  for (const property of object.properties) {
    if (!isPropertyAssignment(property) && !isShorthandPropertyAssignment(property))
      return undefined;
    const name = propertyName(property.name);
    if (name === undefined || name === '__proto__') return undefined;
    if (name !== key) continue;
    if (isPropertyAssignment(property)) found = property.initializer;
    else if (isIdentifier(property.name)) found = property.name;
    else return undefined;
  }
  return found;
}

/** Literal property names and whole primitive const keys add no application evaluation. */
function propertyName(name: PropertyName): string | undefined {
  if (isComputedPropertyName(name)) return literalKey(name.expression);
  if (isIdentifier(name)) return name.text;
  return isNumericLiteral(name) ? String(Number(name.text)) : name.text;
}

/** Native primitive key conversion follows syntax and immutable aliases, never callable results. */
function literalKey(node: Expression): string | undefined {
  const value = literalSource(node);
  if (value === undefined) return undefined;
  if (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (isNumericLiteral(value)) return String(Number(value.text));
  if (isPrefixUnaryExpression(value)) {
    const operand = unwrapped(value.operand);
    if (!isNumericLiteral(operand)) return undefined;
    if (value.operator === SyntaxKind.PlusToken) return String(Number(operand.text));
    if (value.operator === SyntaxKind.MinusToken) return String(-Number(operand.text));
  }
  if (value.kind === SyntaxKind.TrueKeyword) return 'true';
  if (value.kind === SyntaxKind.FalseKeyword) return 'false';
  if (value.kind === SyntaxKind.NullKeyword) return 'null';
  return globalPathOf(value)?.join('.') === 'undefined' ? 'undefined' : undefined;
}

/** Whole primitive alias resolution retains declaration scope and stops on cycles. */
function literalSource(node: Expression): Expression | undefined {
  let value = unwrapped(node);
  const seen = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    if (globalPathOf(value)?.join('.') === 'undefined') return value;
    const source = constantKeySource(value);
    if (source === undefined || seen.has(source.binding)) return undefined;
    seen.add(source.binding);
    value = unwrapped(source.value);
  }
  return value;
}

/** Only a whole immutable variable supplies a key initializer. */
function constantKeySource(
  name: Identifier,
): { readonly binding: FrameBinding; readonly value: Expression } | undefined {
  const selected = frameBindingOf(name);
  const binding = selected?.binding;
  return binding !== undefined &&
    isVariableDeclaration(binding) &&
    isIdentifier(binding.name) &&
    isVariableDeclarationList(binding.parent) &&
    binding.initializer !== undefined &&
    selected?.keys.length === 0 &&
    /^const\b/u.test(binding.parent.getText(binding.getSourceFile()))
    ? { binding, value: binding.initializer }
    : undefined;
}

/** No default, rest or effectful computed binding name can precede a selected destructured value. */
function quietPattern(name: Node): boolean {
  const pending = [name];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isIdentifier(node) || isOmittedExpression(node)) continue;
    if (isObjectBindingPattern(node) || isArrayBindingPattern(node)) pending.push(...node.elements);
    else if (isBindingElement(node)) {
      if (
        node.name === undefined ||
        node.initializer !== undefined ||
        node.dotDotDotToken !== undefined ||
        (node.propertyName !== undefined && propertyName(node.propertyName) === undefined)
      )
        return false;
      pending.push(node.name);
    } else return false;
  }
  return true;
}

/** Prior non-wiring reads or captured uses can replace a holder or a selected instance's own method. */
function stableBindings(read: Expression, state: Projection): boolean {
  const pending: Node[] = [read.getSourceFile()];
  const owner = executionOwner(read);
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isIdentifier(node) && readsBinding(node) && !state.allowed.has(node)) {
      const binding = frameBindingOf(node)?.binding;
      if (
        binding !== undefined &&
        state.bindings.has(binding) &&
        node !== binding.name &&
        (executionOwner(node) !== owner || node.pos < read.pos)
      )
        return false;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}
