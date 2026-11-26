import {
  type CallExpression,
  type Expression,
  type Node,
  type Statement,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isElementAccessExpression,
  isExpression,
  isExpressionStatement,
  isIdentifier,
  isPropertyAccessExpression,
  isReturnStatement,
  isVariableDeclaration,
  isVariableDeclarationList,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { borrowedTextCall } from './framed-array-borrowing.ts';
import { sourceArrayFunction } from './framed-array-functions.ts';
import { argumentArrayReached, selectedError } from './framed-array-selections.ts';
import { framedAtMethod } from './framed-at-methods.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { framedArgumentPrefix, framedKeyNames } from './framed-keys.ts';
import { framedLiteralObject } from './framed-literal-data.ts';
import { framedMapGroupedResult } from './framed-map-grouped-results.ts';
import { framedReadableStreamResult } from './framed-readable-stream-results.ts';
import { framedNativeErrorCreation } from './framed-receivers.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** Native Object value identities and fixed-key groups retain their original selected sources. */
const GROUP_BY = new Set(['Object.groupBy']);

type ErrorValue = (value: Expression, made: boolean, keys?: readonly string[]) => boolean;
interface Selection {
  readonly made: boolean;
  readonly keys: readonly string[];
}
interface SelectedCall {
  readonly call: CallExpression;
  readonly keys: readonly string[];
}

/** Fixed member paths reach a native result without fabricating syntax nodes or type bindings. */
export function framedNativeObjectResult(
  node: Expression,
  selection: Selection,
  names: ReadonlySet<string>,
  error: ErrorValue,
): boolean | undefined {
  const streamed = framedReadableStreamResult(node, selection, error);
  if (streamed !== undefined) return streamed;
  const selected = selectedCall(node, selection.keys);
  if (selected === undefined) return undefined;
  const context = { ...selection, keys: selected.keys };
  const values = valueOfSources(selected.call, names);
  if (values !== undefined) return resultError(values, context, error);
  return (
    framedMapGroupedResult(selected.call, context, error) ??
    groupedError(selected.call, context, error)
  );
}

/** The selected path stays attached to original receiver nodes throughout the result check. */
function selectedCall(node: Expression, keys: readonly string[]): SelectedCall | undefined {
  const path = [...keys];
  let value = unwrapped(node);
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const key = frameMemberName(value);
    if (key === undefined) return undefined;
    path.unshift(key);
    value = unwrapped(value.expression);
  }
  return isCallExpression(value) ? { call: value, keys: path } : undefined;
}

/** Borrowing the native Object method ignores own overrides; direct calls retain known own results. */
function valueOfSources(
  call: CallExpression,
  names: ReadonlySet<string>,
): readonly Expression[] | undefined {
  const borrowed = borrowedTextCall(call);
  if (borrowed?.path.join('.') === 'Object.prototype.valueOf') return [borrowed.receiver];
  const member = unwrapped(call.expression);
  if (
    (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) ||
    frameMemberName(member) !== 'valueOf'
  )
    return undefined;
  if (sourceArrayFunction(member)) return ownResults(member);
  const own = priorOwnValueOf(call, member.expression, names);
  return own === undefined ? [member.expression] : ownResults(own);
}

/** Only source-proven native/local identities can close an outer Error assertion fallback. */
function resultError(
  values: readonly Expression[],
  selection: Selection,
  error: ErrorValue,
): boolean | undefined {
  if (values.some((value) => error(value, selection.made, selection.keys))) return true;
  if (
    !selection.made &&
    values.length > 0 &&
    values.every((value) => framedLiteralObject(value) || error(value, true, selection.keys))
  )
    return false;
  return undefined;
}

/** Synchronous own implementations keep their original returned values, while unknown bodies stay opaque. */
function ownResults(value: Expression): readonly Expression[] | undefined {
  const found: Expression[] = [];
  const known = framedAtMethod(value, (each) => {
    found.push(each);
    return false;
  });
  return known === undefined ? undefined : found;
}

interface NativeSource {
  readonly value: Expression;
  readonly bindings: ReadonlySet<FrameBinding>;
}

