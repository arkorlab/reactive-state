import {
  type Expression,
  isArrayLiteralExpression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { argumentArrayExposed } from './framed-array-selections.ts';
import {
  frameBindingOf,
  frameDeclarationOf,
  frameMemberName,
  type FrameBinding,
} from './framed-bindings.ts';
import { framedObjectSources } from './framed-object-members.ts';
import { framedParameterCallResult } from './framed-parameter-call-results.ts';
import { framedCallReturns } from './framed-values.ts';

/** Selected written factory members retain their original call arguments and lexical nodes. */

interface Selection {
  readonly made: boolean;
  readonly keys: readonly string[];
}

interface MemberReading {
  readonly value: Expression;
  readonly keys: readonly string[];
  readonly seen: ReadonlySet<Node>;
}

/** Only a source-selected local Error result can close the existing outer assertion fallback. */
export function framedFactoryMemberResult(
  node: Expression,
  selection: Selection,
  error: (value: Expression, made: boolean) => boolean,
): boolean | undefined {
  const keys = [...selection.keys];
  let value = unwrapped(node);
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const key = frameMemberName(value);
    if (key === undefined) return undefined;
    keys.unshift(key);
    value = unwrapped(value.expression);
  }
  if (framedParameterCallResult(node, selection.keys)) return true;
  if (!isCallExpression(value)) return undefined;
  if (keys.length === 0) return undefined;
  const results = framedCallReturns(value, frameDeclarationOf, (returned) =>
    selectedMembers(returned, keys),
  );
  if (results?.some((each) => error(each, selection.made)) === true) return true;
  if (
    results !== undefined &&
    !selection.made &&
    results.length > 0 &&
    results.every((each) => error(each, true))
  )
    return false;
  return undefined;
}

/** Finite literal member paths consume keys before aliases may be revisited. */
function selectedMembers(
  node: Expression,
  keys: readonly string[],
): readonly Expression[] | undefined {
  const pending: MemberReading[] = [{ value: node, keys, seen: new Set() }];
  const found: Expression[] = [];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const value = unwrapped(at.value);
    if (at.keys.length === 0) {
      found.push(value);
      continue;
    }
    if (at.seen.has(value)) return undefined;
    if (isIdentifier(value)) {
      const initializer = constantInitializer(value, node);
      if (initializer === undefined) return undefined;
      pending.push({ ...at, value: initializer, seen: new Set([...at.seen, value]) });
      continue;
    }
    const selected = literalMembers(value, at.keys[0] ?? '');
    if (selected === undefined) return undefined;
    for (const each of selected)
      pending.push({ value: each, keys: at.keys.slice(1), seen: new Set() });
  }
  return found;
}

/** Written object descriptors and fixed array positions retain their selected source expressions. */
function literalMembers(node: Expression, key: string): readonly Expression[] | undefined {
  if (isObjectLiteralExpression(node)) {
    const sources = framedObjectSources(node, [key]);
    return sources?.some((each) => each.keys.length > 0) === true
      ? undefined
      : sources?.map((each) => each.value);
  }
  if (!isArrayLiteralExpression(node) || node.elements.some((each) => isSpreadElement(each)))
    return undefined;
  if (!/^(?:0|[1-9]\d*)$/u.test(key)) return undefined;
  const element = node.elements[Number(key)];
  return element === undefined || isOmittedExpression(element) ? [] : [element];
}

/** Whole constant holders retain their literal only while prior or possible deferred uses leave it unexposed. */
function constantInitializer(name: Expression, read: Expression): Expression | undefined {
  let value = unwrapped(name);
  const aliases = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0 || aliases.has(selected.binding))
      return undefined;
    const binding = selected.binding;
    if (
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\s/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return undefined;
    aliases.add(binding);
    value = unwrapped(binding.initializer);
  }
  return argumentArrayExposed(read, aliases) ? undefined : value;
}
