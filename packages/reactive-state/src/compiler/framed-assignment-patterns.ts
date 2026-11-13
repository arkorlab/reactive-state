import {
  type Expression,
  type ArrayLiteralExpression,
  type GetAccessorDeclaration,
  type ObjectLiteralExpression,
  type PropertyName,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isComputedPropertyName,
  isIdentifier,
  isExpression,
  isForInStatement,
  isForOfStatement,
  isGetAccessorDeclaration,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadElement,
  isSpreadAssignment,
  isVoidExpression,
  type Node,
  type ObjectLiteralElementLike,
  type SpreadAssignment,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameDeclarationOf, frameTypeOf, type FrameDeclaration } from './framed-bindings.ts';
import { accessorWrites } from './framed-getter-writes.ts';
import { localArrayIterationKeys } from './local-type-reading.ts';
import { constantValue } from './numbers.ts';

/** Assignment patterns retain each selected source and its remaining written member path. */

export interface AssignedFrameSource {
  readonly value: Expression;
  readonly keys: readonly string[];
}

interface PatternWork {
  readonly target: Expression;
  readonly sources: readonly AssignedFrameSource[];
}

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

/** Finite required tuple slots remain distinct; opaque iteration retains its existing numeric path. */
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
      pending.push(...assignmentPatternTargets(selected, at.sources));
    }
  }
  return found;
}

/** Defaults, array positions and object entries contribute their selected assignment targets. */
export function assignmentPatternTargets(
  target: Expression,
  sources: readonly AssignedFrameSource[],
): readonly PatternWork[] {
  if (isBinaryExpression(target) && target.operatorToken.kind === SyntaxKind.EqualsToken)
    return [{ target: target.left, sources: defaultSources(sources, target.right) }];
  if (isObjectLiteralExpression(target)) return objectTargets(target.properties, sources);
  if (!isArrayLiteralExpression(target)) return [];
  const targets: PatternWork[] = [];
  for (const [index, element] of target.elements.entries()) {
    if (!isSpreadElement(element) && !isOmittedExpression(element))
      targets.push({ target: element, sources: selectSources(sources, String(index)) });
  }
  return targets;
}

/** Named object entries and their selected defaults; methods and rest copies bind no error identity. */
function objectTargets(
  properties: readonly Node[],
  sources: readonly AssignedFrameSource[],
): readonly PatternWork[] {
  const targets: PatternWork[] = [];
  for (const property of properties) {
    if (!isPropertyAssignment(property) && !isShorthandPropertyAssignment(property)) continue;
    const name = literalKey(property.name);
    if (name === undefined) continue;
    const values = selectSources(sources, name);
    if (isPropertyAssignment(property))
      targets.push({ target: property.initializer, sources: values });
    else if (isIdentifier(property.name))
      targets.push({
        target: property.name,
        sources:
          property.objectAssignmentInitializer === undefined
            ? values
            : defaultSources(values, property.objectAssignmentInitializer),
      });
  }
  return targets;
}

