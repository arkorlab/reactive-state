import {
  type BinaryExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isCallExpression,
  isBinaryExpression,
  isExpressionStatement,
  isNewExpression,
  isElementAccessExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { memberPath } from './exported-values.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { argumentArrayExposed } from './framed-array-selections.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { targetsOf } from './kept.ts';
import { writtenBy } from './written.ts';

/** An unchanged own-data literal holder retains its selected original collection identity. */

interface LiteralCollection {
  readonly value: Expression;
  readonly references: readonly Identifier[];
}

interface AliasSource {
  readonly value: Expression;
  readonly aliases: ReadonlySet<FrameBinding>;
  readonly references: readonly Identifier[];
}

interface Projection {
  readonly seen: Set<Node>;
  readonly references: Identifier[];
  readonly keys: string[];
  projected: boolean;
  value: Expression;
}

/** Whole const names and fixed own literal paths retain only collections, never primitive copies. */
export function middlewareLiteralCollection(expression: Expression): LiteralCollection | undefined {
  const state: Projection = {
    seen: new Set(),
    references: [],
    keys: [],
    projected: false,
    value: unwrapped(expression),
  };
  for (;;) {
    const path = memberPath(state.value);
    state.keys.unshift(...path.keys);
    const value = path.root;
    if (isIdentifier(value)) {
      if (!followAlias(value, state)) return undefined;
      continue;
    }
    const key = state.keys.shift();
    if (key === undefined)
      return state.projected &&
        (isObjectLiteralExpression(value) || isArrayLiteralExpression(value))
        ? { value, references: state.references }
        : undefined;
    const selected = ownLiteralMember(value, key);
    if (selected === undefined) return undefined;
    state.projected = true;
    state.value = unwrapped(selected);
  }
}

/** A known alias and its one replacement retain each original node and remaining path. */
function followAlias(reference: Identifier, state: Projection): boolean {
  const source = constantAliases(reference, state.seen);
  if (source === undefined) return false;
  const replacement =
    state.keys.length > 0 ? fieldReplacement(reference, source.aliases, state.keys) : undefined;
  if (state.keys.length > 0 && !unchangedHolder(reference, source, state.keys, replacement))
    return false;
  state.references.push(...source.references);
  if (replacement !== undefined) {
    state.keys.length = 0;
    state.projected = true;
  }
  state.value = unwrapped(replacement?.right ?? source.value);
  return true;
}

/** A whole const chain keeps each original reference and its literal capture expression. */
function constantAliases(reference: Identifier, seen: Set<Node>): AliasSource | undefined {
  const aliases = new Set<FrameBinding>();
  const references: Identifier[] = [];
  let value: Expression = reference;
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    const binding = selected?.binding;
    if (
      binding === undefined ||
      selected?.keys.length !== 0 ||
      seen.has(binding) ||
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return undefined;
    seen.add(binding);
    aliases.add(binding);
    references.push(value);
    value = unwrapped(binding.initializer);
  }
  return { value, aliases, references };
}

/** A holder read uses its original position; selected payload captures survive later wrapper replacement. */
function unchangedHolder(
  reference: Identifier,
  source: AliasSource,
  keys: readonly string[],
  replacement?: BinaryExpression,
): boolean {
  const literal = unwrapped(source.value);
  if (!isObjectLiteralExpression(literal) && !isArrayLiteralExpression(literal)) return false;
  return !argumentArrayExposed(reference, source.aliases, (name) =>
    holderRead(name, keys, literal, replacement),
  );
}

/** Other own fields remain independent, while selected slots and array length retain their exposure guard. */
function holderRead(
  reference: Identifier,
  keys: readonly string[],
  literal: Expression,
  replacement: BinaryExpression | undefined,
): boolean {
  let current: Expression = reference;
  let container: Expression | undefined = literal;
  for (const expected of keys) {
    const parent = useOf(current).parent;
    if (
      (!isPropertyAccessExpression(parent) && !isElementAccessExpression(parent)) ||
      unwrapped(parent.expression) !== unwrapped(current)
    )
      return false;
    const key = frameMemberName(parent);
    if (key === undefined) return false;
    if (key !== expected) {
      return (
        !isInvocation(parent) &&
        (key !== 'length' ||
          (container !== undefined && !isArrayLiteralExpression(container)) ||
          !replacesValue(parent))
      );
    }
    container = container === undefined ? undefined : ownLiteralMember(container, expected);
    current = parent;
  }
  const parent = useOf(current).parent;
  return (isBinaryExpression(parent) && parent === replacement) || !replacesValue(current);
}

/** One completed direct assignment keeps its original RHS; branches and multiple writes stay opaque. */
function fieldReplacement(
  reference: Identifier,
  aliases: ReadonlySet<FrameBinding>,
  keys: readonly string[],
): BinaryExpression | undefined {
  const owner = executionOwner(reference);
  if (!isAnswering(owner) || owner.body === undefined) return undefined;
  const found: BinaryExpression[] = [];
  const pending: Node[] = [reference.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isBinaryExpression(node) && node.end <= reference.pos) {
      const target = memberPath(node.left);
      const binding = isIdentifier(target.root) ? frameBindingOf(target.root)?.binding : undefined;
      if (
        binding !== undefined &&
        node.operatorToken.kind === SyntaxKind.EqualsToken &&
        isExpressionStatement(node.parent) &&
        node.parent.parent === owner.body &&
        aliases.has(binding) &&
        target.keys.length === keys.length &&
        target.keys.every((key, index) => key === keys[index])
      )
        found.push(node);
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return found.length === 1 ? found[0] : undefined;
}

/** Passing a whole literal holder also hands its retained payloads to the existing callee analysis. */
export function middlewareLiteralContents(expression: Expression): readonly Expression[] {
  const value = unwrapped(expression);
  const source = isIdentifier(value) ? constantAliases(value, new Set()) : undefined;
  if (source === undefined && isIdentifier(value)) return [];
  const projected = middlewareLiteralCollection(expression);
  const literal = unwrapped(projected?.value ?? source?.value ?? value);
  const fields = literalFields(literal);
  if (fields === undefined) return [];
  const contents: Expression[] = [];
  for (const [key, original] of fields) {
    const replacement =
      source !== undefined && isIdentifier(value)
        ? fieldReplacement(value, source.aliases, [key])
        : undefined;
    if (
      replacement !== undefined &&
      source !== undefined &&
      isIdentifier(value) &&
      unchangedHolder(value, source, [key], replacement)
    )
      contents.push(replacement.right);
    else {
      contents.push(original);
      if (replacement !== undefined) contents.push(replacement.right);
    }
  }
  return contents;
}

/** Closed own-data fields retain their overwrite order without invoking getters or computed keys. */
function literalFields(value: Expression): ReadonlyMap<string, Expression> | undefined {
  if (isArrayLiteralExpression(value)) {
    if (value.elements.some((each) => isSpreadElement(each) || isOmittedExpression(each)))
      return undefined;
    return new Map(value.elements.map((each, index) => [String(index), each]));
  }
  if (!isObjectLiteralExpression(value)) return undefined;
  const fields = new Map<string, Expression>();
  for (const property of value.properties) {
    if (
      (!isPropertyAssignment(property) && !isShorthandPropertyAssignment(property)) ||
      !isIdentifier(property.name) ||
      property.name.text === '__proto__'
    )
      return undefined;
    fields.set(
      property.name.text,
      isPropertyAssignment(property) ? property.initializer : property.name,
    );
  }
  return fields;
}

/** A method call can mutate or expose a wrapper even when its member name differs. */
function isInvocation(value: Expression): boolean {
  const parent = useOf(value).parent;
  return isCallExpression(parent) || isNewExpression(parent);
}

/** A direct assignment, count or deletion changes the retained holder field itself. */
function replacesValue(expression: Expression): boolean {
  const write = writtenBy(useOf(expression).parent);
  return (
    write !== undefined &&
    targetsOf(write).some((target) => unwrapped(target as Expression) === unwrapped(expression))
  );
}

/** Only own identifier-named data and fixed dense slots add this holder proof. */
function ownLiteralMember(value: Expression, name: string): Expression | undefined {
  const literal = unwrapped(value);
  if (isObjectLiteralExpression(literal)) return literalFields(literal)?.get(name);
  if (!isArrayLiteralExpression(literal)) return undefined;
  if (literal.elements.some((element) => isSpreadElement(element))) return undefined;
  const index = Number(name);
  const element = literal.elements[index];
  return element !== undefined && String(index) === name && !isOmittedExpression(element)
    ? element
    : undefined;
}
