import {
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isCallExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isExpression,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isReturnStatement,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVoidExpression,
  type Node,
  type ObjectLiteralExpression,
  type SpreadAssignment,
  type VariableDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf, useOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { unreferencedLocalFunction } from './framed-function-references.ts';
import { framedPrefixSameOwner } from './framed-native-prefix.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** Only added nullish forwarding uses the original observation's alias and exposure proof. */
export interface ProxyNullishRead {
  readonly proxy: Expression;
  readonly target: Expression;
  readonly handler: Expression;
  readonly point?: Node | undefined;
}

interface Sources {
  readonly bindings: Set<FrameBinding>;
  readonly selected: Set<Identifier>;
  readonly roots: Set<Expression>;
  readonly created: Set<Expression>;
}

/** A fresh native Proxy retains an absent get trap only before its carried objects can change. */
export function framedNullishProxyStable(read: ProxyNullishRead): boolean {
  const { point } = read;
  if (point === undefined || assignmentOnly(point)) return false;
  const sources: Sources = {
    bindings: new Set(),
    selected: new Set(),
    roots: new Set(),
    created: new Set(),
  };
  const proxy = wholeSource(read.proxy, sources, point);
  if (proxy === undefined || !creationContext(proxy, point)) return false;
  sources.roots.add(proxy);
  if (!quietCreation(read.target, sources, point) || !quietCreation(read.handler, sources, point))
    return false;
  const args = proxyArguments(proxy);
  if (args === undefined || args.slice(2).some((each) => !quietCreation(each, sources, point)))
    return false;
  collectAliases(sources, point);
  const pending: Node[] = [point.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isIdentifier(node) && exposed(node, sources, point)) return false;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** Whole const aliases and original parameter objects retain lexical binding identity. */
function wholeSource(value: Expression, sources: Sources, point: Node): Expression | undefined {
  let node = unwrapped(value);
  const seen = new Set<FrameBinding>();
  while (isIdentifier(node) && !primitive(node)) {
    const selected = frameBindingOf(node);
    if (selected === undefined || selected.keys.length > 0 || seen.has(selected.binding))
      return undefined;
    const { binding } = selected;
    if (!framedPrefixSameOwner(binding, point)) return undefined;
    sources.bindings.add(binding);
    sources.selected.add(node);
    seen.add(binding);
    if (isParameterDeclaration(binding))
      return binding.initializer === undefined ? node : undefined;
    if (!wholeConstant(binding) || binding.initializer === undefined) return undefined;
    node = unwrapped(binding.initializer);
  }
  sources.roots.add(node);
  return node;
}

/** Literal creation stores selected reads; deferred callable bodies supply no exemptions. */
function quietCreation(value: Expression, sources: Sources, point: Node): boolean {
  const pending: (Expression | SpreadAssignment)[] = [value];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    const inputs = creationInputs(each, sources, point);
    if (inputs === undefined) return false;
    pending.push(...inputs);
  }
  return true;
}

/** One creation step contributes only its original literal evaluation operands. */
function creationInputs(
  each: Expression | SpreadAssignment,
  sources: Sources,
  point: Node,
): readonly (Expression | SpreadAssignment)[] | undefined {
  if (isSpreadElement(each) || isSpreadAssignment(each)) {
    const source = wholeSource(each.expression, sources, point);
    if (
      source === undefined ||
      (isSpreadElement(each)
        ? !isArrayLiteralExpression(source)
        : !isObjectLiteralExpression(source))
    )
      return undefined;
    return [source];
  }
  if (primitive(each)) return [];
  const node = wholeSource(each, sources, point);
  if (node === undefined) return undefined;
  if (sources.created.has(node)) return [];
  sources.created.add(node);
  if (creationAtom(node)) return [];
  if (isArrayLiteralExpression(node)) return node.elements;
  return isObjectLiteralExpression(node) ? literalInputs(node) : undefined;
}

/** Primitive reads and fresh Errors with primitive constructor inputs run no conversion hook. */
function creationAtom(node: Expression): boolean {
  return (
    primitive(node) ||
    isIdentifier(node) ||
    isOmittedExpression(node) ||
    isArrowFunction(node) ||
    isFunctionExpression(node) ||
    (isVoidExpression(node) && primitive(node.expression)) ||
    (isNewExpression(node) &&
      framedNativeConstructor(node.expression, STANDARD_ERRORS) &&
      (node.arguments ?? []).every((each) => primitive(each)))
  );
}

/** Accessors that a spread or the native trap lookup can invoke have one quiet direct result. */
function literalInputs(
  node: ObjectLiteralExpression,
): readonly (Expression | SpreadAssignment)[] | undefined {
  const values: (Expression | SpreadAssignment)[] = [];
  for (const field of node.properties) {
    if (isSpreadAssignment(field)) {
      values.push(field);
      continue;
    }
    const key = writtenArrayKey(field.name);
    if (key === undefined || key === '__proto__') return undefined;
    if (isPropertyAssignment(field)) values.push(field.initializer);
    else if (isShorthandPropertyAssignment(field) && isIdentifier(field.name))
      values.push(field.name);
    else if (isGetAccessorDeclaration(field)) {
      const first = field.body?.statements[0];
      if (
        first === undefined ||
        field.body?.statements.length !== 1 ||
        !isReturnStatement(first) ||
        first.expression === undefined
      )
        return undefined;
      values.push(first.expression);
    } else if (!isMethodDeclaration(field) && !isSetAccessorDeclaration(field)) return undefined;
  }
  return values;
}

/** Immutable primitive aliases carry no mutable object beyond the observation's owner. */
function primitive(value: Expression): boolean {
  let node = unwrapped(value);
  const seen = new Set<FrameBinding>();
  while (isIdentifier(node)) {
    if (globalPathOf(node)?.join('.') === 'undefined') return true;
    const selected = frameBindingOf(node);
    if (
      selected === undefined ||
      selected.keys.length > 0 ||
      seen.has(selected.binding) ||
      !wholeConstant(selected.binding) ||
      selected.binding.initializer === undefined
    )
      return false;
    seen.add(selected.binding);
    node = unwrapped(selected.binding.initializer);
  }
  return (
    isNumericLiteral(node) ||
    isStringLiteral(node) ||
    isNoSubstitutionTemplateLiteral(node) ||
    [SyntaxKind.FalseKeyword, SyntaxKind.NullKeyword, SyntaxKind.TrueKeyword].includes(node.kind) ||
    globalPathOf(node)?.join('.') === 'undefined'
  );
}

/** A saved native result is initialized whole; a direct observation follows only member receivers. */
function creationContext(value: Expression, point: Node): boolean {
  let node: Node = value;
  for (;;) {
    if (node === point) return true;
    const use = useOf(node);
    if (
      isVariableDeclaration(use.parent) &&
      isExpression(use.at) &&
      use.parent.initializer === use.at
    )
      return wholeConstant(use.parent) && framedPrefixSameOwner(use.parent, point);
    if (
      (isPropertyAccessExpression(use.parent) || isElementAccessExpression(use.parent)) &&
      use.parent.expression === use.at
    ) {
      node = use.parent;
      continue;
    }
    return false;
  }
}

/** The full original constructor or revocable argument list includes ignored trailing work. */
function proxyArguments(value: Expression): readonly Expression[] | undefined {
  if (isNewExpression(value)) return value.arguments ?? [];
  if (
    (isPropertyAccessExpression(value) || isElementAccessExpression(value)) &&
    isCallExpression(unwrapped(value.expression))
  ) {
    const call = unwrapped(value.expression);
    return isCallExpression(call) ? call.arguments : undefined;
  }
  return undefined;
}

/** Connected whole aliases retain the same original object, including saved Proxy results. */
function collectAliases(sources: Sources, point: Node): void {
  const pending: Node[] = [point.getSourceFile()];
  const declarations: VariableDeclaration[] = [];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isVariableDeclaration(node)) declarations.push(node);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  declarations.sort((first, second) => first.pos - second.pos);
  for (const declaration of declarations) {
    if (
      !wholeConstant(declaration) ||
      declaration.initializer === undefined ||
      !framedPrefixSameOwner(declaration, point)
    )
      continue;
    const value = unwrapped(declaration.initializer);
    const selected = isIdentifier(value) ? frameBindingOf(value) : undefined;
    if (
      !sources.roots.has(value) &&
      (selected === undefined || !sources.bindings.has(selected.binding))
    )
      continue;
    sources.bindings.add(declaration);
    if (isIdentifier(value)) sources.selected.add(value);
  }
}

