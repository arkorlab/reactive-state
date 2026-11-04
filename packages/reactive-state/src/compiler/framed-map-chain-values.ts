import {
  type CallExpression,
  type Expression,
  type Identifier,
  isComputedPropertyName,
  isForInStatement,
  isForOfStatement,
  isParameterDeclaration,
  isIdentifier,
  isElementAccessExpression,
  isPropertyAccessExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPrefixUnaryExpression,
  isPropertyAssignment,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf, useOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { unreferencedLocalFunction } from './framed-function-references.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { framedNativeArguments } from './framed-native-arguments.ts';
import { framedAssignedValues, framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** Finite borrowed native Map chains retain written values even without a fresh construction. */

const GETTERS = new Set(['Map.prototype.get']);
const SETTERS = new Set(['Map.prototype.set']);
const TAIL = { reflect: 3 } as const;

/** Possible intervening runtime work invalidates a saved borrowed chain's source-only proof. */
const EFFECTS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AwaitExpression,
  SyntaxKind.BinaryExpression,
  SyntaxKind.CallExpression,
  SyntaxKind.DeleteExpression,
  SyntaxKind.ElementAccessExpression,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.NewExpression,
  SyntaxKind.PostfixUnaryExpression,
  SyntaxKind.PrefixUnaryExpression,
  SyntaxKind.PropertyAccessExpression,
  SyntaxKind.SpreadAssignment,
  SyntaxKind.SpreadElement,
  SyntaxKind.TaggedTemplateExpression,
  SyntaxKind.YieldExpression,
]);

/** Native borrowed links retain possible last writes, without claiming a complete supplied collection. */
export function framedMapChainValues(
  read: CallExpression,
  sets: readonly CallExpression[],
): readonly Expression[] | undefined {
  const given = quietNativeArguments(read, GETTERS);
  if (given === undefined || !chainUnchanged(read, sets)) return undefined;
  const links = nativeLinks(sets);
  return links === undefined ? undefined : selectedChainValues(links, chainKey(given[0]));
}

/** Each consumed native set link keeps its complete evaluated argument list. */
function nativeLinks(
  sets: readonly CallExpression[],
): readonly (readonly Expression[])[] | undefined {
  const links: (readonly Expression[])[] = [];
  for (const call of sets) {
    const args = quietNativeArguments(call, SETTERS);
    if (args === undefined) return undefined;
    links.push(args);
  }
  return links;
}

/** Outer primitive-key writes hide only matching inner writes; unknown keys retain alternatives. */
function selectedChainValues(
  links: readonly (readonly Expression[])[],
  wanted: string | undefined,
): readonly Expression[] | undefined {
  const hidden = new Set<string>();
  const values: Expression[] = [];
  const allowed = new Set<Expression>();
  for (const args of links) {
    const value = args[1];
    if (value !== undefined) allowed.add(unwrapped(value));
  }
  for (const args of links) {
    const key = chainKey(args[0]);
    if (hiddenKey(key, hidden)) continue;
    if (wanted !== undefined && key !== undefined && wanted !== key) continue;
    if (!pushCarried(values, args[1], allowed)) return undefined;
    if (wanted !== undefined && wanted === key) return values;
  }
  return values;
}

/** An exposed carried binding keeps the existing opaque projection instead of asserting Error identity. */
function pushCarried(
  values: Expression[],
  value: Expression | undefined,
  allowed: ReadonlySet<Expression>,
): boolean {
  if (value === undefined) return true;
  if (!carriedUnexposed(value, allowed)) return false;
  values.push(value);
  return true;
}

/** A parameter and whole constant aliases retain their original lexical identity before exposure. */
function carriedBindings(expression: Expression): ReadonlySet<FrameBinding> | undefined {
  let value = unwrapped(expression);
  const bindings = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (
      selected === undefined ||
      selected.keys.length > 0 ||
      bindings.has(selected.binding) ||
      framedAssignedValues(value).length > 0
    )
      return undefined;
    const { binding } = selected;
    bindings.add(binding);
    if (isParameterDeclaration(binding)) return bindings;
    if (
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return undefined;
    value = unwrapped(binding.initializer);
  }
  return undefined;
}

