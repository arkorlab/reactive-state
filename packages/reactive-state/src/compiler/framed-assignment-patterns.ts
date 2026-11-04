import {
  type Expression,
  type ArrayLiteralExpression,
  type ObjectLiteralExpression,
  type PropertyName,
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

/** A surviving literal own entry, without executing getters or unknown spread sources. */
function objectSource(
  value: ObjectLiteralExpression,
  key: string,
  opaque: AssignedFrameSource,
): readonly AssignedFrameSource[] {
  for (const property of value.properties.toReversed()) {
    if (isSpreadAssignment(property)) return [opaque];
    const name = literalKey(property.name);
    if (name === undefined) return [opaque];
    if (name !== key) continue;
    if (isPropertyAssignment(property)) return [{ value: property.initializer, keys: [] }];
    if (isShorthandPropertyAssignment(property) && isIdentifier(property.name))
      return [{ value: property.name, keys: [] }];
    return [opaque];
  }
  return [];
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
