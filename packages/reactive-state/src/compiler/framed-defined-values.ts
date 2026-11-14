import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isCallExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { argumentArrayExposed } from './framed-array-selections.ts';
import { type AssignedFrameSource } from './framed-assignment-patterns.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { framedCreatedResult } from './framed-created-values.ts';
import { framedDefinedAccessorResult } from './framed-defined-accessors.ts';
import { framedDefinitionAlternativesQuiet } from './framed-definition-evaluation.ts';
import {
  framedDefinedReceiver,
  framedDefinitionUnchanged,
} from './framed-definition-projections.ts';
import { framedDescriptorChoices, framedDescriptorEntries } from './framed-descriptor-entries.ts';
import { framedKeyNames } from './framed-keys.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** Native methods that answer the target they are given first. */
const TARGET_RESULTS: ReadonlySet<string> = new Set([
  'Object.assign',
  'Object.defineProperties',
  'Object.defineProperty',
  'Object.freeze',
  'Object.preventExtensions',
  'Object.seal',
  'Object.setPrototypeOf',
]);

/** Native constructions that may answer an object they are given, a Proxy among them. */
const HANDING_CONSTRUCTORS: ReadonlySet<string> = new Set(['Object', 'Proxy']);

const PROXY: ReadonlySet<string> = new Set(['Proxy']);

/**
 * Selected data descriptors on a returned native target retain their actual installed value where
 * the target is shown to install it; on another, the target's own member stays possible.
 */
export function framedDefinedResult(
  node: Expression,
  keys: readonly string[],
  error: (value: Expression, path: readonly string[]) => boolean,
): boolean | undefined {
  const accessor = framedDefinedAccessorResult(node, keys, error);
  if (accessor !== undefined) return accessor;
  const selected = framedDefinedReceiver(node, keys);
  if (selected === undefined || selected.keys.length === 0) return undefined;
  if (globalPathOf(unwrapped(selected.call.expression))?.join('.') === 'Object.create') {
    if (argumentArrayExposed(node, selected.aliases)) return undefined;
    return framedCreatedResult(selected.call, selected.keys, error);
  }
  const sources = definedSources(selected.call, selected.keys);
  if (sources === undefined || !framedDefinitionUnchanged(selected)) return undefined;
  const [target] = selected.call.arguments;
  if (target !== undefined && installingTarget(target))
    return sources.some((each) => error(each.value, each.keys));
  // A target that may intercept the definition or the read keeps its own member and proves no data.
  const possible = [
    ...sources,
    ...(target === undefined ? [] : selectedSources(constantSource(target), selected.keys)),
  ];
  return possible.some((each) => error(each.value, each.keys)) ? true : undefined;
}

/**
 * Whether a definition's target is shown to install what it is given and to answer reads of it:
 * an object or an array written there, a fresh native construction, `Object.create`'s object, what
 * a native method answers of such a target, and a native Proxy of an empty written handler over one
 * — through whole constant aliases. A Proxy that may intercept the definition or the read, and a
 * target the compile cannot read, prove neither.
 */
function installingTarget(node: Expression): boolean {
  const seen = new Set<Node>();
  let value = constantSource(node);
  while (!seen.has(value)) {
    seen.add(value);
    if (installsHere(value)) return true;
    const next = handedOn(value);
    if (next === undefined) return false;
    value = constantSource(next);
  }
  return false;
}

/** An object written there, `Object.create`'s, or a fresh native construction of no handed object. */
function installsHere(value: Expression): boolean {
  if (isObjectLiteralExpression(value) || isArrayLiteralExpression(value)) return true;
  if (!isNewExpression(value) && !isCallExpression(value)) return false;
  const path = globalPathOf(unwrapped(value.expression))?.join('.') ?? '';
  return (
    path === 'Object.create' ||
    (isNewExpression(value) && path !== '' && !HANDING_CONSTRUCTORS.has(path))
  );
}

/** The target a native method answers, or an empty-handled native Proxy forwards to. */
function handedOn(value: Expression): Expression | undefined {
  if (!isNewExpression(value) && !isCallExpression(value)) return undefined;
  const forwards = isNewExpression(value)
    ? framedNativeConstructor(value.expression, PROXY) && emptyHandler(value.arguments?.[1])
    : TARGET_RESULTS.has(globalPathOf(unwrapped(value.expression))?.join('.') ?? '');
  const [first] = value.arguments ?? [];
  return !forwards || first === undefined || isSpreadElement(first) ? undefined : first;
}

