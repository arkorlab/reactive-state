import {
  type Expression,
  type ArrayLiteralExpression,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type BinaryExpression,
  type PropertyAssignment,
  type PropertyName,
  type ShorthandPropertyAssignment,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isComputedPropertyName,
  isIdentifier,
  isExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadElement,
  isSpreadAssignment,
  isVoidExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameDeclarationOf, frameTypeOf, type FrameDeclaration } from './framed-bindings.ts';
import { localArrayIterationKeys } from './local-type-reading.ts';
import { constantValue } from './numbers.ts';

/** Assignment patterns retain each selected source and its remaining written member path. */

export interface AssignedFrameSource {
  readonly value: Expression;
  readonly keys: readonly string[];
}

export interface PatternWork {
  readonly target: Expression;
  readonly sources: readonly AssignedFrameSource[];
  /** Some source holds nothing at the selected position, so that a default written there runs. */
  readonly missing?: boolean;
}

/** The values a literal's `__proto__:` ignores, as it takes no prototype of them. */
const NO_PROTOTYPE: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.BigIntLiteral,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.TrueKeyword,
]);

/** The array a rest makes, from which a pattern on one of its properties reads the host's own built-ins. */
const FRESH_ARRAY: readonly unknown[] = [];

/** The sources assigned to one lexical identifier, excluding fresh object and array rest copies. */
export function assignmentPatternSources(
  target: Expression,
  value: Expression,
  name: Identifier,
  declared: FrameDeclaration,
): readonly AssignedFrameSource[] {
  return assignmentSources(target, [{ value, keys: [] }], name, declared);
}

/** Literal iteration values and opaque numeric element paths retain their assignment selections. */
export function iteratedAssignmentSources(
  target: Expression,
  iterable: Expression,
  name: Identifier,
  declared: FrameDeclaration,
): readonly AssignedFrameSource[] {
  return assignmentSources(target, iteratedFrameSources(iterable), name, declared);
}

/** Literal iteration values and opaque numeric projections retain their selected source paths. */
export function iteratedFrameSources(iterable: Expression): readonly AssignedFrameSource[] {
  const pending = [iterable];
  const sources: AssignedFrameSource[] = [];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const value = unwrapped(node);
    if (!isArrayLiteralExpression(value)) {
      sources.push(...opaqueIterationSources(value));
      continue;
    }
    for (const element of value.elements) {
      if (isOmittedExpression(element)) continue;
      if (isSpreadElement(element)) pending.push(element.expression);
      else sources.push({ value: element, keys: [] });
    }
  }
  return sources;
}

/** Each place of a written tuple remains distinct; opaque iteration retains its existing numeric path. */
function opaqueIterationSources(value: Expression): readonly AssignedFrameSource[] {
  const selected = frameTypeOf(value);
  const keys =
    selected === undefined ? undefined : localArrayIterationKeys(selected.type, selected.keys);
  return (keys ?? ['0']).flatMap((key) => selectSources([{ value, keys: [] }], key));
}

/** Selected values are routed through the written pattern without synthesizing syntax nodes. */
function assignmentSources(
  target: Expression,
  sources: readonly AssignedFrameSource[],
  name: Identifier,
  declared: FrameDeclaration,
): readonly AssignedFrameSource[] {
  const found: AssignedFrameSource[] = [];
  const pending: PatternWork[] = [{ target, sources }];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const selected = unwrapped(at.target);
    if (isIdentifier(selected)) {
      if (selected.text === name.text && frameDeclarationOf(selected) === declared)
        found.push(...at.sources);
    } else {
      pending.push(...assignmentPatternTargets(selected, at.sources, at.missing));
    }
  }
  return found;
}

/**
 * Defaults, array positions and object entries contribute their selected assignment targets. A
 * default runs where `missing` says some source held nothing at its position. A rest's own pattern
 * reads a fresh array, which `offset` says starts at that place in the sources.
 */