/** Literal entries are selected directly; opaque values retain the path for their declared type. */
function selectSources(
  sources: readonly AssignedFrameSource[],
  key: string,
): readonly AssignedFrameSource[] {
  return sources.flatMap((source) => selectSource(source, key));
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
 * A surviving literal own entry, without executing getters or unknown spread sources. A spread of a
 * written object has the entries that object writes, and is passed over where it has none of the
 * key; what it copies is its own entries, and a prototype it sets is none of them. A key no own
 * entry names comes from the prototype the literal writes.
 */
function objectSource(
  value: ObjectLiteralExpression,
  key: string,
  opaque: AssignedFrameSource,
  own = false,
): readonly AssignedFrameSource[] {
  for (const property of value.properties.toReversed()) {
    const found = isSpreadAssignment(property)
      ? spreadSource(property.expression, key, opaque)
      : fieldSource(property, key, opaque);
    if (found !== undefined && found.length > 0) return found;
  }
  return own ? [] : prototypeSource(value, key, opaque);
}

/**
 * What the prototype a literal writes selects of a key no own entry names: the entry of a written
 * object or list, none for `null`, and the path for any other prototype, which the compile does not
 * read. A written `__proto__: value` is no own entry, and a read of `__proto__` itself gives the
 * prototype it sets, none where that is `null`: no prototype has the accessor to read.
 */
function prototypeSource(
  value: ObjectLiteralExpression,
  key: string,
  opaque: AssignedFrameSource,
): readonly AssignedFrameSource[] {
  const field = value.properties.find((property) => setsPrototype(property));
  if (field === undefined || !isPropertyAssignment(field)) return [];
  const prototype = unwrapped(field.initializer);
  if (prototype.kind === SyntaxKind.NullKeyword) return [];
  if (key === '__proto__') return protoRead(field.initializer, opaque);
  if (isObjectLiteralExpression(prototype)) return objectSource(prototype, key, opaque);
  return isArrayLiteralExpression(prototype) ? arraySource(prototype, key, opaque) : [opaque];
}

/**
 * What a read of `__proto__` gives where no entry of the source has the name: an own field of that
 * name on a prototype of the chain that is written out, else the accessor of Object.prototype, which
 * hands over the first prototype, unless the chain ends in `null` before it. A prototype that is not
 * written out is taken as the accessor gives it.
 */
function protoRead(first: Expression, opaque: AssignedFrameSource): readonly AssignedFrameSource[] {
  let at = first;
  for (;;) {
    const prototype = unwrapped(at);
    if (prototype.kind === SyntaxKind.NullKeyword) return [];
    if (!isObjectLiteralExpression(prototype)) return [{ value: first, keys: [] }];
    const own = objectSource(prototype, '__proto__', opaque, true);
    if (own.length > 0) return own;
    const next = prototype.properties.find((property) => setsPrototype(property));
    if (next === undefined || !isPropertyAssignment(next)) return [{ value: first, keys: [] }];
    at = next.initializer;
  }
}

/** What one field selects: its value for its key, the path for one that is unknown, else none. */
function fieldSource(
  property: Exclude<ObjectLiteralElementLike, SpreadAssignment>,
  key: string,
  opaque: AssignedFrameSource,
): readonly AssignedFrameSource[] | undefined {
  if (setsPrototype(property)) return undefined;
  const name = literalKey(property.name);
  if (name === undefined) return [opaque];
  if (name !== key) return undefined;
  if (isPropertyAssignment(property)) return [{ value: property.initializer, keys: [] }];
  if (isShorthandPropertyAssignment(property) && isIdentifier(property.name))
    return [{ value: property.name, keys: [] }];
  return [opaque];
}

/** What a spread selects: the entry a written object has, none where it has none, else the path. */
function spreadSource(
  copied: Expression,
  key: string,
  opaque: AssignedFrameSource,
): readonly AssignedFrameSource[] {
  const value = unwrapped(copied);
  if (!isObjectLiteralExpression(value)) return [opaque];
  const found = objectSource(value, key, opaque, true);
  return found.length > 0 ? [...found, ...copiedWrites(value, key, opaque)] : found;
}

/**
 * What the getters of a written object write into the entry of a key that it has, before a copy
 * of it reaches the entry: the getters it still holds, those a later field or a later spread of
 * the object replaces having gone, and the setters their writes run. The path for a getter that
 * gives `this` on, which the compile does not read.
 */
function copiedWrites(
  value: ObjectLiteralExpression,
  key: string,
  opaque: AssignedFrameSource,
): readonly AssignedFrameSource[] {
  const replaced = new Set<string>();
  const found: AssignedFrameSource[] = [];
  for (const property of value.properties.toReversed()) {
    if (isSpreadAssignment(property)) {
      for (const each of spreadNames(property.expression)) replaced.add(each);
      continue;
    }
    const name = literalKey(property.name);
    const live = name === undefined || !replaced.has(name);
    if (live && isGetAccessorDeclaration(property))
      found.push(...gettersWrites(value, property, key, opaque));
    if (name !== undefined && !isSetAccessorDeclaration(property)) replaced.add(name);
  }
  return found;
}

/** The names a spread of a written object copies as values, a setter's and those of the spreads it holds included. */
function spreadNames(copied: Expression): readonly string[] {
  const value = unwrapped(copied);
  if (!isObjectLiteralExpression(value)) return [];
  return value.properties.flatMap((each) => {
    if (isSpreadAssignment(each)) return spreadNames(each.expression);
    const name = setsPrototype(each) ? undefined : literalKey(each.name);
    return name === undefined ? [] : [name];
  });
}

/** What running one getter of a written object writes into the entry of a key. */
function gettersWrites(
  value: ObjectLiteralExpression,
  getter: GetAccessorDeclaration,
  key: string,
  opaque: AssignedFrameSource,
): readonly AssignedFrameSource[] {
  const written = accessorWrites(value, getter);
  if (written === undefined) return [opaque];
  return written
    .filter((each) => each.name === undefined || each.name === key)
    .map((each) => ({ value: each.value, keys: [] }));
}

/** A written `__proto__: value`, which sets the prototype; `['__proto__']` and a shorthand do not. */
export function setsPrototype(property: ObjectLiteralElementLike): boolean {
  return (
    isPropertyAssignment(property) &&
    !isComputedPropertyName(property.name) &&
    literalKey(property.name) === '__proto__'
  );
}

/** A missing or possibly undefined selection may take its written fallback. */
function defaultSources(
  sources: readonly AssignedFrameSource[],
  fallback: Expression,
): readonly AssignedFrameSource[] {
  const result = sources.filter((source) => !knownUndefined(source));
  if (sources.length === 0 || sources.some((source) => mayBeUndefined(source)))
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
export function literalKey(name: PropertyName): string | undefined {
  if (isIdentifier(name)) return name.text;
  const key = isComputedPropertyName(name) ? name.expression : name;
  const value = isExpression(key) ? constantValue(key) : undefined;
  return value === undefined ? undefined : String(value);
}

/** The outermost array or object literal a node is written in, through property initializers. */
function patternRoot(node: Node): Node {
  let at = node;
  for (;;) {
    const parent = at.parent;
    const within =
      isArrayLiteralExpression(parent) ||
      isObjectLiteralExpression(parent) ||
      (isPropertyAssignment(parent) && parent.initializer === at);
    if (!within) return at;
    at = parent;
  }
}

/** A default inside an enclosing assignment pattern is evaluated by that pattern's selected value. */
export function assignmentPatternDefault(node: Node): boolean {
  const root = patternRoot(node);
  const parent = root.parent;
  return (
    isBinaryExpression(parent) &&
    parent.operatorToken.kind === SyntaxKind.EqualsToken &&
    parent.left === root
  );
}

/** A default inside a pattern a loop head holds is evaluated by the head's selected value. */
export function loopHeadDefault(node: Node): boolean {
  const root = patternRoot(node);
  const parent = root.parent;
  return (isForOfStatement(parent) || isForInStatement(parent)) && parent.initializer === root;
}