/** A handler written there of no entry holds no trap, and nothing else can reach it to add one. */
function emptyHandler(handler: Expression | undefined): boolean {
  const value = handler === undefined ? undefined : unwrapped(handler);
  return value !== undefined && isObjectLiteralExpression(value) && value.properties.length === 0;
}

/** What a whole constant alias holds, through its own aliases; another value as it is. */
function constantSource(node: Expression): Expression {
  let value = unwrapped(node);
  const seen = new Set<Node>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const declared = frameDeclarationOf(value);
    if (
      declared === undefined ||
      !isVariableDeclaration(declared) ||
      !isIdentifier(declared.name) ||
      declared.initializer === undefined ||
      !isVariableDeclarationList(declared.parent) ||
      !/^const\s/u.test(declared.parent.getText(declared.getSourceFile()))
    )
      return value;
    value = unwrapped(declared.initializer);
  }
  return value;
}

/** Only native singular or plural definitions replace the selected own property. */
function definedSources(
  call: CallExpression,
  keys: readonly string[],
): readonly AssignedFrameSource[] | undefined {
  const path = globalPathOf(unwrapped(call.expression))?.join('.');
  const [target, key, descriptor] = call.arguments;
  if (target === undefined || key === undefined || isSpreadElement(target) || isSpreadElement(key))
    return undefined;
  const member = keys[0];
  if (member === undefined) return undefined;
  if (path === 'Object.defineProperty') return singularSources(target, key, descriptor, keys);
  return path === 'Object.defineProperties' ? pluralSources(call, target, key, keys) : undefined;
}

/** A singular descriptor replaces one exact property, or remains a possible conditional selection. */
function singularSources(
  target: Expression,
  key: Expression,
  descriptor: Expression | undefined,
  keys: readonly string[],
): readonly AssignedFrameSource[] | undefined {
  if (descriptor === undefined || isSpreadElement(descriptor)) return undefined;
  const names = framedKeyNames(key);
  if (names !== undefined && !names.includes(keys[0] ?? '')) return selectedSources(target, keys);
  const values = framedDescriptorEntries(descriptor, ['value']);
  if (values === undefined || values.length === 0) return undefined;
  const installed = values.flatMap((value) => selectedSources(value, keys.slice(1)));
  return names?.length === 1 ? installed : [...installed, ...selectedSources(target, keys)];
}

/** Quiet finite computed keys retain old target and earlier descriptor alternatives when still possible. */
function pluralSources(
  call: CallExpression,
  target: Expression,
  map: Expression,
  keys: readonly string[],
): readonly AssignedFrameSource[] | undefined {
  const descriptors = framedDescriptorChoices(map, keys[0] ?? '');
  const values =
    descriptors === undefined ? undefined : descriptorSources(descriptors.values, keys);
  if (descriptors === undefined || values === undefined)
    return legacyPluralSources(target, map, keys);
  const sources = descriptors.absent ? [...values, ...selectedSources(target, keys)] : values;
  return framedDefinitionAlternativesQuiet(call, sources)
    ? sources
    : legacyPluralSources(target, map, keys);
}

/** Existing opaque map evaluation retains its prior written-entry source rule. */
function legacyPluralSources(
  target: Expression,
  map: Expression,
  keys: readonly string[],
): readonly AssignedFrameSource[] | undefined {
  const descriptors = framedDescriptorEntries(map, [keys[0] ?? '']);
  if (descriptors === undefined) return undefined;
  return descriptors.length === 0
    ? selectedSources(target, keys)
    : descriptorSources(descriptors, keys);
}

/** Source-written data descriptor values keep their remaining original member paths. */
function descriptorSources(
  descriptors: readonly Expression[],
  keys: readonly string[],
): readonly AssignedFrameSource[] | undefined {
  const installed: AssignedFrameSource[] = [];
  for (const each of descriptors) {
    const values = framedDescriptorEntries(each, ['value']);
    if (values === undefined || values.length === 0) return undefined;
    for (const value of values) installed.push(...selectedSources(value, keys.slice(1)));
  }
  return installed;
}

/** Written nested own entries are selected directly; declared sources keep their remaining path. */
function selectedSources(
  value: Expression,
  keys: readonly string[],
): readonly AssignedFrameSource[] {
  const pending: AssignedFrameSource[] = [{ value, keys }];
  const found: AssignedFrameSource[] = [];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const key = at.keys[0];
    let entries: readonly Expression[] | undefined;
    if (key !== undefined) entries = framedDescriptorEntries(at.value, [key]);
    if (entries === undefined) found.push(at);
    else for (const entry of entries) pending.push({ value: entry, keys: at.keys.slice(1) });
  }
  return found;
}