export function assignmentPatternTargets(
  target: Expression,
  sources: readonly AssignedFrameSource[],
  missing = false,
  offset?: number,
): readonly PatternWork[] {
  if (isDefault(target))
    return [{ target: target.left, sources: defaultSources(sources, target.right, missing) }];
  if (isObjectLiteralExpression(target)) return objectTargets(target.properties, sources, offset);
  if (!isArrayLiteralExpression(target)) return [];
  const targets: PatternWork[] = [];
  for (const [index, element] of target.elements.entries()) {
    const key = String((offset ?? 0) + index);
    if (isSpreadElement(element))
      targets.push(...restTargets(element.expression, sources, (offset ?? 0) + index));
    else if (!isOmittedExpression(element))
      targets.push({
        target: element,
        sources: selectSources(sources, key),
        missing: missingSelection(sources, key),
      });
  }
  return targets;
}

/**
 * A rest is a fresh array, which binds no error identity, but a pattern its own target writes takes
 * the elements from the rest's place on: `[...[e]] = [new Error()]` assigns `e` the `Error`. An
 * object pattern reads the properties of that array, not of the sources.
 */
function restTargets(
  target: Expression,
  sources: readonly AssignedFrameSource[],
  offset: number,
): readonly PatternWork[] {
  const pattern = unwrapped(target);
  return isArrayLiteralExpression(pattern) || isObjectLiteralExpression(pattern)
    ? assignmentPatternTargets(pattern, sources, false, offset)
    : [];
}

/** Whether a target is written with a default: `target = fallback`. */
function isDefault(target: Expression): target is BinaryExpression {
  return isBinaryExpression(target) && target.operatorToken.kind === SyntaxKind.EqualsToken;
}

/** Named object entries and their selected defaults; methods and rest copies bind no error identity. */
function objectTargets(
  properties: readonly Node[],
  sources: readonly AssignedFrameSource[],
  offset: number | undefined,
): readonly PatternWork[] {
  const targets: PatternWork[] = [];
  for (const property of properties) {
    if (!isPropertyAssignment(property) && !isShorthandPropertyAssignment(property)) continue;
    const written = literalKey(property.name);
    if (written === undefined) continue;
    const place = offset === undefined ? written : placeOf(written, offset);
    if (place === undefined) {
      targets.push(...builtinEntry(property, FRESH_ARRAY, written));
      continue;
    }
    const target = entryTarget(property, selection(sources, place));
    if (target !== undefined) targets.push(target);
  }
  return targets;
}

/** The target an entry assigns, with its default run where the selection is missing. */
function entryTarget(
  property: PropertyAssignment | ShorthandPropertyAssignment,
  {
    values,
    missing,
  }: { readonly values: readonly AssignedFrameSource[]; readonly missing: boolean },
): PatternWork | undefined {
  if (isPropertyAssignment(property))
    return { target: property.initializer, sources: values, missing };
  if (!isIdentifier(property.name)) return undefined;
  return {
    target: property.name,
    sources:
      property.objectAssignmentInitializer === undefined
        ? values
        : defaultSources(values, property.objectAssignmentInitializer, missing),
  };
}

/**
 * The place of the sources an entry of a rest's object pattern selects: a position of the fresh
 * array, shifted to where the rest starts. Any other name is a property of the array itself.
 */
function placeOf(name: string, offset: number): string | undefined {
  return /^(?:0|[1-9]\d*)$/u.test(name) ? String(Number(name) + offset) : undefined;
}

/**
 * An entry of an object pattern written on a built-in value reads a property of `holder`. The fresh
 * array a rest makes holds, beside its positions, its `length`, a method its prototypes supply, or
 * nothing at all. Each such value is a built-in, which the host that compiles holds as every engine
 * that runs the application does, so that it is read from there. It binds no error identity, and a default beside it runs only where it is
 * `undefined`; a pattern written on it reads its properties in turn.
 */
function builtinEntry(
  property: PropertyAssignment | ShorthandPropertyAssignment,
  holder: unknown,
  name: string,
): readonly PatternWork[] {
  const read = readBuiltin(holder, name);
  if (read === undefined) return [];
  if (isPropertyAssignment(property)) return builtinTargets(property.initializer, read.value);
  const fallback = property.objectAssignmentInitializer;
  if (fallback === undefined || read.value !== undefined || !isIdentifier(property.name)) return [];
  return [{ target: property.name, sources: [{ value: fallback, keys: [] }] }];
}