/** The Node point also covers destructuring observations; no synthetic expression or position is used. */
function exposed(name: Identifier, sources: Sources, point: Node): boolean {
  if (!readsBinding(name) || sources.selected.has(name)) return false;
  const selected = frameBindingOf(name);
  if (
    selected === undefined ||
    name === selected.binding.name ||
    !sources.bindings.has(selected.binding)
  )
    return false;
  const reader = executionOwner(point);
  const owner = executionOwner(name);
  if (owner === reader) {
    if (
      (name.pos >= point.end || destructuredFirst(point, name)) &&
      !repeatedFrameRead(name, point, selected.binding, reader)
    )
      return false;
    if (observationReceiver(name, point)) return false;
  } else if (unreferencedLocalFunction(owner, reader)) return false;
  return framedPossibleBranch(name);
}

/** The actual member receiver is a read; a computed key or argument handoff is not exempt. */
function observationReceiver(name: Identifier, point: Node): boolean {
  let node: Node = name;
  for (;;) {
    if (node === point) return true;
    const use = useOf(node);
    if (
      (isPropertyAccessExpression(use.parent) || isElementAccessExpression(use.parent)) &&
      use.parent.expression === use.at
    )
      node = use.parent;
    else return false;
  }
}

/** A simple assignment or deletion does not itself read the member's old value. */
function assignmentOnly(point: Node): boolean {
  const use = useOf(point);
  return (
    (isBinaryExpression(use.parent) &&
      use.parent.operatorToken.kind === SyntaxKind.EqualsToken &&
      use.parent.left === use.at) ||
    isDeleteExpression(use.parent)
  );
}

/** Only whole immutable local declarations establish an object alias. */
function wholeConstant(binding: FrameBinding): binding is VariableDeclaration {
  return (
    isVariableDeclaration(binding) &&
    isIdentifier(binding.name) &&
    isVariableDeclarationList(binding.parent) &&
    /^const\b/u.test(binding.parent.getText(binding.getSourceFile()))
  );
}