/** Earlier or captured uses may have replaced the selected Error field before native storage. */
function carriedUnexposed(expression: Expression, allowed: ReadonlySet<Expression>): boolean {
  const value = unwrapped(expression);
  if (!isIdentifier(value) || framedMapKey(value) !== undefined) return true;
  const bindings = carriedBindings(value);
  if (bindings === undefined) return false;
  const pending: Node[] = [value.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isIdentifier(node) && exposedUse(node, value, bindings, allowed)) return false;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** Modeled native set-value reads and the same whole const aliases expose no member of a carried value. */
function exposedUse(
  name: Identifier,
  value: Expression,
  bindings: ReadonlySet<FrameBinding>,
  allowed: ReadonlySet<Expression>,
): boolean {
  if (!readsBinding(name) || allowed.has(name)) return false;
  const selected = frameBindingOf(name);
  if (selected === undefined || name === selected.binding.name || !bindings.has(selected.binding))
    return false;
  const { parent } = useOf(name);
  if (
    isVariableDeclaration(parent) &&
    parent.initializer !== undefined &&
    unwrapped(parent.initializer) === name &&
    bindings.has(parent)
  )
    return false;
  const owner = executionOwner(value);
  const other = executionOwner(name);
  if (other === owner) {
    if (
      (name.pos >= value.pos || destructuredFirst(value, name)) &&
      !repeatedFrameRead(name, value, selected.binding, owner)
    )
      return false;
  } else if (unreferencedLocalFunction(other, owner)) return false;
  return framedPossibleBranch(name);
}

/** A later known key write supersedes only that same primitive key in an inner native link. */
function hiddenKey(key: string | undefined, hidden: Set<string>): boolean {
  if (key === undefined) return false;
  if (hidden.has(key)) return true;
  hidden.add(key);
  return false;
}

/** A saved result alias retains its native writes only before intervening runtime work. */
function chainUnchanged(read: CallExpression, sets: readonly CallExpression[]): boolean {
  const owner = executionOwner(read);
  let since = read.pos;
  for (const call of sets) {
    if (call.end > read.pos) continue;
    if (executionOwner(call) !== owner) return false;
    since = Math.min(since, call.end);
  }
  if (since === read.pos) return true;
  const pending: Node[] = [read.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    const position = isForOfStatement(node) || isForInStatement(node) ? node.expression : node;
    if (
      position.pos >= since &&
      position.end <= read.pos &&
      EFFECTS.has(node.kind) &&
      executionOwner(node) === owner &&
      framedPossibleBranch(node)
    )
      return false;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** A missing native argument is the known undefined key; opaque written expressions stay unknown. */
function chainKey(value: Expression | undefined): string | undefined {
  return value === undefined ? 'undefined' : framedMapKey(value);
}

/** Evaluated keys, values and ignored arguments must not rewrite a carried value before native access. */
function quietNativeArguments(
  call: CallExpression,
  targets: ReadonlySet<string>,
): readonly Expression[] | undefined {
  const native = framedNativeArguments(call, targets);
  if (
    native === undefined ||
    native.constructed ||
    native.args === undefined ||
    !quietWrapperTail(call, targets)
  )
    return undefined;
  const prefix = framedArgumentPrefix(call, native.args, Infinity);
  return prefix.unknown ||
    prefix.alternatives !== undefined ||
    prefix.values.some((value) => !quietArgument(value))
    ? undefined
    : prefix.values;
}

/** Function.apply and Reflect.apply still evaluate wrapper slots their native target never receives. */
function quietWrapperTail(call: CallExpression, targets: ReadonlySet<string>): boolean {
  const start = wrapperTailStart(call, targets);
  if (start === undefined) return true;
  const prefix = framedArgumentPrefix(call, call.arguments, Infinity);
  return (
    !prefix.unknown &&
    prefix.alternatives === undefined &&
    prefix.values.slice(start).every((value) => quietArgument(value))
  );
}

/** Original wrapper slots beyond the receiver and native key/value positions still execute. */
function wrapperTailStart(call: CallExpression, targets: ReadonlySet<string>): number | undefined {
  const member = unwrapped(call.expression);
  if (globalPathOf(member)?.join('.') === 'Reflect.apply') return TAIL.reflect;
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return undefined;
  const name = frameMemberName(member);
  if (name === 'apply') return 2;
  if (name !== 'call') return undefined;
  return targets === GETTERS ? 2 : TAIL.reflect;
}

/** Ordinary literal data creation and direct primitive or binding reads execute no application effects. */
function quietArgument(node: Expression): boolean {
  const value = unwrapped(node);
  if (quietAtom(value)) return true;
  return (
    isObjectLiteralExpression(value) &&
    value.properties.every((property) => {
      return (
        isPropertyAssignment(property) &&
        !isComputedPropertyName(property.name) &&
        quietAtom(unwrapped(property.initializer))
      );
    })
  );
}

/** Syntax-guaranteed quiet atom reads do not invoke getters, conversion hooks or application calls. */
function quietAtom(value: Expression): boolean {
  if (
    isIdentifier(value) ||
    isNumericLiteral(value) ||
    isStringLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value) ||
    value.kind === SyntaxKind.NullKeyword ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    value.kind === SyntaxKind.BigIntLiteral
  )
    return true;
  return (
    isPrefixUnaryExpression(value) &&
    (value.operator === SyntaxKind.PlusToken || value.operator === SyntaxKind.MinusToken) &&
    isNumericLiteral(unwrapped(value.operand))
  );
}