/**
 * What a pattern written on a built-in value assigns: the defaults that run where it holds nothing.
 * A value that is no object, nor iterable, cannot be destructured by an array pattern, which throws;
 * an iterable that is no array, text, is not read position by position, and every default stays possible.
 */
function builtinTargets(target: Expression, value: unknown): readonly PatternWork[] {
  const pattern = unwrapped(target);
  if (isDefault(pattern))
    return value === undefined
      ? [{ target: pattern.left, sources: [{ value: pattern.right, keys: [] }] }]
      : builtinTargets(pattern.left, value);
  if (isObjectLiteralExpression(pattern)) {
    if (value === undefined || value === null) return [];
    return pattern.properties.flatMap((property) => {
      if (!isPropertyAssignment(property) && !isShorthandPropertyAssignment(property)) return [];
      const name = literalKey(property.name);
      return name === undefined ? [] : builtinEntry(property, value, name);
    });
  }
  if (!isArrayLiteralExpression(pattern)) return [];
  if (!Array.isArray(value))
    return Reflect.has(new Object(value), Symbol.iterator)
      ? assignmentPatternTargets(pattern, [])
      : [];
  const items: readonly unknown[] = value;
  return pattern.elements.flatMap((element, index) => {
    return isSpreadElement(element)
      ? builtinTargets(element.expression, items.slice(index))
      : builtinTargets(element, items[index]);
  });
}

/** A property of a built-in value as the host holds it, or nothing where reading it throws. */
function readBuiltin(holder: unknown, name: string): { readonly value: unknown } | undefined {
  try {
    return { value: Reflect.get(new Object(holder), name) };
  } catch {
    return undefined;
  }
}

/** The sources selected at one key, and whether some source holds nothing there. */
function selection(sources: readonly AssignedFrameSource[], key: string) {
  return { values: selectSources(sources, key), missing: missingSelection(sources, key) };
}

/** Literal entries are selected directly; opaque values retain the path for their declared type. */
function selectSources(
  sources: readonly AssignedFrameSource[],
  key: string,
): readonly AssignedFrameSource[] {
  return sources.flatMap((source) => selectSource(source, key));
}

/** Whether a literal source holds nothing at `key`: a hole, a position past its end, no such key. */
function missingSelection(sources: readonly AssignedFrameSource[], key: string): boolean {
  return sources.some((source) => selectSource(source, key).length === 0);
}

/** One source literal's selected value, or its original receiver with the remaining member path. */
function selectSource(source: AssignedFrameSource, key: string): readonly AssignedFrameSource[] {
  const opaque = { ...source, keys: [...source.keys, key] };
  if (source.keys.length > 0) return [opaque];
  const value = unwrapped(source.value);
  if (isArrayLiteralExpression(value)) return arraySource(value, key, opaque);
  return isObjectLiteralExpression(value) ? objectSource(value, key, opaque) : [opaque];
}

/** Fixed literal array positions before any unresolved spread keep their exact offsets. */
function arraySource(
  value: ArrayLiteralExpression,
  key: string,
  opaque: AssignedFrameSource,
): readonly AssignedFrameSource[] {
  const index = Number(key);
  if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key) return [opaque];
  if (value.elements.slice(0, index + 1).some((element) => isSpreadElement(element)))
    return [opaque];
  const element = value.elements[index];
  return element === undefined || isOmittedExpression(element)
    ? []
    : [{ value: element, keys: [] }];
}

/**
 * A surviving literal own entry, without executing getters or unknown spread sources. A key no own
 * entry holds is read from the prototype the literal's `__proto__:` sets, as a destructuring reads
 * an inherited property.
 */