/** Whole constant aliases retain one fresh native Error construction and its lexical identity. */
function nativeSource(node: Expression, names: ReadonlySet<string>): NativeSource | undefined {
  let value = unwrapped(node);
  const bindings = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0 || bindings.has(selected.binding))
      return undefined;
    const binding = selected.binding;
    if (
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return undefined;
    bindings.add(binding);
    value = unwrapped(binding.initializer);
  }
  return framedNativeErrorCreation(value, names) ? { value, bindings } : undefined;
}

/** A closed own callable is established only on an otherwise unexposed fresh native receiver. */
function priorOwnValueOf(
  call: CallExpression,
  receiver: Expression,
  names: ReadonlySet<string>,
): Expression | undefined {
  const source = nativeSource(receiver, names);
  const statement = closedReadStatement(call);
  if (source === undefined || statement === undefined || !isBlock(statement.parent))
    return undefined;
  const statements = statement.parent.statements;
  const previous = statements[statements.indexOf(statement) - 1];
  if (previous === undefined || !isExpressionStatement(previous)) return undefined;
  const assignment = unwrapped(previous.expression);
  if (!isBinaryExpression(assignment) || assignment.operatorToken.kind !== SyntaxKind.EqualsToken)
    return undefined;
  const member = unwrapped(assignment.left);
  if (
    (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) ||
    frameMemberName(member) !== 'valueOf' ||
    !sourceArrayFunction(assignment.right)
  )
    return undefined;
  const target = nativeSource(member.expression, names);
  if (target?.value !== source.value) return undefined;
  const bindings = new Set([...source.bindings, ...target.bindings]);
  return argumentArrayReached(assignment, bindings) ? undefined : assignment.right;
}

/** The selected call is read before any additional application work in this statement. */
function closedReadStatement(call: CallExpression): Statement | undefined {
  let node: Node = call;
  for (;;) {
    const { at, parent } = useOf(node);
    if (!isExpression(at)) return undefined;
    if (
      (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
      parent.expression === at
    ) {
      node = parent;
      continue;
    }
    return (isReturnStatement(parent) || isExpressionStatement(parent)) && parent.expression === at
      ? parent
      : undefined;
  }
}

/** A fixed callback key places every source element in the same native group, preserving order. */
function groupedError(
  call: CallExpression,
  selection: Selection,
  error: ErrorValue,
): boolean | undefined {
  if (!framedNativeConstructor(call.expression, GROUP_BY)) return undefined;
  const prefix = framedArgumentPrefix(call);
  const input = prefix.values[0];
  const callback = prefix.values[1];
  if (input === undefined || callback === undefined || prefix.unknown) return undefined;
  const group = fixedGroup(callback);
  if (group === undefined || selection.keys[0] !== group) return undefined;
  const key = selection.keys[1];
  if (key === undefined || !/^(?:0|[1-9]\d*)$/u.test(key)) return undefined;
  const selected: { value: Expression; keys: readonly string[] }[] = [];
  selectedError(
    input,
    Number(key),
    {
      error: (value, keys = []) => {
        selected.push({ value, keys });
        return false;
      },
      typed: () => false,
    },
    call,
  );
  const found = selected.map((each) => {
    return {
      ...selection,
      keys: [...each.keys, ...selection.keys.slice(2)],
      value: each.value,
    };
  });
  if (found.some((each) => error(each.value, each.made, each.keys))) return true;
  if (
    !selection.made &&
    found.length > 0 &&
    found.every((each) => error(each.value, true, each.keys))
  )
    return false;
  return undefined;
}

/** Unresolved callback results and multiple possible group keys retain the opaque boundary. */
function fixedGroup(callback: Expression): string | undefined {
  const keys = new Set<string>();
  const state = { opaque: false };
  const known = framedAtMethod(callback, (returned) => {
    const names = framedKeyNames(returned);
    if (names === undefined) state.opaque = true;
    else for (const name of names) keys.add(name);
    return false;
  });
  return known === undefined || state.opaque || keys.size !== 1 ? undefined : [...keys][0];
}
