import {
  type CallExpression,
  type Expression,
  type NewExpression,
  isArrayLiteralExpression,
  isCallExpression,
  isElementAccessExpression,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isOmittedExpression,
  isPropertyAccessExpression,
  isStringLiteral,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { argumentArrayExposed, selectedError } from './framed-array-selections.ts';
import { frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { finiteSetSelection } from './framed-finite-set-results.ts';
import { iteratorCarriedUnexposed } from './framed-iterator-carried.ts';
import {
  DEFAULT_ITERATOR,
  iteratorMemberName,
  iteratorPrefixQuiet,
  iteratorQuietValues,
} from './framed-iterator-guards.ts';
import { framedDefaultMapSlots } from './framed-iterator-map-slots.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedOriginPrefix } from './framed-origin-prefix.ts';
import { setCarriedUnexposed } from './framed-set-carried.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';

/** Native Iterator.from preserves only finite quiet source collections at an immediate first step. */

const ITERATORS = new Set(['Iterator']);
const FROM = new Set(['Iterator.from']);
const MAPS = new Set(['Map']);
const METHODS = new Set(['entries', 'keys', 'values']);

type ErrorValue = (value: Expression, made: boolean, keys: readonly string[]) => boolean;

interface IteratorRead {
  readonly made: boolean;
  readonly keys: readonly string[];
  readonly capture: CallExpression;
  readonly consumer: Expression;
}

interface Source {
  readonly value: Expression;
  readonly bindings: ReadonlySet<FrameBinding>;
}

interface NativeProof {
  readonly source: (value: Expression) => Source | undefined;
  readonly own: (
    bindings: ReadonlySet<FrameBinding>,
    method: string,
    read: CallExpression,
  ) => boolean;
  readonly native: (call: CallExpression, error: ErrorValue) => boolean | undefined;
}

/** Nested native wrappers keep the same first source; arbitrary iterable and iterator bodies stay opaque. */
export function framedIteratorFromResult(
  call: CallExpression,
  read: IteratorRead,
  error: ErrorValue,
  proof: NativeProof,
): boolean | undefined {
  let current = call;
  const seen = new Set<Expression>();
  for (;;) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const input = iteratorFromInput(current, read);
    if (input === undefined) return undefined;
    const source = proof.source(input);
    if (
      source === undefined ||
      proof.own(source.bindings, DEFAULT_ITERATOR, current) ||
      argumentArrayExposed(input, source.bindings, undefined, false) ||
      !framedOriginPrefix(source.value)
    )
      return undefined;
    if (isCallExpression(source.value) && iteratorFromInput(source.value, read) !== undefined) {
      current = source.value;
      continue;
    }
    return sourceResult({ input, source, call: current }, read, error, proof);
  }
}

interface FromSource {
  readonly input: Expression;
  readonly source: Source;
  readonly call: CallExpression;
}

/** Raw arrays, finite Sets, Maps and already-proved native acquisitions retain separate selection rules. */
function sourceResult(
  at: FromSource,
  read: IteratorRead,
  error: ErrorValue,
  proof: NativeProof,
): boolean | undefined {
  const value = at.source.value;
  if (isArrayLiteralExpression(value)) return arrayResult(at, read, error);
  const set = finiteSetSelection(value, {
    capture: at.call,
    consumer: read.consumer,
    index: 0,
  });
  if (set !== undefined)
    return setCarriedUnexposed(
      set.roots,
      set.values.map((each) => ({ value: each })),
      read.capture,
    ) && set.values.some((each) => error(each, read.made, read.keys))
      ? true
      : undefined;
  if (isNewExpression(value) && framedNativeConstructor(value.expression, MAPS))
    return mapResult({ ...at, construction: value, path: read.keys }, read, error, proof);
  return isCallExpression(value)
    ? acquisitionResult({ call: value, outer: at.call }, read, error, proof)
    : undefined;
}

/** An unchanged raw literal array supplies its first default-iterator element. */
function arrayResult(at: FromSource, read: IteratorRead, error: ErrorValue): boolean | undefined {
  if (!sourceQuiet(at.source.value, at.call, read.capture)) return undefined;
  return selectedError(
    at.input,
    0,
    {
      error: (value, path = []) => {
        return (
          framedOriginCoowned(value, read.capture) &&
          iteratorCarriedUnexposed([at.source.value], [{ value }], read.capture) &&
          error(value, read.made, [...path, ...read.keys])
        );
      },
      typed: () => false,
    },
    read.capture,
  )
    ? true
    : undefined;
}

interface MapSource extends FromSource {
  readonly construction: NewExpression;
  readonly path: readonly string[];
}

/** First native Map entry slots require source-proven overwrite equality before retaining values. */
function mapResult(
  at: MapSource,
  read: IteratorRead,
  error: ErrorValue,
  proof: NativeProof,
): boolean | undefined {
  if (!sourceQuiet(at.construction, at.call, read.capture)) return undefined;
  const input = at.construction.arguments?.[0];
  const literal = input === undefined ? undefined : proof.source(input);
  if (
    input === undefined ||
    literal === undefined ||
    !isArrayLiteralExpression(literal.value) ||
    argumentArrayExposed(input, literal.bindings, undefined, false) ||
    !quietValues([literal.value]) ||
    !iteratorPrefixQuiet(literal.value, at.call)
  )
    return undefined;
  const selected = framedDefaultMapSlots(literal.value, at.path);
  return selected !== undefined &&
    iteratorCarriedUnexposed(
      [literal.value],
      selected.values.map((value) => ({ value })),
      read.capture,
    ) &&
    selected.values.some(
      (value) => framedOriginCoowned(value, read.capture) && error(value, read.made, selected.keys),
    )
    ? true
    : undefined;
}

interface Acquisition {
  readonly call: CallExpression;
  readonly outer: CallExpression;
}

/** A wrapped native acquisition retains its selected path without changing existing direct acquisitions. */
function acquisitionResult(
  at: Acquisition,
  read: IteratorRead,
  error: ErrorValue,
  proof: NativeProof,
): boolean | undefined {
  const known = quietAcquisition(at, read, proof);
  if (known === undefined) return undefined;
  const { source, method, input } = known;
  if (isNewExpression(source.value) && framedNativeConstructor(source.value.expression, MAPS)) {
    let path = read.keys;
    if (method === 'keys') path = ['0', ...path];
    else if (method === 'values') path = ['1', ...path];
    return mapResult(
      { input, source, call: at.outer, construction: source.value, path },
      read,
      error,
      proof,
    );
  }
  return proof.native(at.call, (value, made, keys) => {
    return (
      framedOriginCoowned(value, read.capture) &&
      iteratorCarriedUnexposed([at.call], [{ value }], read.capture) &&
      error(value, made, keys)
    );
  });
}

/** Native acquisition identity, source creation and all evaluated ignored arguments stay quiet. */
function quietAcquisition(
  at: Acquisition,
  read: IteratorRead,
  proof: NativeProof,
): { readonly source: Source; readonly method: string; readonly input: Expression } | undefined {
  const { call, outer } = at;
  const member = unwrapped(call.expression);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return undefined;
  const method = iteratorMemberName(member);
  const source = proof.source(member.expression);
  if (method === undefined || source === undefined) return undefined;
  if (
    (method !== DEFAULT_ITERATOR && !METHODS.has(method)) ||
    proof.own(source.bindings, method, call) ||
    argumentArrayExposed(member.expression, source.bindings) ||
    !quietValues(call.arguments) ||
    !framedOriginPrefix(source.value) ||
    !sourceQuiet(source.value, outer, read.capture)
  )
    return undefined;
  if (isNewExpression(source.value) && !quietConstructorInput(source.value, outer, proof))
    return undefined;
  return { source, method, input: member.expression };
}

/** A wrapped native construction consumes only unchanged finite literal input with quiet creation. */
function quietConstructorInput(
  construction: NewExpression,
  outer: CallExpression,
  proof: NativeProof,
): boolean {
  const input = construction.arguments?.[0];
  const literal = input === undefined ? undefined : proof.source(input);
  return (
    input !== undefined &&
    literal !== undefined &&
    isArrayLiteralExpression(literal.value) &&
    !argumentArrayExposed(input, literal.bindings) &&
    quietValues([literal.value]) &&
    iteratorPrefixQuiet(literal.value, outer)
  );
}

/** Every evaluated wrapper argument stays quiet before the first selected source member is read. */
function iteratorFromInput(call: CallExpression, read: IteratorRead): Expression | undefined {
  if (!nativeFrom(call.expression) || !immediateMember(read.consumer)) return undefined;
  const prefix = framedArgumentPrefix(call, call.arguments, Infinity);
  if (
    prefix.unknown ||
    prefix.alternatives !== undefined ||
    !iteratorQuietValues(prefix.values.slice(1)) ||
    !iteratorQuietValues(read.capture.arguments) ||
    !iteratorPrefixQuiet(call, read.capture)
  )
    return undefined;
  return prefix.values[0];
}

/** Whole constructor and native function aliases retain the unshadowed from identity. */
function nativeFrom(node: Expression): boolean {
  const value = unwrapped(node);
  if (framedNativeConstructor(value, FROM)) return true;
  return (
    (isPropertyAccessExpression(value) || isElementAccessExpression(value)) &&
    frameMemberName(value) === 'from' &&
    framedNativeConstructor(value.expression, ITERATORS)
  );
}

/** Saved next results preserve opacity instead of acquiring a later field-write origin. */
function immediateMember(node: Expression): boolean {
  const { at, parent } = useOf(node);
  if (isPropertyAccessExpression(parent) && parent.expression === at) return true;
  return (
    isElementAccessExpression(parent) &&
    parent.expression === at &&
    framedMapKey(parent.argumentExpression) !== undefined
  );
}

/** Source creation and the acquisition prefix perform no application work before native iteration. */
function sourceQuiet(
  value: Expression,
  acquisition: CallExpression,
  next: CallExpression,
): boolean {
  const args = isNewExpression(value) ? (value.arguments ?? []) : [value];
  return (
    executionOwner(value) === executionOwner(next) &&
    quietValues(args) &&
    iteratorPrefixQuiet(value, acquisition)
  );
}

/** Finite literals and native literal-message Error construction invoke no supplied callback. */
function quietValues(values: readonly Expression[]): boolean {
  const pending = [...values];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    const value = unwrapped(each);
    if (isOmittedExpression(value) || iteratorQuietValues([value])) continue;
    if (isArrayLiteralExpression(value)) {
      pending.push(...value.elements);
      continue;
    }
    if (!isNewExpression(value) || !framedNativeConstructor(value.expression, STANDARD_ERRORS))
      return false;
    const args = value.arguments ?? [];
    if (args.length === 0) continue;
    if (args.length !== 1 || args[0] === undefined) return false;
    const message = unwrapped(args[0]);
    if (!isStringLiteral(message) && !isNoSubstitutionTemplateLiteral(message)) return false;
  }
  return true;
}