function objectSource(
  value: ObjectLiteralExpression,
  key: string,
  opaque: AssignedFrameSource,
): readonly AssignedFrameSource[] {
  let prototype: Expression | undefined;
  for (const property of value.properties.toReversed()) {
    if (isSpreadAssignment(property)) return [opaque];
    const name = literalKey(property.name);
    if (name === undefined) return [opaque];
    if (name === key) return ownSource(property, opaque);
    if (isPrototypeEntry(property)) prototype = property.initializer;
  }
  return prototype === undefined ? [] : inheritedSource(prototype, key);
}

/** The value an own entry of the selected key writes, or the entry's literal where it writes none. */
function ownSource(
  property: ObjectLiteralElementLike,
  opaque: AssignedFrameSource,
): readonly AssignedFrameSource[] {
  if (isPropertyAssignment(property)) return [{ value: property.initializer, keys: [] }];
  if (isShorthandPropertyAssignment(property) && isIdentifier(property.name))
    return [{ value: property.name, keys: [] }];
  return [opaque];
}

/** Whether an entry sets the literal's prototype: `__proto__: value`, named, not computed or shorthand. */
function isPrototypeEntry(property: Node): property is PropertyAssignment {
  return (
    isPropertyAssignment(property) &&
    !isComputedPropertyName(property.name) &&
    literalKey(property.name) === '__proto__'
  );
}

/** A key read from a literal prototype: a literal selects it, one that is no object holds none. */
function inheritedSource(prototype: Expression, key: string): readonly AssignedFrameSource[] {
  const value = unwrapped(prototype);
  if (isObjectLiteralExpression(value) || isArrayLiteralExpression(value))
    return selectSource({ value, keys: [] }, key);
  return NO_PROTOTYPE.has(value.kind) ? [] : [{ value: prototype, keys: [key] }];
}

/**
 * A missing or possibly undefined selection may take its written fallback, as one source's missing
 * selection does beside other sources' present values.
 */
function defaultSources(
  sources: readonly AssignedFrameSource[],
  fallback: Expression,
  missing: boolean,
): readonly AssignedFrameSource[] {
  const result = sources.filter((source) => !knownUndefined(source));
  if (missing || sources.length === 0 || sources.some((source) => mayBeUndefined(source)))
    result.push({ value: fallback, keys: [] });
  return result;
}

/** A native undefined or void result selects its default rather than the original value. */
function knownUndefined(source: AssignedFrameSource): boolean {
  const value = unwrapped(source.value);
  return (
    source.keys.length === 0 &&
    (isVoidExpression(value) || globalPathOf(value)?.join('.') === 'undefined')
  );
}

/** Literal data and direct constructions are present; other source results remain possible defaults. */
function mayBeUndefined(source: AssignedFrameSource): boolean {
  const value = unwrapped(source.value);
  return (
    source.keys.length > 0 ||
    (!isObjectLiteralExpression(value) &&
      !isArrayLiteralExpression(value) &&
      value.kind !== SyntaxKind.NewExpression &&
      value.kind !== SyntaxKind.NullKeyword &&
      value.kind !== SyntaxKind.TrueKeyword &&
      value.kind !== SyntaxKind.FalseKeyword &&
      constantValue(value) === undefined)
  );
}

/** Literal computed keys only; arbitrary key expressions retain their existing opaque boundary. */
function literalKey(name: PropertyName): string | undefined {
  if (isIdentifier(name)) return name.text;
  const key = isComputedPropertyName(name) ? name.expression : name;
  const value = isExpression(key) ? constantValue(key) : undefined;
  return value === undefined ? undefined : String(value);
}

/** A default inside an enclosing assignment pattern is evaluated by that pattern's selected value. */
export function assignmentPatternDefault(node: Node): boolean {
  let at = node;
  for (;;) {
    const parent = at.parent;
    if (
      isArrayLiteralExpression(parent) ||
      isObjectLiteralExpression(parent) ||
      isSpreadElement(parent) ||
      (isPropertyAssignment(parent) && parent.initializer === at)
    ) {
      at = parent;
      continue;
    }
    return (
      isBinaryExpression(parent) &&
      parent.operatorToken.kind === SyntaxKind.EqualsToken &&
      parent.left === at
    );
  }
}
